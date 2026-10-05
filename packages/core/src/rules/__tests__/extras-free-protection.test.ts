import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FEATURE_REGISTRY, type ServiceId, type ServiceRulesV2 } from "@still/shared-types";
import { PACKAGED_FREE_FEATURES, PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../packaged.js";
import { validateRuleSetV2 } from "../schema.js";
import { YOUTUBE_SHORTS_RULES } from "../youtube.js";
import { INSTAGRAM_REELS_RULES } from "../instagram.js";
import { FACEBOOK_REELS_RULES } from "../facebook.js";
import { YOUTUBE_EXTRAS } from "../youtube-extras.js";
import { INSTAGRAM_EXTRAS } from "../instagram-extras.js";
import { FACEBOOK_EXTRAS } from "../facebook-extras.js";
import type { ServiceExtras } from "../extras.js";
import { PACKAGED_MARKERS, SHORTS_CHIP_MARKER } from "../../content/markers.js";
import pins from "./free-surface-pins.json";

// Free-protection invariants for the Still Pro extras (CI). Extras may only ADD their own Pro
// surfaces, routes and markers; the free Shorts/Reels surfaces stay byte-identical and the packaged
// set the runtime admits as a whole can never be evicted by one bad extras surface.

type Packaged = { services: Record<string, { matches: string[]; surfaces: Array<{ id: string; feature: string; action: string; selectors?: string[] }> }> };
const packaged = () => structuredClone(PACKAGED_RULE_SET_V2) as Packaged & Record<string, unknown>;
const BASE: Record<"youtube" | "instagram" | "facebook", ServiceRulesV2> = {
  youtube: YOUTUBE_SHORTS_RULES, instagram: INSTAGRAM_REELS_RULES, facebook: FACEBOOK_REELS_RULES,
};
const EXTRAS: Record<"youtube" | "instagram" | "facebook", ServiceExtras> = {
  youtube: YOUTUBE_EXTRAS, instagram: INSTAGRAM_EXTRAS, facebook: FACEBOOK_EXTRAS,
};
const PIN_SHA256: Record<string, string> = {
  "youtube-shorts-discovery": "febe2fb0e8b15f05e5057b6926bab9d29f7d8d7aa922768e10a55eef29fb687c",
  "instagram-reels-discovery": "ba60b3ff28c65a72e21433a15b8aa5fabb603894e33bb4472a8a7443489f3849",
  "facebook-reels-discovery": "8959e052c543da19c176122440f212fd53a0ccdefb5e606949ec7ddb3f8b3866",
};
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const proOf = (service: ServiceId) => FEATURE_REGISTRY.filter((feature) => feature.service === service && feature.tier === "pro").map((feature) => feature.id as string);

/**
 * The CI guard. The runtime admits the packaged set all-or-nothing (admitPackagedRuleSetV2), so
 * an invalid extras surface would silently drop every user's free blocking back to the legacy
 * engine. Validation is deterministic and identical at build and run time, so failing here,
 * before merge, is complete: nothing that passes can be rejected on a device.
 */
function guardViolations(set: Packaged & Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [serviceId, service] of Object.entries(set.services)) {
    for (const surface of service.surfaces) {
      const alone = { ...set, services: { [serviceId]: { matches: service.matches, surfaces: [surface] } } };
      const result = validateRuleSetV2(alone);
      if (!result.ok) problems.push(`${serviceId}/${surface.id}: ${result.errors.join(", ")}`);
    }
  }
  const whole = validateRuleSetV2(set);
  if (!whole.ok) problems.push(`whole set: ${whole.errors.join(", ")}`);
  if (!admitPackagedRuleSetV2(set)) problems.push("packaged set not admitted with every free feature");
  return problems;
}

