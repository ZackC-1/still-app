import { PAID_ACCESS_WINDOW_MS } from "@still/shared-types";
import type { AuthDeps } from "./auth.ts";
import { withAuthenticatedUser } from "./auth.ts";
import { verifyJwt } from "./jwt.ts";
import { isUuid } from "./types.ts";
import { clientIp, limiterAddress, tooManyRequests, type RateLimiter } from "./rate-limit.ts";
import { jsonResponse, optionsResponse } from "./store.ts";
import { isAppleEvidence, type AppleAccessVerifier, type AppleEvidence } from "./apple-access.ts";
import type { AppleAccessStore, AppleAccessLink } from "./apple-access-store.ts";
import type { AccessSigner } from "./access-issuer.ts";

export interface ConfirmedAppleAccountPort { confirmed(token: string, holder: string): Promise<boolean>; }
export interface AppleFulfillmentDeps extends AuthDeps {
  readonly limiter: RateLimiter;
  readonly accounts?: ConfirmedAppleAccountPort;
  readonly access?: { readonly verifier: AppleAccessVerifier; readonly store: AppleAccessStore; readonly signer: AccessSigner };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safe = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const unavailable = () => jsonResponse(200, { status: "unavailable" });
const invalid = () => jsonResponse(400, { error: "invalid_apple_access_request" });

/** Bound actual bytes, including chunked bodies. Never log receipts or authority tokens. */
async function readBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let length = 0;
  let bodyTimer: ReturnType<typeof setTimeout> | undefined; let timedOut = false;
  const stalled = new Promise<{ readonly done: true; readonly value: undefined }>(resolve => {
    bodyTimer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); resolve({ done: true, value: undefined }); }, 2_000);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), stalled]); if (chunk.done) break;
      length += chunk.value.length;
      if (length > 36_000) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(chunk.value);
    }
    if (timedOut) return null;
    const bytes = new Uint8Array(length); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return null; } finally { clearTimeout(bodyTimer); reader.releaseLock(); }
}
async function deadline<T>(action: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([action, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 35_000); })]); }
  finally { clearTimeout(timer); }
}
async function limited(req: Request, deps: AppleFulfillmentDeps, holder?: string): Promise<Response | null> {
  const ip = clientIp(req);
  // This accountless expensive route cannot silently waive the limit on an unknown peer.
  if (!ip) return unavailable();
  const wait = await deps.limiter.consume(`apple-access:ip:${limiterAddress(ip)}`, 30, 60);
  if (wait > 0) return tooManyRequests(wait);
  if (holder) {
    const userWait = await deps.limiter.consume(`apple-access:user:${holder}`, 10, 60);
    if (userWait > 0) return tooManyRequests(userWait);
  }
  return null;
}
async function confirmed(reqToken: string, holder: string, deps: AppleFulfillmentDeps): Promise<number | null> {
  const claims = await verifyJwt(reqToken, { hs256Secret: deps.jwtSecret, jwksUrl: deps.jwksUrl, expected: deps.expected });
  if (!(claims && claims.sub === holder && typeof claims.exp === "number" && Number.isFinite(claims.exp) &&
    claims.exp * 1000 > Date.now() && claims.role === "authenticated" &&
    claims.aud === "authenticated" && claims.is_anonymous !== true &&
    deps.accounts)) return null;
  const expiresAt = claims.exp * 1000;
  return await deps.accounts.confirmed(reqToken, holder) && expiresAt > Date.now() ? expiresAt : null;
}

async function fulfill(evidence: AppleEvidence, deps: AppleFulfillmentDeps, link?: AppleAccessLink, authorize?: () => Promise<boolean>, currentAuthority?: () => boolean): Promise<Response> {
  const access = deps.access;
  if (!access || !access.signer.signAppleBinding) return unavailable();
  const tx = await deadline(access.verifier.authenticate(evidence));
  if (!tx || tx.environment !== access.signer.environment) return unavailable();
  if (link && tx.localOnly) return unavailable();
  const token = await access.store.begin(tx);
  const current = await deadline(access.verifier.refresh(tx));
  if (!current || current.key !== tx.key || current.environment !== tx.environment ||
    current.bundleId !== tx.bundleId || current.productId !== tx.productId ||
    current.originalTransactionId !== tx.originalTransactionId || current.transactionId !== tx.transactionId ||
    current.localOnly !== tx.localOnly || (link && current.localOnly)) return unavailable();
  // Canonical negative evidence removes access even when a link can no longer be authorized.
  // It must never carry the failed link intent or produce either proof.
  if (!current.active) {
    await access.store.commit(current, token);
    return unavailable();
  }
  // Token expiry, bans/deletion and account confirmation are rechecked after provider latency.
  if (authorize && !await authorize() || currentAuthority?.() === false) return unavailable();
  const result = await access.store.commit(current, token, link);
  if (result.status === "owned_elsewhere" || result.status === "stale") return jsonResponse(200, { status: result.status });
  if (!("right" in result)) return unavailable();
  const right = result.right;
  if (right.holder !== (link?.holder ?? right.right) || result.issuer_time !== right.verified_at ||
    (link && result.status === "verified") || (!link && result.status !== "verified")) return unavailable();
  const local = { ...right, holder: right.right };
  const localProof = await access.signer.sign(local, "paid_apple_local");
  const nativeBinding = await access.signer.signAppleBinding({ schema: 1, environment: tx.environment,
    appBundleId: tx.bundleId, productId: tx.productId, originalTransactionId: tx.originalTransactionId,
    right: right.right, ownershipRevision: right.revision, verifiedAt: right.verified_at,
    expiresAt: right.verified_at + PAID_ACCESS_WINDOW_MS });
  const accountProof = link ? await access.signer.sign(right) : null;
  // Signing is async: live account authority may disappear before the final SQL fence.
  if (authorize && !await authorize() || !await access.store.confirm(current, token, right) || currentAuthority?.() === false) return jsonResponse(200, { status: "stale" });
  if (link) return jsonResponse(200, { status: result.status, ownershipRevision: right.revision,
    issuerTime: result.issuer_time, localProof, accountProof, nativeBinding });
  return jsonResponse(200, { schema: 1, status: "verified", proofs: [localProof],
    issuerTime: result.issuer_time, localRight: right.right, nativeBinding });
}

