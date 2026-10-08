import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import { enforceRateLimit, type RateLimiter, type RateLimitPolicy } from "../_shared/rate-limit.ts";
import { type RevenueCatClient, stillProActive } from "../_shared/revenuecat.ts";
import { type EntitlementStore, jsonResponse } from "../_shared/store.ts";
import { isAccountAccessRemovals, type AccessRightStore, type AccessSigner } from "../_shared/access-issuer.ts";
import type { AppleAccountAccessRefresher } from "../_shared/apple-account-access.ts";
import type { RevenueCatAccessClient } from "../_shared/revenuecat-access.ts";

// Reconcile (verify_jwt=true). The subject UUID is taken ONLY from the verified JWT (auth.uid()),
// NEVER the request body — so a user can reconcile only their own entitlement (KTD5 IDOR defense,
// enforced by the shared withAuthenticatedUser gate). Triggered on every sign-in/restore (all
// hosts) so a dropped webhook self-heals. Each accepted request triggers a RevenueCat subscriber
// lookup, so requests are rate-limited per user and per IP first.

/** Reconcile fires on every sign-in/restore across a user's devices; allow bursts, stop hammering. */
export const RECONCILE_RATE_LIMIT: RateLimitPolicy = { maxPerUser: 10, maxPerIp: 60, windowSeconds: 60 };

export interface ReconcileDeps extends AuthDeps {
  readonly store: EntitlementStore;
  readonly rc: RevenueCatClient;
  readonly limiter: RateLimiter;
  readonly access?: { readonly signer: AccessSigner; readonly rights: AccessRightStore; readonly provider: RevenueCatAccessClient; readonly apple?: AppleAccountAccessRefresher };
}

export function handleReconcile(req: Request, deps: ReconcileDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    const limited = await enforceRateLimit(deps.limiter, "reconcile", userId, req, RECONCILE_RATE_LIMIT);
    if (limited) return limited;
    const request = await accessRequest(req);
    if (request === "invalid") return jsonResponse(400, { error: "invalid_access_request" });
    // Begin before canonical lookup, so a later request/refund/transfer wins delayed completions.
    const access = request === "scoped" ? deps.access : undefined;
    let token: string | null = null;
    if (access) {
      try { token = await access.rights.begin(userId, access.signer.environment); }
      catch { /* Free sync and legacy reconciliation do not depend on scoped storage readiness. */ }
    }
    // The subject is the verified token's sub. Any user_id in the request body is ignored.
    const subscriber = await deps.rc.getSubscriber(userId);
    const active = stillProActive(subscriber);
    await deps.store.setEntitlement(userId, active, "reconcile", subscriber?.original_app_user_id ?? null);

    if (request === "legacy") return jsonResponse(200, { still_sync: active });
    const unavailable = async () => {
      // A failed/stale positive lookup cannot suppress a separately committed refund.
      // This read changes no clock/row and requires this account/environment's current token.
      if (access?.rights.removals && token) {
        try {
          const removals = await access.rights.removals(userId, access.signer.environment, token);
          if (isAccountAccessRemovals(removals, userId, access.signer.environment)) {
            return jsonResponse(200, { still_sync: active, access: { status: "unavailable", environment: access.signer.environment,
              proofs: [], revocations: removals.revocations, issuer_time: removals.issuer_time } });
          }
        } catch { /* No authenticated removal receipt: keep prior rights. */ }
      }
      return jsonResponse(200, { still_sync: active, access: { status: "unavailable" } });
    };
    if (!access || !token) return unavailable();
    try {
      // Sources settle independently. A thrown lookup must not return before a
      // different linked transaction has persisted its cryptographically verified refund.
      const [provider, apple] = await Promise.all([
        access.provider.getRights(userId, access.signer.environment).catch(() => ({ status: "unavailable" as const })),
        access.apple ? access.apple.refresh(userId, access.signer.environment).catch(() => ({ ready: false, rights: [] })) : Promise.resolve(true),
      ]);
      // An RC refresh cannot renew Apple rows. Only the canonical Apple API can advance that clock.
      const appleReady = typeof apple === "boolean" ? apple : apple.ready;
      const freshApple = typeof apple === "boolean" ? [] : apple.rights;
      if (!appleReady && !freshApple.length && provider.status !== "verified") return unavailable();
      const result = await access.rights.commit(userId, access.signer.environment, token, provider.status === "verified" ? provider.rights : []);
      if (result.status === "stale") return unavailable();
      // Validate store scope even though only the narrow RPC is expected to produce it.
      if (result.rights.some(right => right.holder !== userId)) return unavailable();
      // Sign only independently current rows. RC failure/404 must not block an explicit Apple
      // association or reissue unrelated historical RC rows with their old/expired deadline.
      const current = [...(provider.status === "verified" ? result.observed_rights ?? [] : []), ...freshApple].filter(right =>
        right.holder === userId && result.rights.some(stored => stored.right === right.right && stored.holder === userId &&
          stored.revision === right.revision && stored.verified_at === right.verified_at));
      const rightIds = new Set<string>();
      const signable = current.filter(right => { if (rightIds.has(right.right)) return false; rightIds.add(right.right); return true; });
      // Confirmed removals still reach the cache when another provider observation is unknown.
      // This variant NEVER grants, establishes verified-none, or removes unobserved rights.
      if (!signable.length && (!appleReady || provider.status !== "verified" || provider.complete === false || result.rights.length > 0)) {
        if (!isAccountAccessRemovals({ holder: userId, environment: access.signer.environment, revocations: result.revocations,
          issuer_time: result.issuer_time }, userId, access.signer.environment) ||
          !await access.rights.confirm(userId, access.signer.environment, token)) return unavailable();
        return jsonResponse(200, { still_sync: active, access: { status: "unavailable", environment: access.signer.environment,
          proofs: [], revocations: result.revocations, issuer_time: result.issuer_time } });
      }
      const proofs = await Promise.all(signable.map(right => access.signer.sign(right)));
      if (!await access.rights.confirm(userId, access.signer.environment, token)) return unavailable();
      return jsonResponse(200, { still_sync: active, access: {
        status: result.status === "conflict" ? "conflict" : proofs.length ? "verified" : "none",
        environment: access.signer.environment, proofs, revocations: result.revocations, issuer_time: result.issuer_time,
      } });
    } catch { return unavailable(); }
  });
}

/** Completed legacy bodies remain ignored. Incomplete/errored input never falls through. */
async function accessRequest(req: Request): Promise<"legacy" | "scoped" | "invalid"> {
  const reader = req.body?.getReader();
  if (!reader) return "legacy";
  const chunks: Uint8Array[] = [];
  let bytes = 0, timedOut = false;
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<{ done: true; value: undefined }>(resolve => {
    bodyTimer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); resolve({ done: true, value: undefined }); }, 2_000);
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), stalled]);
      if (timedOut) return "invalid";
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) { void reader.cancel().catch(() => {}); return "invalid"; }
      chunks.push(chunk.value);
    }
    const complete = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { complete.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(complete);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return "legacy"; }
    if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "access_schema")) return "legacy";
    return (body as { access_schema: unknown }).access_schema === 1 && Object.keys(body).length === 1 ? "scoped" : "invalid";
  } catch { return "invalid"; }
  finally { clearTimeout(bodyTimer); reader.releaseLock(); }
}
