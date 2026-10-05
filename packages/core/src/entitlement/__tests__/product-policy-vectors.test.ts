import { describe, expect, it, vi } from "vitest";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import {
  evaluateRatingPolicy, evaluateSalesPolicy, type PackagedPolicyContext, type ProductPolicyResponse,
  type ProductPolicyVerdict,
} from "../product-policy.js";
import fixture from "../../../../shared-types/fixtures/product-policy-vectors.json";

// Test-only seam: this file alone sees the compiled switch on, so the shared vectors exercise the
// whole sales path. Production cannot reach a vitest module mock. product-policy.test.ts runs the
// same vectors against the real shipped constant, where every sales vector is compiled_off.
vi.mock("@still/shared-types", async importOriginal => ({
  ...await importOriginal<typeof import("@still/shared-types")>(), PAID_TIER_ENABLED: true,
}));

// The same file drives StillKit's ProductPolicyVectorTests. Both runners pin the case count so a
// runner that silently skips vectors cannot pass.
const EXPECTED_CASES = 136;

type RawResponse = {
  readonly body?: string | null;
  readonly bodyHex?: string;
  readonly padTo?: number;
  readonly requestStartedAt: number;
};
type Vector = {
  readonly name: string;
  readonly namespace: "sales" | "rating";
  readonly context: PackagedPolicyContext;
  readonly highestSeenRevision: number;
  readonly now: number;
  readonly response: RawResponse | null;
  readonly expect: ProductPolicyVerdict;
};
const vectors = fixture as unknown as { readonly schema: 1; readonly cases: readonly Vector[] };

function materializeVector(response: RawResponse | null): ProductPolicyResponse | null {
  if (!response) return null;
  let body: Uint8Array | null;
  if (response.bodyHex !== undefined) {
    if (response.body !== undefined || !/^(?:[0-9a-f]{2})*$/.test(response.bodyHex)) throw new Error("bad fixture body");
    body = Uint8Array.from(response.bodyHex.match(/../g) ?? [], pair => parseInt(pair, 16));
  } else if (typeof response.body === "string") body = new TextEncoder().encode(response.body);
  else if (response.body === null) body = null;
  else throw new Error("fixture body must be text, hex or null");
  if (response.padTo !== undefined && body) {
    if (body.length > response.padTo) throw new Error("padTo smaller than body");
    const padded = new Uint8Array(response.padTo).fill(0x20);
    padded.set(body);
    body = padded;
  }
  return { body, requestStartedAt: response.requestStartedAt };
}

describe("shared product policy vectors (compiled switch on via test seam)", () => {
  it("runs with the seam in effect", () => {
    expect(PAID_TIER_ENABLED).toBe(true);
  });

  it("has the pinned schema, count and unique names", () => {
    expect(vectors.schema).toBe(1);
    expect(vectors.cases).toHaveLength(EXPECTED_CASES);
    expect(new Set(vectors.cases.map(c => `${c.namespace}: ${c.name}`)).size).toBe(EXPECTED_CASES);
  });

  it.each(vectors.cases.map(c => [`${c.namespace}: ${c.name}`, c] as const))("%s", (_name, vector) => {
    const evaluate = vector.namespace === "sales" ? evaluateSalesPolicy : evaluateRatingPolicy;
    const now = vi.fn(() => vector.now);
    expect(evaluate(vector.context, materializeVector(vector.response), vector.highestSeenRevision, now)).toEqual(vector.expect);
    // The clock is read at most once per evaluation.
    expect(now.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("covers every verdict reason in both namespaces where it applies", () => {
    const seen = (namespace: string) => new Set(vectors.cases.filter(c => c.namespace === namespace).map(c => c.expect.reason));
    expect([...seen("sales")].sort()).toEqual(["build", "compiled_off", "context", "deferred_surface", "environment",
      "invalid", "late", "missing", "off", "on", "oversized", "stale"]);
    expect([...seen("rating")].sort()).toEqual(["build", "context", "deferred_surface", "environment",
      "invalid", "late", "missing", "off", "on", "oversized", "stale"]);
  });

  it("covers raw-byte vectors in both namespaces", () => {
    const hex = vectors.cases.filter(c => c.response?.bodyHex !== undefined);
    expect(hex.filter(c => c.namespace === "sales").length).toBeGreaterThanOrEqual(10);
    expect(hex.filter(c => c.namespace === "rating").length).toBeGreaterThanOrEqual(2);
  });
});
