import { describe, expect, it } from "vitest";
import { PAID_TIER_ENABLED, type BenefitId } from "@still/shared-types";
import vectors from "../../../../../tests/access-proof/local-protection-vectors.json";
import { paidCutoffForLocalProtection, type VerifiedPaidCutoff } from "../paid-cutoff.js";
import { mutateLocalProtection } from "../local-protection.js";

// The shipped compiled switch. paid-cutoff-compiled-on.test.ts covers the mapping itself.
const verified: VerifiedPaidCutoff = Object.freeze({
  product: vectors.cutoff.product, benefits: vectors.cutoff.benefits as BenefitId[], activatedAt: vectors.cutoff.activatedAt,
});

describe("paid cutoff adapter with the shipped compiled switch", () => {
  it("is off in this build", () => {
    expect(PAID_TIER_ENABLED).toBe(false);
  });

  it("turns a verified cutoff into nothing, so no protection grant can be written", () => {
    const cutoff = paidCutoffForLocalProtection(verified);
    expect(cutoff).toBeNull();
    // The writer's own path: with no cutoff, a declaration records no grant.
    expect(mutateLocalProtection(null, { kind: "declare", confirmed: true, priorEvidence: "absent", cutoff })?.grant).toBeNull();
  });

  it("ignores missing and malformed input without throwing", () => {
    expect(paidCutoffForLocalProtection(null)).toBeNull();
    expect(paidCutoffForLocalProtection({ ...verified, activatedAt: 0 })).toBeNull();
  });
});
