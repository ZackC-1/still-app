import { describe, expect, it } from "vitest";
import { PAID_TIER_ENABLED, type BenefitId } from "@still/shared-types";
import vectors from "../../../../../tests/access-proof/local-protection-vectors.json";
import { paidCutoffForLocalProtection, type VerifiedPaidCutoff } from "../paid-cutoff.js";
import { mutateLocalProtection } from "../local-protection.js";

// The shipped compiled switch (on for 3.x). paid-cutoff-compiled-on.test.ts covers the mapping in detail.
const verified: VerifiedPaidCutoff = Object.freeze({
  product: vectors.cutoff.product, benefits: vectors.cutoff.benefits as BenefitId[], activatedAt: vectors.cutoff.activatedAt,
});

describe("paid cutoff adapter with the shipped compiled switch", () => {
  it("is on in this build (the 3.x release line)", () => {
    expect(PAID_TIER_ENABLED).toBe(true);
  });

  it("turns a verified cutoff into the protection grant the writer records", () => {
    const cutoff = paidCutoffForLocalProtection(verified);
    expect(cutoff).toEqual({ product: verified.product, benefits: verified.benefits, activatedAt: verified.activatedAt });
    expect(mutateLocalProtection(null, { kind: "declare", confirmed: true, priorEvidence: "absent", cutoff })?.grant)
      .toEqual({ product: verified.product, benefits: verified.benefits, activatedAt: verified.activatedAt });
  });

  it("ignores missing and malformed input without throwing", () => {
    expect(paidCutoffForLocalProtection(null)).toBeNull();
    expect(paidCutoffForLocalProtection({ ...verified, activatedAt: 0 })).toBeNull();
  });
});
