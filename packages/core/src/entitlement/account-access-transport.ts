import { isAccessUUID, isSafeAccessInteger, verifyAccessProof, type AccessTrust, type VerifiedAccessProof } from "./access-proof.js";

export type AccountAccessResult = {
  readonly status: "verified" | "none" | "conflict";
  readonly proofs: readonly VerifiedAccessProof[];
  readonly revocations: readonly { readonly right: string; readonly revision: number }[];
  readonly issuerTime: number;
} | { readonly status: "unavailable" }
  | { readonly status: "unavailable"; readonly proofs: readonly []; readonly revocations: readonly { readonly right: string; readonly revision: number }[]; readonly issuerTime: number };

/** Consume only the authenticated reconciliation transport, never checkout query parameters or
 * the retained broad Boolean. Persistence/session fences remain the existing writer's job. */
export async function verifyAccountAccessResponse(value: unknown, accountId: string, trust: AccessTrust): Promise<AccountAccessResult> {
  const unavailable = { status: "unavailable" } as const;
  if (!isAccessUUID(accountId) || !value || typeof value !== "object" || Array.isArray(value)) return unavailable;
  const access = (value as { access?: unknown }).access;
  if (!access || typeof access !== "object" || Array.isArray(access)) return unavailable;
  const a = access as Record<string, unknown>;
  if (Object.keys(a).length !== 5 || !["status", "environment", "proofs", "revocations", "issuer_time"].every(key => Object.hasOwn(a, key)) ||
      !["verified", "none", "conflict", "unavailable"].includes(a.status as string) || a.environment !== trust.environment ||
      !isSafeAccessInteger(a.issuer_time) || !Array.isArray(a.proofs) || a.proofs.length > 16 ||
      !Array.isArray(a.revocations) || a.revocations.length > 64) return unavailable;
  const removalsOnly = a.status === "unavailable";
  if (removalsOnly && (a.proofs.length !== 0 || a.revocations.length === 0)) return unavailable;
  const proofs: VerifiedAccessProof[] = [];
  for (const text of a.proofs) {
    if (typeof text !== "string") return unavailable;
    const result = await verifyAccessProof(text, trust);
    if (result.status !== "verified" || result.proof.claims.kind !== "paid_account" ||
        result.proof.claims.holder !== accountId || result.proof.claims.verified_at > a.issuer_time ||
        !isSafeAccessInteger(result.proof.claims.expires_at) || result.proof.claims.expires_at <= a.issuer_time ||
        proofs.some(proof => proof.claims.right === result.proof.claims.right)) return unavailable;
    proofs.push(result.proof);
  }
  if ((a.status === "verified" && proofs.length === 0) || (a.status === "none" && proofs.length !== 0)) return unavailable;
  const revocations: { right: string; revision: number }[] = [];
  for (const value of a.revocations) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable;
    const r = value as Record<string, unknown>;
    if (Object.keys(r).length !== 2 || !isAccessUUID(r.right) || !isSafeAccessInteger(r.revision) ||
        revocations.some(revocation => revocation.right === r.right) ||
        proofs.some(proof => proof.claims.right === r.right && proof.claims.ownership_revision <= (r.revision as number))) return unavailable;
    revocations.push({ right: r.right, revision: r.revision });
  }
  if (removalsOnly) return { status: "unavailable", proofs: [] as const,
    revocations: Object.freeze(revocations), issuerTime: a.issuer_time };
  return { status: a.status as "verified" | "none" | "conflict", proofs: Object.freeze(proofs),
    revocations: Object.freeze(revocations), issuerTime: a.issuer_time };
}

/** Invoke adapter kept independent of Supabase SDK/UI. A caller must capture current account
 * generation before invoking and commit the result only through the existing fenced writer. */
export async function reconcileAccountAccess(
  invoke: (name: string, options: { body: { access_schema: 1 } }) => Promise<{ data: unknown; error: unknown }>,
  accountId: string, trust: AccessTrust,
): Promise<AccountAccessResult> {
  try {
    const result = await invoke("reconcile-entitlement", { body: { access_schema: 1 } });
    return result.error ? { status: "unavailable" } : await verifyAccountAccessResponse(result.data, accountId, trust);
  } catch { return { status: "unavailable" }; }
}

export interface AccountAccessReconcilerDeps {
  readonly readSession: () => Promise<{ userId: string; sessionId: string } | null | undefined>;
  readonly epoch: () => number;
  readonly authEpoch?: () => number;
  readonly invalidateEvidence?: () => void;
  readonly trust: AccessTrust;
  readonly invoke: Parameters<typeof reconcileAccountAccess>[0];
  readonly now?: () => number;
  readonly authRequired?: (error: unknown) => boolean;
  readonly commit: (session: { userId: string; sessionId: string }, result: AccountAccessResult,
    isCurrent: () => boolean, isAuthCurrent: () => boolean) => Promise<"committed" | "stale" | "unavailable">;
}
/** Auth/SDK work runs before the writer. Every asynchronous step is fenced by the host's auth
 * callback epoch, including same-subject sign-out/sign-in and token refresh during verification. */
export function createAccountAccessReconciler(deps: AccountAccessReconcilerDeps) {
  let requestGeneration = 0;
  let last: { epoch: number; status: "verified" | "none" | "conflict"; hasProofs: boolean; session: { userId: string; sessionId: string }; observedWall: number } | null = null;
  return {
    async reconcile(): Promise<"ok" | "auth-required" | "unavailable"> {
      const epoch = deps.epoch();
      const authEpoch = deps.authEpoch ?? deps.epoch;
      const authBoundary = authEpoch();
      const request = ++requestGeneration;
      last = null;
      const current = () => deps.epoch() === epoch && requestGeneration === request;
      try {
        const session = await deps.readSession();
        if (!session || !current()) return "unavailable";
        let unauthorized = false;
        const result = await reconcileAccountAccess(async (name, options) => {
          const response = await deps.invoke(name, options);
          unauthorized = deps.authRequired?.(response.error) === true;
          return response;
        }, session.userId, deps.trust);
        if (unauthorized && current()) return "auth-required";
        if (!("revocations" in result) || !current()) return "unavailable";
        const committed = await deps.commit(session, result, current, () => authEpoch() === authBoundary);
        if (committed !== "committed" || !current()) return "unavailable";
        if (result.status === "unavailable") return "unavailable";
        last = { epoch, status: result.status, hasProofs: result.proofs.length > 0, session, observedWall: deps.now?.() ?? Date.now() };
        deps.invalidateEvidence?.();
        return "ok";
      } catch { return "unavailable"; }
    },
    evidenceStatus(session: { userId: string; sessionId: string } | null | undefined): "absent" | "unknown" {
      const wall = deps.now?.() ?? Date.now();
      return last && session && last.epoch === deps.epoch() && last.status === "none" &&
        last.session.userId === session.userId && last.session.sessionId === session.sessionId &&
        wall >= last.observedWall && wall - last.observedWall < 60_000 ? "absent" : "unknown";
    },
    read(): "entitled" | "not-entitled" | "unknown" {
      return !last || last.epoch !== deps.epoch() ? "unknown"
        : last.hasProofs ? "entitled" : "not-entitled";
    },
    evidenceDeadline(): number | null {
      const wall = deps.now?.() ?? Date.now();
      return last && last.epoch === deps.epoch() && last.status === "none" && wall >= last.observedWall &&
        wall < last.observedWall + 60_000 ? last.observedWall + 60_000 : null;
    },
  };
}
