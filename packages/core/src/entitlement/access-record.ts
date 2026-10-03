import { type LocalProtectionRecord, type PaidAccessClock } from "@still/shared-types";
import { accessProofMatchesHolder, observePaidClock, installPaidClock, type AccessObservation, type ScopedAccessEvidence } from "./access-policy.js";
import { isAccessUUID, isPaidAccess, isSafeAccessInteger, isVerifiedAccessProof, verifyAccessProof, type AccessTrust, type VerifiedAccessProof } from "./access-proof.js";

export interface CachedAccessRight {
  readonly envelope: string;
  readonly clock: PaidAccessClock | null;
  readonly accountGeneration?: number | null;
}
export interface AccessCacheRecord {
  readonly schema: 1;
  readonly accountId: string | null;
  readonly generation: number;
  readonly sessionId?: string | null;
  readonly rights: readonly CachedAccessRight[];
  readonly localProtection?: LocalProtectionRecord | null;
  readonly revocations: readonly { readonly right: string; readonly revision: number }[];
}
export const EMPTY_ACCESS_RECORD: AccessCacheRecord = { schema: 1, accountId: null, generation: 0, rights: [], revocations: [] };

export function parseAccessCacheRecord(value: unknown): AccessCacheRecord {
  if (value === undefined || value === null) return { ...EMPTY_ACCESS_RECORD };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unreadable access record");
  const c = value as Record<string, unknown>;
  if (c.schema !== 1 || !(c.accountId === null || isAccessUUID(c.accountId)) || !isSafeAccessInteger(c.generation) ||
      !Array.isArray(c.rights) || c.rights.length > 32 || !Array.isArray(c.revocations) || c.revocations.length > 64 ||
      !c.rights.every(r => r && typeof r === "object" && typeof r.envelope === "string" && r.envelope.length <= 6144 && (r.clock === null || typeof r.clock === "object") && (r.accountGeneration === undefined || r.accountGeneration === null || isSafeAccessInteger(r.accountGeneration))) ||
      !c.revocations.every(r => r && typeof r === "object" && isAccessUUID(r.right) && isSafeAccessInteger(r.revision))) throw new Error("Unreadable access record");
  if (c.sessionId !== undefined && c.sessionId !== null && !isAccessUUID(c.sessionId)) throw new Error("Unreadable access session");
  // Optional malformed protection is isolated by the resolver, retained verbatim, and never
  // interpreted as fresh absence. It must not erase independently valid signed rights.
  return c as unknown as AccessCacheRecord;
}

export type AccessMutation =
  | { readonly kind: "observe"; readonly observation: AccessObservation }
  | { readonly kind: "account"; readonly accountId: string | null }
  | { readonly kind: "session"; readonly session: { readonly userId: string; readonly sessionId: string } | null }
  | { readonly kind: "install"; readonly proof: VerifiedAccessProof; readonly generation: number; readonly issuerNow: number; readonly wall: number; readonly localRights: ReadonlySet<string> }
  | { readonly kind: "revoke"; readonly right: string; readonly revision: number; readonly generation: number };

/** Must execute within the existing durable entitlement writer's transaction. Consumers receive
 * evidence only after this entire result has committed. No caller creates trusted online proof. */
