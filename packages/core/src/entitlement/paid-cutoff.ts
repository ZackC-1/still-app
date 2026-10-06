import { PAID_TIER_ENABLED, type BenefitId } from "@still/shared-types";
import { localProtectionCutoff, type LocalProtectionCutoff } from "./local-protection.js";

/** The paid cutoff (U6) as a future verifier hands it over: the one write-once record of which
 * features were actually released free before the first owner-approved paid activation, with the
 * activation time in milliseconds since the epoch. Plain data; it carries no rights by itself. */
export interface VerifiedPaidCutoff {
  readonly product: string;
  readonly benefits: readonly BenefitId[];
  readonly activatedAt: number;
}

/** Map a verified paid cutoff to the local protection policy, behind the compiled paid switch.
 *
 * Dormant: nothing calls this, and no public route or signed configuration serves a cutoff yet.
 * The caller must pass only a cutoff that a configuration-signing verifier has checked; this adapter
 * adds the compiled gate and the existing `localProtectionCutoff` validation, nothing else.
 *
 * With `PAID_TIER_ENABLED` false (the shipped value) every input returns null, so a verified cutoff
 * changes nothing: no protection grant is written and free behaviour is untouched. Invalid input is
 * also null, never a throw, so a bad cutoff can never take down the entitlement writer. Restore,
 * free blocking and free sync never consult this. */
export function paidCutoffForLocalProtection(verified: VerifiedPaidCutoff | null): LocalProtectionCutoff | null {
  if (!PAID_TIER_ENABLED || !verified || typeof verified !== "object") return null;
  try {
    return localProtectionCutoff({ product: verified.product, benefits: [...verified.benefits] }, verified.activatedAt);
  } catch {
    return null;
  }
}
