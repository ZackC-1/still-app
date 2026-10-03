import { parseLocalProtection } from "./local-protection.js";
import { PAID_ACCESS_WINDOW_MS, type AccessState, type LocalProtectionRecord, type BenefitId, type PaidAccessClock } from "@still/shared-types";
import { isPaidAccess, isSafeAccessInteger, isVerifiedAccessProof, type VerifiedAccessProof } from "./access-proof.js";

export interface AccessObservation {
  readonly wall: number;
  /** A lower bound from the current runtime only, derived by the host from its own origin.
   * It is never persisted or accepted from a previous runtime/message. */
  readonly runningEstimate?: number;
}

export function validPaidClock(clock: PaidAccessClock, proof: VerifiedAccessProof): boolean {
  return clock.proofIdentity === proof.identity && clock.verifiedAt === proof.claims.verified_at &&
    clock.expiresAt === proof.claims.expires_at && clock.expiresAt - clock.verifiedAt === PAID_ACCESS_WINDOW_MS &&
    [clock.verifiedAt, clock.expiresAt, clock.issuerTimeAtReceipt, clock.wallAtReceipt, clock.highWater, clock.lastWall].every(isSafeAccessInteger) &&
    clock.issuerTimeAtReceipt >= clock.verifiedAt && clock.highWater >= clock.issuerTimeAtReceipt &&
    clock.lastWall >= clock.wallAtReceipt && typeof clock.expired === "boolean" && typeof clock.revoked === "boolean" && typeof clock.paused === "boolean";
}

/** Only a genuinely new authoritative online validation may create this baseline. */
export function installPaidClock(proof: VerifiedAccessProof, issuerNow: number, wall: number): PaidAccessClock {
  if (!isVerifiedAccessProof(proof) || !isPaidAccess(proof.claims) || !isSafeAccessInteger(issuerNow) || !isSafeAccessInteger(wall) ||
      issuerNow < proof.claims.verified_at || !isSafeAccessInteger(proof.claims.expires_at)) throw new Error("Invalid access baseline");
  return { proofIdentity: proof.identity, verifiedAt: proof.claims.verified_at, expiresAt: proof.claims.expires_at,
    issuerTimeAtReceipt: issuerNow, wallAtReceipt: wall, highWater: issuerNow, lastWall: wall,
    expired: issuerNow >= proof.claims.expires_at, revoked: false, paused: false };
}

export function observePaidClock(proof: VerifiedAccessProof, clock: PaidAccessClock | null,
  observation: AccessObservation): { readonly state: "valid" | "verification_required"; readonly clock: PaidAccessClock | null } {
  if (!isVerifiedAccessProof(proof) || !clock || !validPaidClock(clock, proof)) return { state: "verification_required", clock };
  if (clock.expired || clock.revoked || clock.paused) return { state: "verification_required", clock };
  if (!isSafeAccessInteger(observation.wall) || observation.wall < clock.lastWall ||
      (observation.runningEstimate !== undefined && !isSafeAccessInteger(observation.runningEstimate))) return { state: "verification_required", clock: { ...clock, paused: true } };
  const wallEstimate = clock.issuerTimeAtReceipt + observation.wall - clock.wallAtReceipt;
  const effective = Math.max(clock.highWater, wallEstimate, observation.runningEstimate ?? 0);
  if (!isSafeAccessInteger(effective) || effective < proof.claims.verified_at) return { state: "verification_required", clock: { ...clock, paused: true } };
  const next = { ...clock, highWater: effective, lastWall: observation.wall, expired: effective >= clock.expiresAt };
  return { state: next.expired ? "verification_required" : "valid", clock: next };
}

export interface ScopedAccessEvidence {
  readonly proof: VerifiedAccessProof;
  readonly paidState: "valid" | "verification_required";
  readonly revoked: boolean;
}
export interface AccessResolutionContext {
  readonly paidMode: boolean;
  readonly supported: boolean;
  readonly free: boolean;
  readonly accountId: string | null;
  /** Native verified transaction/protection mapping, not copied proof holders or a device ID. */
  readonly localRights: ReadonlySet<string>;
  readonly localProtection?: LocalProtectionRecord | null;
  readonly evidenceStatus: "checking" | "unknown" | "absent";
}

export function accessProofMatchesHolder(proof: VerifiedAccessProof, context: Pick<AccessResolutionContext, "accountId" | "localRights">): boolean {
  if (!isVerifiedAccessProof(proof)) return false;
  const c = proof.claims;
  return c.kind === "paid_account" || c.kind === "protected_account"
    ? context.accountId !== null && c.holder === context.accountId
    : c.holder === c.right && context.localRights.has(c.right);
}

/** Pure access only. This function never changes saved intent, native preferences or analytics. */
export function resolveBenefitAccess(benefit: BenefitId, evidence: readonly ScopedAccessEvidence[], context: AccessResolutionContext): AccessState {
  if (!context.supported) return "unsupported";
  if (!context.paidMode || context.free) return "free";
  let unresolved = false;
  let protectedRight = false;
  for (const item of evidence) {
    if (!accessProofMatchesHolder(item.proof, context) || item.revoked || !item.proof.claims.benefits.includes(benefit)) continue;
    if (isPaidAccess(item.proof.claims)) {
      if (item.paidState === "valid") return "purchased";
      unresolved = true;
    } else protectedRight = true;
  }
  let local: LocalProtectionRecord | null = null;
  try { local = parseLocalProtection(context.localProtection); } catch { unresolved = true; }
  if (protectedRight || local?.grant?.benefits.includes(benefit)) return "protected";
  if (local && !local.grant) unresolved = true;
  if (unresolved || context.evidenceStatus === "unknown") return "verification_required";
  return context.evidenceStatus === "checking" ? "checking" : "locked";
}
