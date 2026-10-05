import packagedFormat2 from "../../rules/format2.json";
import {
  FEATURE_REGISTRY,
  TIKTOK_ALIAS,
  type BenefitId,
  type SignedRuleSetV2,
} from "@still/shared-types";
import { validateRuleSetV2 } from "./schema.js";

// The packaged format-2 rule set that ships inside every extension build. The JSON is generated
// and dev-signed by scripts/sign-format2.mjs from the authored per-service rule modules; tests and
// `sign-format2 --check` prove the committed bytes are the generated, signed ones. At runtime it is
// admitted like any packaged format-2 bundle (shape validation, no network, no executable data)
// plus a coverage check: it must carry every free launch feature, or the content entry falls back
// to the legacy format-1 seed for that page.

/** The packaged data exactly as committed; unknown until admitted. */
export const PACKAGED_RULE_SET_V2: unknown = packagedFormat2;

/** The free launch features the packaged set must cover: each service's core plus the TikTok alias. */
export const PACKAGED_FREE_FEATURES: readonly BenefitId[] = Object.freeze([
  ...FEATURE_REGISTRY.filter((feature) => feature.tier === "free").map((feature) => feature.id),
  TIKTOK_ALIAS.id,
]);

/**
 * Admit packaged format-2 data, or return null so the caller keeps the legacy seed engine.
 * Null means the data failed the bounded format-2 shape contract, or it lost a free launch
 * feature (a page would silently stop blocking it). The returned value is a fresh snapshot.
 */
export function admitPackagedRuleSetV2(input: unknown): SignedRuleSetV2 | null {
  const admitted = validateRuleSetV2(input);
  if (!admitted.ok) return null;
  const covered = new Set<BenefitId>();
  for (const service of Object.values(admitted.value.services)) {
    for (const surface of service?.surfaces ?? []) covered.add(surface.feature);
  }
  return PACKAGED_FREE_FEATURES.every((feature) => covered.has(feature)) ? admitted.value : null;
}
