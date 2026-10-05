import { describe, expect, it } from "vitest";
import {
  evaluateRatingPolicy, evaluateSalesPolicy, type PackagedPolicyContext, type ProductPolicyResponse,
  type ProductPolicyVerdict,
} from "../product-policy.js";
import fixture from "../../../../shared-types/fixtures/product-policy-vectors.json";

// The same file drives StillKit's ProductPolicyVectorTests. Both runners pin the case count so a
// runner that silently skips vectors cannot pass.
const EXPECTED_CASES = 117;

type Vector = {
  readonly name: string;
  readonly namespace: "sales" | "rating";
  readonly context: PackagedPolicyContext;
  readonly highestSeenRevision: number;
  readonly response: (ProductPolicyResponse & { readonly padTo?: number }) | null;
  readonly expect: ProductPolicyVerdict;
};
const vectors = fixture as unknown as { readonly schema: 1; readonly cases: readonly Vector[] };

function materialize(response: Vector["response"]): ProductPolicyResponse | null {
  if (!response) return null;
  const { padTo, ...rest } = response;
  if (padTo === undefined || rest.body === null) return rest;
  const bytes = new TextEncoder().encode(rest.body).length;
  if (bytes > padTo) throw new Error("padTo smaller than body");
  return { ...rest, body: rest.body + " ".repeat(padTo - bytes) };
}

describe("shared product policy vectors", () => {
  it("has the pinned schema, count and unique names", () => {
    expect(vectors.schema).toBe(1);
    expect(vectors.cases).toHaveLength(EXPECTED_CASES);
    expect(new Set(vectors.cases.map(c => `${c.namespace}: ${c.name}`)).size).toBe(EXPECTED_CASES);
  });

  it.each(vectors.cases.map(c => [`${c.namespace}: ${c.name}`, c] as const))("%s", (_name, vector) => {
    const evaluate = vector.namespace === "sales" ? evaluateSalesPolicy : evaluateRatingPolicy;
    expect(evaluate(vector.context, materialize(vector.response), vector.highestSeenRevision)).toEqual(vector.expect);
  });

  it("covers every verdict reason in both namespaces where it applies", () => {
    const seen = (namespace: string) => new Set(vectors.cases.filter(c => c.namespace === namespace).map(c => c.expect.reason));
    expect([...seen("sales")].sort()).toEqual(["build", "compiled_off", "context", "deferred_surface", "environment",
      "invalid", "late", "missing", "off", "on", "oversized", "stale"]);
    expect([...seen("rating")].sort()).toEqual(["build", "context", "deferred_surface", "environment",
      "invalid", "late", "missing", "off", "on", "oversized", "stale"]);
  });
});
