import { describe, expect, it, vi } from "vitest";
import type { BenefitId } from "@still/shared-types";
import vectors from "../../../../../tests/access-proof/local-protection-vectors.json";
import { paidCutoffForLocalProtection, type VerifiedPaidCutoff } from "../paid-cutoff.js";
import { mutateLocalProtection } from "../local-protection.js";

// Test-only seam, as in product-policy-vectors.test.ts: this file alone sees the compiled switch
// on, so the mapping itself is exercised. Production cannot reach a vitest module mock.
vi.mock("@still/shared-types", async importOriginal => ({
  ...await importOriginal<typeof import("@still/shared-types")>(), PAID_TIER_ENABLED: true,
}));

const verified: VerifiedPaidCutoff = Object.freeze({
  product: vectors.cutoff.product, benefits: vectors.cutoff.benefits as BenefitId[], activatedAt: vectors.cutoff.activatedAt,
});

describe("paid cutoff adapter once a build is compiled paid-capable", () => {
  it("maps a verified cutoff to a trusted local protection cutoff the writer accepts", () => {
    const cutoff = paidCutoffForLocalProtection(verified);
    expect(cutoff).toEqual({ product: verified.product, benefits: verified.benefits, activatedAt: verified.activatedAt });
    expect(Object.isFrozen(cutoff)).toBe(true);
    const record = mutateLocalProtection(null, { kind: "declare", confirmed: true, priorEvidence: "absent", cutoff });
    expect(record?.grant).toEqual({ product: verified.product, benefits: verified.benefits, activatedAt: verified.activatedAt });
  });

  it("rejects what localProtectionCutoff rejects, as null", () => {
    expect(paidCutoffForLocalProtection({ ...verified, product: "still-pro-v3" })).toBeNull();
    expect(paidCutoffForLocalProtection({ ...verified, activatedAt: 0 })).toBeNull();
    expect(paidCutoffForLocalProtection({ ...verified, benefits: ["not.a.benefit" as BenefitId] })).toBeNull();
    expect(paidCutoffForLocalProtection({ ...verified, benefits: [] })).toBeNull();
  });

  it("copies the benefits, so a later change to the input cannot reach the cutoff", () => {
    const benefits = [...verified.benefits];
    const cutoff = paidCutoffForLocalProtection({ ...verified, benefits });
    benefits.push("youtube.related");
    expect(cutoff?.benefits).toEqual(verified.benefits);
  });
});
