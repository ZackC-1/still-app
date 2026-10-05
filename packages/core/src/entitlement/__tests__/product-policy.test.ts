import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import {
  PRODUCT_POLICY_MAX_BYTES, PRODUCT_POLICY_SURFACES, ProductPolicyGrammarError, RATING_POLICY_FIELDS,
  SALES_POLICY_FIELDS, parseProductPolicy,
} from "@still/shared-types/product-policy";
import { packagedAccessContext } from "../access-policy.js";
import {
  evaluateRatingPolicy, evaluateSalesPolicy, packagedPolicyContext, type PackagedPolicyContext,
  type ProductPolicyResponse,
} from "../product-policy.js";
import fixture from "../../../../shared-types/fixtures/product-policy-vectors.json";

const BUILD = "3.0.0";
const builds = [{ surface: "chrome_desktop", build: BUILD }, { surface: "apple_mobile_host", build: BUILD }];
const salesBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  schema: 1, environment: "sandbox", revision: 3, paidTierEnabled: true,
  channels: { apple: { enabled: true, offer: "still-pro-v3" }, web: { enabled: true, offer: "still-pro-v3" } },
  builds, ...overrides,
});
const ratingBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  schema: 1, environment: "sandbox", revision: 7, master: true,
  surfaces: Object.fromEntries(PRODUCT_POLICY_SURFACES.map(surface => [surface, true])), builds, ...overrides,
});
const fresh = (body: string | null): ProductPolicyResponse => ({ body, requestStartedAt: 10, evaluatedAt: 20 });
const compiledOn: PackagedPolicyContext = { paidTierEnabled: true, environment: "sandbox", surface: "chrome_desktop", build: BUILD };
const compiledOff: PackagedPolicyContext = { ...compiledOn, paidTierEnabled: false };
const allBodies = (fixture as unknown as { cases: { response: { body: string | null } | null }[] }).cases
  .map(c => c.response?.body ?? null);

describe("two-key sales activation", () => {
  it("is Off whenever the compiled flag is false, whatever the remote says", () => {
    expect(evaluateSalesPolicy(compiledOn, fresh(salesBody()))).toEqual({ allowed: true, reason: "on", revision: 3 });
    expect(evaluateSalesPolicy(compiledOff, fresh(salesBody()))).toEqual({ allowed: false, reason: "compiled_off", revision: null });
    for (const surface of PRODUCT_POLICY_SURFACES) {
      for (const body of [...allBodies, salesBody({ paidTierEnabled: true }), salesBody({ paidMode: true })]) {
        const verdict = evaluateSalesPolicy({ ...compiledOff, surface }, fresh(body));
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toBe("compiled_off");
      }
    }
  });

  it("takes key one only from packaged code: today's packaged context keeps every remote value inert", () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    const packaged = packagedPolicyContext("sandbox", "chrome_desktop", BUILD);
    expect(packaged.paidTierEnabled).toBe(PAID_TIER_ENABLED);
    expect(Object.isFrozen(packaged)).toBe(true);
    expect(evaluateSalesPolicy(packaged, fresh(salesBody())).reason).toBe("compiled_off");
  });

  it("requires remote master, the surface's channel and an allowlisted build as the other keys", () => {
    expect(evaluateSalesPolicy(compiledOn, fresh(salesBody({ paidTierEnabled: false }))).reason).toBe("off");
    expect(evaluateSalesPolicy(compiledOn, fresh(salesBody({ builds: [] }))).reason).toBe("build");
    expect(evaluateSalesPolicy({ ...compiledOn, build: "3.0.1" }, fresh(salesBody())).reason).toBe("build");
  });

  it("never yields an access mode: the verdict carries no paidMode and access stays compiled", () => {
    const verdict = evaluateSalesPolicy(compiledOn, fresh(salesBody()));
    expect(Object.keys(verdict).sort()).toEqual(["allowed", "reason", "revision"]);
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(packagedAccessContext().paidMode).toBe(PAID_TIER_ENABLED);
  });
});

describe("rating", () => {
  it("is master AND surface AND build, independent of the compiled paid flag", () => {
    expect(evaluateRatingPolicy(compiledOff, fresh(ratingBody())).reason).toBe("on");
    expect(evaluateRatingPolicy(compiledOn, fresh(ratingBody({ master: false }))).reason).toBe("off");
    expect(evaluateRatingPolicy(compiledOn, fresh(ratingBody({ builds: [] }))).reason).toBe("build");
  });

  it("keeps Edge inert as a deferred surface", () => {
    const edge = { ...compiledOn, surface: "edge_desktop" as const };
    const body = ratingBody({ builds: [{ surface: "edge_desktop", build: BUILD }] });
    expect(evaluateRatingPolicy(edge, fresh(body))).toEqual({ allowed: false, reason: "deferred_surface", revision: null });
    expect(evaluateSalesPolicy(edge, fresh(salesBody({ builds: [{ surface: "edge_desktop", build: BUILD }] }))).reason).toBe("deferred_surface");
  });
});