describe("free-protection invariants for the Still Pro extras", () => {
  it.each(Object.entries(pins.surfaces))("%s selectors are pinned byte for byte in the module and the packaged data", (id, pin) => {
    expect(sha256(pin.selectors)).toBe(PIN_SHA256[id]);
    const service = pin.service as keyof typeof BASE;
    const authored = BASE[service].surfaces.filter((surface) => surface.id === id);
    expect(authored).toHaveLength(1);
    expect(JSON.stringify(authored[0])).toBe(JSON.stringify({ id, feature: pin.feature, action: "hide", selectors: pin.selectors }));
    const shipped = packaged().services[service]!.surfaces;
    // The free surface is the first packaged surface of its service, unchanged.
    expect(JSON.stringify(shipped[0])).toBe(JSON.stringify({ id, feature: pin.feature, action: "hide", selectors: pin.selectors }));
    expect(shipped.filter((surface) => surface.feature === pin.feature)).toHaveLength(1);
  });

  it("each base module holds only its free core surface", () => {
    for (const [service, rules] of Object.entries(BASE)) {
      expect(rules.surfaces.map((surface) => surface.feature)).toEqual(
        FEATURE_REGISTRY.filter((feature) => feature.service === service && feature.tier === "free").map((feature) => feature.id));
    }
    expect(Object.keys(pins.surfaces).sort()).toEqual(["facebook-reels-discovery", "instagram-reels-discovery", "youtube-shorts-discovery"]);
  });

  it("extras surfaces, routes and markers target only their own service's Pro features and never reuse a free surface id", () => {
    const freeIds = new Set(Object.values(packaged().services).flatMap((service) =>
      service.surfaces.filter((surface) => PACKAGED_FREE_FEATURES.includes(surface.feature as never)).map((surface) => surface.id)));
    expect([...freeIds].sort()).toEqual(["facebook-reels-discovery", "instagram-reels-discovery", "tiktok-site", "youtube-shorts-discovery"]);
    const seen = new Set<string>();
    for (const [service, extras] of Object.entries(EXTRAS) as [ServiceId, ServiceExtras][]) {
      for (const surface of extras.surfaces) {
        expect(freeIds.has(surface.id), surface.id).toBe(false);
        expect(seen.has(surface.id), surface.id).toBe(false);
        seen.add(surface.id);
        expect(proOf(service), surface.id).toContain(surface.feature);
        expect(surface.action).toBe("hide");
      }
      for (const route of extras.routes) expect(proOf(service)).toContain(route.feature);
      for (const feature of extras.handlers ?? []) expect(proOf(service), `handler ${feature}`).toContain(feature);
      for (const marker of extras.markers) {
        expect(proOf(service)).toContain(marker.feature);
        expect(marker.attribute).not.toBe(SHORTS_CHIP_MARKER.attribute);
      }
    }
    // The packaged marker list is the free Shorts chip first, then only extras markers.
    expect(PACKAGED_MARKERS[0]).toBe(SHORTS_CHIP_MARKER);
    expect(PACKAGED_MARKERS.slice(1).every((marker) => FEATURE_REGISTRY.some((f) => f.id === marker.feature && f.tier === "pro"))).toBe(true);
  });

  it("the packaged set is exactly base then extras surfaces per service, so extras never reorder or edit free data", () => {
    const set = packaged();
    for (const service of ["youtube", "instagram", "facebook"] as const) {
      expect(set.services[service]).toEqual(JSON.parse(JSON.stringify({
        ...BASE[service], surfaces: [...BASE[service].surfaces, ...EXTRAS[service].surfaces],
      })));
    }
  });

  it("CI guard: every packaged surface is valid on its own and the whole set is admitted with every free feature", () => {
    expect(guardViolations(packaged())).toEqual([]);
  });

  it("CI guard catches the hazard it exists for: one bad extras surface would evict the whole packaged set", () => {
    const bad = packaged();
    bad.services.youtube!.surfaces.push({ id: "synthetic-bad-extra", feature: "youtube.comments", action: "hide", selectors: ["a[href=url(x)]"] });
    // At runtime this is all-or-nothing: free Shorts/Reels/TikTok would fall back to the legacy lane.
    expect(admitPackagedRuleSetV2(bad)).toBeNull();
    expect(guardViolations(bad)).toEqual(expect.arrayContaining([expect.stringMatching(/^youtube\/synthetic-bad-extra: /)]));
    const crowded = packaged();
    for (let index = 0; index < 64; index++)
      crowded.services.facebook!.surfaces.push({ id: `synthetic-extra-${index}`, feature: "facebook.videos", action: "hide", selectors: ["div"] });
    expect(admitPackagedRuleSetV2(crowded)).toBeNull();
    expect(guardViolations(crowded)).toEqual(expect.arrayContaining([expect.stringMatching(/^whole set: /)]));
  });
});