export async function handleVerifyAppleAccess(req: Request, deps: AppleFulfillmentDeps): Promise<Response> {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
  try {
    const limit = await limited(req, deps); if (limit) return limit;
    const body = await readBody(req);
    if (!object(body) || Object.keys(body).sort().join(",") !== "schema,transaction" ||
      body.schema !== 1 || !isAppleEvidence(body.transaction)) return invalid();
    return await fulfill(body.transaction, deps);
  } catch { return unavailable(); }
}

/** Deliberate first association. Free sign-in never calls this route. Transfer additionally
 * requires fresh project-authenticated source authority; client owner strings prove nothing. */
export function handleLinkAppleAccess(req: Request, deps: AppleFulfillmentDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async holder => {
    const limit = await limited(req, deps, holder); if (limit) return limit;
    const body = await readBody(req);
    const keys = object(body) ? Object.keys(body).sort().join(",") : "";
    const first = "evidence,expectedOwnershipRevision,intendedAccountId,operationId";
    const transfer = "evidence,expectedOwnershipRevision,intendedAccountId,operationId,sourceAccountId,sourceAuthority";
    if (!object(body) || (keys !== first && keys !== transfer) || body.intendedAccountId !== holder ||
      (typeof body.operationId !== "string" || !isUuid(body.operationId)) || !safe(body.expectedOwnershipRevision) || body.expectedOwnershipRevision >= Number.MAX_SAFE_INTEGER ||
      !isAppleEvidence(body.evidence)) return invalid();
    const bearer = req.headers.get("Authorization")!.slice(7);
    const expiresAt = await confirmed(bearer, holder, deps);
    if (!expiresAt) return jsonResponse(403, { error: "confirmed_account_required" });
    const link: AppleAccessLink = { holder, operation: body.operationId, expectedRevision: body.expectedOwnershipRevision };
    if (keys === transfer) {
      if ((typeof body.sourceAccountId !== "string" || !isUuid(body.sourceAccountId)) || body.sourceAccountId === holder || typeof body.sourceAuthority !== "string" ||
        body.sourceAuthority.length > 8_000) {
        return jsonResponse(403, { error: "source_authority_required" });
      }
      const source = body.sourceAccountId, sourceToken = body.sourceAuthority;
      const sourceExpiresAt = await confirmed(sourceToken, source, deps);
      if (!sourceExpiresAt) return jsonResponse(403, { error: "source_authority_required" });
      const currentAuthority = () => expiresAt > Date.now() && sourceExpiresAt > Date.now();
      return await fulfill(body.evidence, deps, { ...link, sourceHolder: source },
        async () => !!await confirmed(bearer, holder, deps) && !!await confirmed(sourceToken, source, deps) && currentAuthority(), currentAuthority);
    }
    return await fulfill(body.evidence, deps, link, async () => !!await confirmed(bearer, holder, deps), () => expiresAt > Date.now());
  });
}

/** Live project Auth read: bans/deletion/anonymous or unconfirmed accounts cannot link rights. */
export class HttpConfirmedAppleAccounts implements ConfirmedAppleAccountPort {
  constructor(private readonly supabaseUrl: string, private readonly publicApiKey: string) {}
  async confirmed(token: string, holder: string): Promise<boolean> {
    if (!this.publicApiKey || !/^https?:\/\//.test(this.supabaseUrl)) return false;
    try {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: this.publicApiKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000), redirect: "error",
      });
      if (!response.ok) return false;
      const user: unknown = await response.json();
      return object(user) && user.id === holder && user.is_anonymous !== true &&
        typeof user.email_confirmed_at === "string" && Number.isFinite(Date.parse(user.email_confirmed_at));
    } catch { return false; }
  }
}
