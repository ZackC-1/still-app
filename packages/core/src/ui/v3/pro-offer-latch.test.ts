import { describe, expect, it } from "vitest";
import { FEATURE_REGISTRY, type AccessState, type BenefitAccessSnapshot } from "@still/shared-types";
import { ACCESS_BENEFITS, initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { createProOfferLatch, proKnownMissing } from "./presentation.js";

// ISS-0032: the display latch behind every Still Pro offer surface.
const base = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
const PRO = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map((row) => row.id);
function pro(state: AccessState, overrides: Partial<Record<string, AccessState>> = {}): BenefitAccessSnapshot {
  const states = { ...base.states };
  for (const id of PRO) states[id] = state;
  return { ...base, states: { ...states, ...overrides } as BenefitAccessSnapshot["states"] };
}

describe("createProOfferLatch", () => {
  it("a first opening that is still checking is drawn as it is (no offer before a conclusive answer)", () => {
    const latch = createProOfferLatch();
    expect(latch(pro("checking"))).toEqual(pro("checking"));
    expect(latch(pro("verification_required"))).toEqual(pro("verification_required"));
  });

  it("after a conclusive lock, a hold is drawn locked; free and unsupported rows are untouched", () => {
    const latch = createProOfferLatch();
    latch(pro("locked"));
    for (const held of ["checking", "verification_required"] as const) {
      const shown = latch(pro(held, { [PRO[0]!]: "unsupported" }));
      expect(shown.states[PRO[0]!]).toBe("unsupported");
      for (const id of PRO.slice(1)) expect(shown.states[id]).toBe("locked");
      expect(proKnownMissing(shown)).toBe(true);
      expect(shown.states["youtube.shorts"]).toBe(base.states["youtube.shorts"]);
    }
  });

  it.each(["purchased", "protected"] as const)("verified ownership (%s) ends the latch at once and for good", (owned) => {
    const latch = createProOfferLatch();
    latch(pro("locked"));
    const mixed = pro("verification_required", { [PRO[0]!]: owned });
    expect(latch(mixed)).toEqual(mixed);
    expect(latch(pro("verification_required"))).toEqual(pro("verification_required"));
  });

  it("never turns anything usable: it only ever draws a held Pro row as locked", () => {
    const latch = createProOfferLatch();
    latch(pro("locked"));
    const shown = latch(pro("checking"));
    for (const id of PRO) expect(shown.states[id]).toBe("locked");
  });
});