export async function mutateAccessRecord(current: AccessCacheRecord, mutation: AccessMutation, trust: AccessTrust): Promise<{ readonly record: AccessCacheRecord; readonly evidence: readonly ScopedAccessEvidence[] }> {
  if (mutation.kind === "session" && current.accountId === (mutation.session?.userId ?? null) && current.sessionId === (mutation.session?.sessionId ?? null)) {
    if (mutation.session && (!isAccessUUID(mutation.session.userId) || !isAccessUUID(mutation.session.sessionId))) throw new Error("Invalid access session");
    return { record: current, evidence: [] };
  }
  const decoded: { cached: CachedAccessRight; proof: VerifiedAccessProof }[] = [];
  const unresolved: CachedAccessRight[] = [];
  for (const cached of current.rights) {
    const result = await verifyAccessProof(cached.envelope, trust);
    if (result.status !== "verified") unresolved.push(cached);
    else decoded.push({ cached, proof: result.proof });
  }
  let record = current;
  if (mutation.kind === "account" || mutation.kind === "session") {
    const accountId = mutation.kind === "account" ? mutation.accountId : mutation.session?.userId ?? null;
    const sessionId = mutation.kind === "session" ? mutation.session?.sessionId ?? null : null;
    if (sessionId !== null && !isAccessUUID(sessionId)) throw new Error("Invalid access session");
    if (!(accountId === null || isAccessUUID(accountId)) || current.generation >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid access scope");
    // Even A -> A is a new session lifecycle; account IDs alone cannot fence delayed work.
    record = { ...current, accountId, sessionId, generation: current.generation + 1,
      rights: [...unresolved, ...decoded.filter(r => r.proof.claims.kind === "paid_apple_local" || r.proof.claims.kind === "protected_local").map(r => r.cached)] };
  } else if (mutation.kind === "install") {
    const p = mutation.proof;
    if (!isVerifiedAccessProof(p) || mutation.generation !== current.generation || !accessProofMatchesHolder(p, { accountId: current.accountId, localRights: mutation.localRights })) throw new Error("Stale access scope");
    // Recheck under this writer's actual trust bundle (not another caller's allowlist).
    const result = await verifyAccessProof(JSON.stringify(p.envelope), trust);
    if (result.status !== "verified") throw new Error("Untrusted access proof");
    const prior = decoded.find(r => r.proof.claims.right === p.claims.right);
    if (prior && (prior.proof.claims.ownership_revision > p.claims.ownership_revision ||
        prior.proof.claims.verified_at > p.claims.verified_at)) throw new Error("Stale access proof");
    if (current.revocations.some(r => r.right === p.claims.right && r.revision >= p.claims.ownership_revision)) throw new Error("Known revoked access");
    // Re-read, retry, import, or cached SDK fetch never restamps the same proof's baseline.
    if (!prior || prior.proof.identity !== p.identity) {
      if (prior && prior.proof.claims.verified_at >= p.claims.verified_at) throw new Error("Validation did not advance");
      const account = p.claims.kind === "paid_account" || p.claims.kind === "protected_account";
      const replacement = { envelope: JSON.stringify(p.envelope), clock: isPaidAccess(p.claims) ? installPaidClock(p, mutation.issuerNow, mutation.wall) : null, accountGeneration: account ? current.generation : null };
      const rights = [...unresolved, ...decoded.filter(r => r.proof.claims.right !== p.claims.right).map(r => r.cached)];
      if (rights.length >= 32) throw new Error("Access record full");
      record = { ...record, rights: [...rights, replacement] };
    }
  } else if (mutation.kind === "revoke") {
    if (mutation.generation !== current.generation || !isAccessUUID(mutation.right) || !isSafeAccessInteger(mutation.revision)) throw new Error("Invalid revocation scope");
    const old = current.revocations.find(r => r.right === mutation.right);
    const revocations = current.revocations.filter(r => r.right !== mutation.right);
    if (!old && revocations.length >= 64) throw new Error("Revocation record full");
    record = { ...record, revocations: [...revocations, { right: mutation.right, revision: Math.max(old?.revision ?? 0, mutation.revision) }] };
  }
  const evidence: ScopedAccessEvidence[] = [];
  const rights: CachedAccessRight[] = [];
  for (const cached of record.rights) {
    const retained = decoded.find(item => item.cached.envelope === cached.envelope)?.proof;
    const result = retained ? { status: "verified" as const, proof: retained } : await verifyAccessProof(cached.envelope, trust);
    if (result.status !== "verified") { rights.push(cached); continue; }
    const p = result.proof;
    const account = p.claims.kind === "paid_account" || p.claims.kind === "protected_account";
    const revoked = (account && cached.accountGeneration !== record.generation) || record.revocations.some(r => r.right === p.claims.right && r.revision >= p.claims.ownership_revision);
    const observation = mutation.kind === "observe" && isPaidAccess(p.claims) ? observePaidClock(p, cached.clock, mutation.observation) : null;
    const clock = observation?.clock ?? cached.clock;
    rights.push({ ...cached, clock: clock && revoked ? { ...clock, revoked: true } : clock });
    evidence.push({ proof: p, revoked, paidState: observation?.state ?? "verification_required" });
  }
  return { record: { ...record, rights }, evidence };
}
