import type { ServiceId, SignedRuleSet } from "@still/shared-types";
import { SERVICE_IDS } from "@still/shared-types";
import { ALWAYS_FREE_SURFACE_IDS } from "./engine.js";
import seed from "../../rules/seed.json";

// Service-level tier derivation — the ONE place "which services cost money" is computed. The
// per-surface `tier` tags in the seed are the authored source of truth (the same tags the engine
// gates by and the CSS generator buckets by); the UI's row locks derive from them here instead of
// hand-maintaining a parallel list that could silently disagree the day a service mixes free and
// Pro surfaces.

/** True when the service has at least one free surface (by tag, or by the engine's always-free
 * safety net) — its row stays a live toggle for free users. */
export function serviceHasFreeSurface(ruleSet: SignedRuleSet, id: ServiceId): boolean {
  const service = ruleSet.services[id];
  if (!service) return false; // absent service can't block anything free
  return service.surfaces.some((s) => s.tier === "free" || ALWAYS_FREE_SURFACE_IDS.has(s.id));
}

/** Service ids whose EVERY surface is Pro-gated under the given rule set. An absent service is
 * treated as Pro (conservative: never show a free toggle that blocks nothing). */
export function proServiceIds(ruleSet: SignedRuleSet): ReadonlySet<ServiceId> {
  return new Set(SERVICE_IDS.filter((id) => !serviceHasFreeSurface(ruleSet, id)));
}

/** The bundled-seed derivation the shared UI locks rows by (youtube free; the rest Pro today —
 * but computed, not asserted, so a future mixed-tier service Just Works). */
export const PRO_SERVICE_IDS: ReadonlySet<ServiceId> = proServiceIds(
  seed as unknown as SignedRuleSet,
);
