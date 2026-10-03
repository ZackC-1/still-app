import type { FeatureId } from "./feature-registry.js";

export type BenefitId = FeatureId | "tiktok.all";
export type AccessState = "free" | "purchased" | "protected" | "checking" | "verification_required" | "locked" | "unsupported";
export type AccessEnvironment = "production" | "sandbox";
export type AccessKind = "paid_account" | "paid_apple_local" | "protected_local" | "protected_account";
export type AccessProvenance = "provider_verified" | "owner_attested_legacy_paid" | "legacy_free_verified" | "free_self_declaration";
export const PAID_ACCESS_WINDOW_MS = 2_592_000_000;

// A purchased package freezes at release. Do not derive this from future registry tiers.
export const STILL_PRO_V3_BENEFITS: readonly BenefitId[] = Object.freeze([
  "facebook.sponsored", "facebook.stories", "facebook.videos",
  "instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads",
  "youtube.autoplay", "youtube.comments", "youtube.endscreen", "youtube.livechat", "youtube.related",
]);

/** Supplied by packaged/verified functional policy, never by a proof/request being verified.
 * CP109's actual production snapshot is not configured by this source foundation. */
export interface ProtectedBenefitSnapshot {
  readonly product: string;
  readonly benefits: readonly BenefitId[];
}

export interface AccessClaims {
  readonly schema: 1;
  readonly issuer: "still-access";
  readonly environment: AccessEnvironment;
  readonly audience: "still-app";
  readonly kind: AccessKind;
  readonly provenance: AccessProvenance;
  readonly right: string;
  readonly holder: string;
  readonly product: string;
  readonly benefits: readonly BenefitId[];
  readonly ownership_revision: number;
  readonly verified_at: number;
  readonly expires_at?: number;
}

export interface AccessEnvelope {
  readonly payload: string;
  readonly kid: string;
  readonly alg: "ed25519";
  readonly signature: string;
}

export interface PaidAccessClock {
  readonly proofIdentity: string;
  readonly verifiedAt: number;
  readonly expiresAt: number;
  readonly issuerTimeAtReceipt: number;
  readonly wallAtReceipt: number;
  readonly highWater: number;
  readonly lastWall: number;
  readonly expired: boolean;
  readonly revoked: boolean;
  readonly paused: boolean;
}

/** Honest unsigned, nonexclusive local free protection. Never a paid/signed proof or account
 * association. A null grant preserves eligibility while CP109's actual cutoff is unavailable. */
export interface LocalProtectionRecord {
  readonly schema: 1;
  readonly provenance: "accepted_legacy_local" | "free_self_declaration";
  readonly original: { readonly firstRecordedAt: number; readonly firstRecordedAppVersion: string } | null;
  readonly grant: (ProtectedBenefitSnapshot & { readonly activatedAt: number }) | null;
}