describe("fail-safe inputs", () => {
  it("treats missing, late, oversized and malformed input as Off", () => {
    for (const evaluate of [evaluateSalesPolicy, evaluateRatingPolicy]) {
      expect(evaluate(compiledOn, null).reason).toBe("missing");
      expect(evaluate(compiledOn, fresh(null)).reason).toBe("missing");
      expect(evaluate(compiledOn, { body: salesBody(), requestStartedAt: 0, evaluatedAt: 5000 }).reason).toBe("late");
      expect(evaluate(compiledOn, { body: salesBody(), requestStartedAt: 0.5, evaluatedAt: 1 }).reason).toBe("late");
      expect(evaluate(compiledOn, { body: salesBody(), requestStartedAt: Number.NaN, evaluatedAt: 1 }).reason).toBe("late");
      expect(evaluate(compiledOn, fresh(" ".repeat(PRODUCT_POLICY_MAX_BYTES + 1))).reason).toBe("oversized");
      expect(evaluate(compiledOn, fresh(42 as unknown as string)).reason).toBe("invalid");
      expect(evaluate(compiledOn, fresh({ toString: () => salesBody() } as unknown as string)).reason).toBe("invalid");
    }
  });

  it("rejects a wrong environment and a revision below 1", () => {
    expect(evaluateSalesPolicy(compiledOn, fresh(salesBody({ environment: "production" }))).reason).toBe("environment");
    expect(evaluateSalesPolicy(compiledOn, fresh(salesBody({ revision: 0 }))).reason).toBe("invalid");
    expect(evaluateRatingPolicy(compiledOn, fresh(ratingBody({ revision: 0 }))).reason).toBe("invalid");
  });

  it("refuses a context that packaged code could not have produced", () => {
    const hostile = { ...compiledOn, paidTierEnabled: "true" } as unknown as PackagedPolicyContext;
    expect(evaluateSalesPolicy(hostile, fresh(salesBody())).reason).toBe("context");
    const throwing = Object.defineProperty({ ...compiledOn }, "surface", { get() { throw new Error("hostile"); } });
    expect(evaluateSalesPolicy(throwing, fresh(salesBody()))).toEqual({ allowed: false, reason: "invalid", revision: null });
    expect(evaluateRatingPolicy(compiledOn, fresh(ratingBody()), 1.5).reason).toBe("context");
  });
});

describe("closed grammar", () => {
  it("rejects unknown keys at every level and never evaluates a body as code", () => {
    const reject = (namespace: "sales" | "rating", body: string) =>
      expect(() => parseProductPolicy(namespace, body)).toThrow(ProductPolicyGrammarError);
    reject("sales", salesBody({ extra: true }));
    reject("sales", salesBody({ channels: { apple: { enabled: true, offer: "still-pro-v3", extra: 1 }, web: { enabled: true, offer: "still-pro-v3" } } }));
    reject("sales", salesBody({ builds: [{ surface: "chrome_desktop", build: BUILD, extra: 1 }] }));
    reject("rating", ratingBody({ extra: true }));
    reject("rating", ratingBody({ surfaces: { ...Object.fromEntries(PRODUCT_POLICY_SURFACES.map(s => [s, true])), extra: true } }));
    reject("sales", salesBody({ builds: [{ surface: "chrome_desktop", build: "https://evil.example/x" }] }));
    reject("sales", '{"constructor":{"prototype":{}},' + salesBody().slice(1));
    reject("rating", "(() => true)()");
    reject("unknown" as "sales", salesBody());
  });

  it("returns only the declared keys as frozen plain data", () => {
    const sales = parseProductPolicy("sales", salesBody());
    expect(Object.keys(sales).sort()).toEqual(Object.keys(SALES_POLICY_FIELDS).sort());
    expect(Object.isFrozen(sales) && Object.isFrozen(sales.channels) && Object.isFrozen(sales.builds) && Object.isFrozen(sales.builds[0])).toBe(true);
    const rating = parseProductPolicy("rating", ratingBody());
    expect(Object.keys(rating).sort()).toEqual(Object.keys(RATING_POLICY_FIELDS).sort());
    expect(Object.keys(rating.surfaces).sort()).toEqual([...PRODUCT_POLICY_SURFACES].sort());
  });

  it("holds exactly the closed field list proposed for owner review", () => {
    expect(Object.keys(SALES_POLICY_FIELDS).sort()).toEqual(["builds", "channels", "environment", "paidTierEnabled", "revision", "schema"]);
    expect(Object.keys(RATING_POLICY_FIELDS).sort()).toEqual(["builds", "environment", "master", "revision", "schema", "surfaces"]);
  });
});

describe("dormancy", () => {
  const root = resolve(__dirname, "../../../../..");
  const skip = new Set(["node_modules", "dist", ".output", ".wxt", "build", "coverage", "DerivedData", ".build", "test-results"]);
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      if (skip.has(name)) return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|mts|js|mjs|svelte)$/.test(name) ? [path] : [];
    });
  }

  it("has no production importer: free blocking, sync and Restore never consult it", () => {
    const importers = [...sources(join(root, "packages")), ...sources(join(root, "apps")), ...sources(join(root, "supabase"))]
      .filter(path => !/__tests__|\.test\.|\.spec\./.test(path))
      .filter(path => /product-policy(\.js|\.ts)?["']/.test(readFileSync(path, "utf8")))
      .map(path => relative(root, path));
    expect(importers).toEqual(["packages/core/src/entitlement/product-policy.ts"]);
  });

  it("is not re-exported from either package index", () => {
    expect(readFileSync(join(root, "packages/shared-types/src/index.ts"), "utf8")).not.toMatch(/product-policy/);
    expect(readFileSync(join(root, "packages/core/src/entitlement/index.ts"), "utf8")).not.toMatch(/product-policy/);
  });
});
