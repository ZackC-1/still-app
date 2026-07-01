import { describe, expect, it } from "vitest";
import seed from "../../../rules/seed.json";
import type { SignedRuleSet } from "@still/shared-types";
import { PRO_SERVICE_IDS, proServiceIds, serviceHasFreeSurface } from "../tiers.js";

const ruleSet = seed as unknown as SignedRuleSet;

describe("service tier derivation — one source of truth for what costs money", () => {
  it("derives today's line from the seed: youtube free, the rest Pro", () => {
    expect(PRO_SERVICE_IDS).toEqual(new Set(["instagram", "tiktok", "facebook"]));
    expect(serviceHasFreeSurface(ruleSet, "youtube")).toBe(true);
  });

  it("a service gains a live free row the moment any of its surfaces goes tier:free", () => {
    // The scenario the hand-maintained list would have silently broken: one Instagram surface
    // moves to the free tier — the UI lock must follow the seed without a second edit.
    const mixed = JSON.parse(JSON.stringify(ruleSet)) as {
      services: Record<string, { surfaces: Array<{ tier?: string }> }>;
    };
    mixed.services.instagram!.surfaces[0]!.tier = "free";
    expect(proServiceIds(mixed as unknown as SignedRuleSet)).toEqual(
      new Set(["tiktok", "facebook"]),
    );
  });

  it("treats an absent service as Pro (never a free toggle that blocks nothing)", () => {
    const partial = { version: "1.0.0", services: {}, signature: ruleSet.signature };
    expect(proServiceIds(partial as unknown as SignedRuleSet)).toEqual(
      new Set(["youtube", "instagram", "tiktok", "facebook"]),
    );
  });

  it("honors the engine's always-free safety net even if a seed tag went missing", () => {
    const untagged = JSON.parse(JSON.stringify(ruleSet)) as {
      services: Record<string, { surfaces: Array<{ tier?: string }> }>;
    };
    for (const s of untagged.services.youtube!.surfaces) delete s.tier;
    expect(serviceHasFreeSurface(untagged as unknown as SignedRuleSet, "youtube")).toBe(true);
  });
});
