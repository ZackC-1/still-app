import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

// No module mock here: everything in this file runs against the real shipped PAID_TIER_ENABLED.

const BUILD = "3.0.0";
const encode = (text: string) => new TextEncoder().encode(text);
const builds = [{ surface: "chrome_desktop", build: BUILD }, { surface: "apple_mobile_host", build: BUILD }];
const salesBody = (overrides: Record<string, unknown> = {}) => encode(JSON.stringify({
  schema: 1, environment: "sandbox", revision: 3, salesEnabled: true,
  channels: { apple: { enabled: true, offer: "still-pro-v3" }, web: { enabled: true, offer: "still-pro-v3" } },
  builds, ...overrides,
}));
const ratingBody = (overrides: Record<string, unknown> = {}) => encode(JSON.stringify({
  schema: 1, environment: "sandbox", revision: 7, master: true,
  surfaces: Object.fromEntries(PRODUCT_POLICY_SURFACES.map(surface => [surface, true])), builds, ...overrides,
}));
const START = 10;
const response = (body: Uint8Array | null): ProductPolicyResponse => ({ body, requestStartedAt: START });
const clock = (at = START + 10) => () => at;
const handBuiltOn: PackagedPolicyContext = { paidTierEnabled: true, environment: "sandbox", surface: "chrome_desktop", build: BUILD };

type RawVector = { namespace: string; context: PackagedPolicyContext; highestSeenRevision: number; now: number;
  response: { body?: string | null; bodyHex?: string; requestStartedAt: number } | null };
const vectorCases = (fixture as unknown as { cases: RawVector[] }).cases;
const vectorBody = (raw: RawVector["response"]): Uint8Array | null => !raw ? null :
  raw.bodyHex !== undefined ? Uint8Array.from(raw.bodyHex.match(/../g) ?? [], pair => parseInt(pair, 16)) :
  typeof raw.body === "string" ? encode(raw.body) : null;

describe("two-key sales activation against the real compiled constant", () => {
  it("ships with the compiled switch off", () => {
    expect(PAID_TIER_ENABLED).toBe(false);
  });

  it("ignores a hand-built context that claims the paid tier is on", () => {
    for (const surface of PRODUCT_POLICY_SURFACES) {
      const verdict = evaluateSalesPolicy({ ...handBuiltOn, surface }, response(salesBody()), 0, clock());
      expect(verdict).toEqual({ allowed: false, reason: "compiled_off", revision: null });
    }
  });

  it("keeps every shared sales vector Off, whatever the remote or context says", () => {
    const sales = vectorCases.filter(c => c.namespace === "sales");
    expect(sales.length).toBeGreaterThan(100);
    for (const vector of sales) {
      const verdict = evaluateSalesPolicy({ ...vector.context, paidTierEnabled: true },
        vector.response && { body: vectorBody(vector.response), requestStartedAt: vector.response.requestStartedAt },
        vector.highestSeenRevision, () => vector.now);
      expect(verdict.allowed).toBe(false);
      expect(["compiled_off", "context"]).toContain(verdict.reason);
    }
  });

  it("builds the packaged context from the compiled constant", () => {
    const packaged = packagedPolicyContext("sandbox", "chrome_desktop", BUILD);
    expect(packaged.paidTierEnabled).toBe(PAID_TIER_ENABLED);
    expect(Object.isFrozen(packaged)).toBe(true);
    expect(evaluateSalesPolicy(packaged, response(salesBody()), 0, clock()).reason).toBe("compiled_off");
  });

  it("never yields an access mode: the verdict carries no paidMode and access stays compiled", () => {
    const verdict = evaluateRatingPolicy(handBuiltOn, response(ratingBody()), 0, clock());
    expect(Object.keys(verdict).sort()).toEqual(["allowed", "reason", "revision"]);
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(packagedAccessContext().paidMode).toBe(PAID_TIER_ENABLED);
  });
});

describe("rating", () => {
  it("is master AND surface AND build, independent of the paid flag", () => {
    const off = { ...handBuiltOn, paidTierEnabled: false };
    expect(evaluateRatingPolicy(off, response(ratingBody()), 0, clock())).toEqual({ allowed: true, reason: "on", revision: 7 });
    expect(evaluateRatingPolicy(off, response(ratingBody({ master: false })), 0, clock()).reason).toBe("off");
    expect(evaluateRatingPolicy(off, response(ratingBody({ builds: [] })), 0, clock()).reason).toBe("build");
  });

  it("keeps Edge inert as a deferred surface", () => {
    const edge = { ...handBuiltOn, surface: "edge_desktop" as const };
    const body = ratingBody({ builds: [{ surface: "edge_desktop", build: BUILD }] });
    expect(evaluateRatingPolicy(edge, response(body), 0, clock())).toEqual({ allowed: false, reason: "deferred_surface", revision: null });
  });
});

describe("freshness uses the injected clock", () => {
  it("reads the clock at evaluation time and ignores any caller-supplied completion time", () => {
    const now = vi.fn(() => START + 4999);
    expect(evaluateRatingPolicy(handBuiltOn, response(ratingBody()), 0, now).reason).toBe("on");
    expect(now).toHaveBeenCalledTimes(1);
    const replayed = { ...response(ratingBody()), evaluatedAt: START + 1 } as ProductPolicyResponse;
    expect(evaluateRatingPolicy(handBuiltOn, replayed, 0, clock(START + 60_000)).reason).toBe("late");
  });

  it("treats a missing, throwing, fractional or earlier clock as late", () => {
    const body = response(ratingBody());
    expect(evaluateRatingPolicy(handBuiltOn, body, 0, clock(START + 5000)).reason).toBe("late");
    expect(evaluateRatingPolicy(handBuiltOn, body, 0, clock(START - 1)).reason).toBe("late");
    expect(evaluateRatingPolicy(handBuiltOn, body, 0, clock(START + 0.5)).reason).toBe("late");
    expect(evaluateRatingPolicy(handBuiltOn, body, 0, clock(Number.NaN)).reason).toBe("late");
    expect(evaluateRatingPolicy(handBuiltOn, body, 0, () => { throw new Error("no clock"); }).reason).toBe("late");
    expect(evaluateRatingPolicy(handBuiltOn, { body: ratingBody(), requestStartedAt: 0.5 }, 0, clock()).reason).toBe("late");
    expect(evaluateRatingPolicy(handBuiltOn, body, 0, undefined as unknown as () => number).reason).toBe("context");
  });
});

describe("required revision fence", () => {
  it("is a required parameter", () => {
    // @ts-expect-error highestSeenRevision is required, not defaulted.
    const omitted = evaluateRatingPolicy(handBuiltOn, response(ratingBody()));
    expect(omitted.reason).toBe("context");
    expect(evaluateRatingPolicy(handBuiltOn, response(ratingBody()), undefined as unknown as number, clock()).reason).toBe("context");
    expect(evaluateSalesPolicy(handBuiltOn, response(salesBody()), undefined as unknown as number, clock()).reason).toBe("context");
  });

  it("rejects a response older than the highest accepted revision", () => {
    expect(evaluateRatingPolicy(handBuiltOn, response(ratingBody()), 8, clock())).toEqual({ allowed: false, reason: "stale", revision: 7 });
    expect(evaluateRatingPolicy(handBuiltOn, response(ratingBody()), 7, clock()).reason).toBe("on");
  });
});

describe("raw bytes and fail-safe inputs", () => {
  it("treats missing, oversized and malformed bodies as Off", () => {
    expect(evaluateRatingPolicy(handBuiltOn, null, 0, clock()).reason).toBe("missing");
    expect(evaluateRatingPolicy(handBuiltOn, response(null), 0, clock()).reason).toBe("missing");
    expect(evaluateRatingPolicy(handBuiltOn, response(new Uint8Array(PRODUCT_POLICY_MAX_BYTES + 1).fill(0x20)), 0, clock()).reason).toBe("oversized");
    expect(evaluateRatingPolicy(handBuiltOn, response(new Uint8Array(PRODUCT_POLICY_MAX_BYTES + 1).fill(0xe9)), 0, clock()).reason).toBe("oversized");
  });

  it("refuses decoded text and other non-byte bodies", () => {
    const text = new TextDecoder().decode(ratingBody());
    for (const body of [text, ratingBody().buffer, Array.from(ratingBody()), 42]) {
      expect(evaluateRatingPolicy(handBuiltOn, response(body as unknown as Uint8Array), 0, clock()).reason).toBe("invalid");
    }
  });

  it("rejects a byte-order mark, invalid UTF-8 and Latin-1 bytes", () => {
    const json = ratingBody();
    const withPrefix = (prefix: number[]) => Uint8Array.from([...prefix, ...json]);
    const splice = (bytes: number[]) => {
      const text = new TextDecoder().decode(json);
      const at = text.indexOf('"build":"3.0.0') + '"build":"3.0.0'.length;
      return Uint8Array.from([...json.subarray(0, at), ...bytes, ...json.subarray(at)]);
    };
    expect(evaluateRatingPolicy(handBuiltOn, response(json), 0, clock()).reason).toBe("on");
    for (const body of [withPrefix([0xef, 0xbb, 0xbf]), withPrefix([0xfe, 0xff]), splice([0xff]), splice([0xc0, 0xaf]), splice([0xe9]), splice([0xc3, 0xa9])]) {
      expect(evaluateRatingPolicy(handBuiltOn, response(body), 0, clock()).reason).toBe("invalid");
    }
  });

  it("rejects a wrong environment and a revision below 1", () => {
    expect(evaluateRatingPolicy(handBuiltOn, response(ratingBody({ environment: "production" })), 0, clock()).reason).toBe("environment");
    expect(evaluateRatingPolicy(handBuiltOn, response(ratingBody({ revision: 0 })), 0, clock()).reason).toBe("invalid");
  });

  it("refuses a context that packaged code could not have produced", () => {
    const hostile = { ...handBuiltOn, paidTierEnabled: "true" } as unknown as PackagedPolicyContext;
    expect(evaluateRatingPolicy(hostile, response(ratingBody()), 0, clock()).reason).toBe("context");
    const throwing = Object.defineProperty({ ...handBuiltOn }, "surface", { get() { throw new Error("hostile"); } });
    expect(evaluateRatingPolicy(throwing, response(ratingBody()), 0, clock())).toEqual({ allowed: false, reason: "invalid", revision: null });
    expect(evaluateRatingPolicy(handBuiltOn, response(ratingBody()), 1.5, clock()).reason).toBe("context");
  });
});

describe("closed grammar", () => {
  const reject = (namespace: "sales" | "rating", body: Uint8Array) =>
    expect(() => parseProductPolicy(namespace, body)).toThrow(ProductPolicyGrammarError);

  it("rejects unknown keys at every level and never evaluates a body as code", () => {
    reject("sales", salesBody({ extra: true }));
    reject("sales", salesBody({ channels: { apple: { enabled: true, offer: "still-pro-v3", extra: 1 }, web: { enabled: true, offer: "still-pro-v3" } } }));
    reject("sales", salesBody({ builds: [{ surface: "chrome_desktop", build: BUILD, extra: 1 }] }));
    reject("rating", ratingBody({ extra: true }));
    reject("rating", ratingBody({ surfaces: { ...Object.fromEntries(PRODUCT_POLICY_SURFACES.map(s => [s, true])), extra: true } }));
    reject("sales", salesBody({ builds: [{ surface: "chrome_desktop", build: "https://evil.example/x" }] }));
    reject("sales", Uint8Array.from([...encode('{"constructor":{"prototype":{}},'), ...salesBody().subarray(1)]));
    reject("rating", encode("(() => true)()"));
    reject("unknown" as "sales", salesBody());
  });

  it("names the remote sales master salesEnabled, never like the compiled flag", () => {
    const { salesEnabled: _omit, ...rest } = JSON.parse(new TextDecoder().decode(salesBody())) as Record<string, unknown>;
    reject("sales", encode(JSON.stringify({ ...rest, paidTierEnabled: true })));
    reject("sales", salesBody({ paidTierEnabled: true }));
    expect(parseProductPolicy("sales", salesBody()).salesEnabled).toBe(true);
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
    expect(Object.keys(SALES_POLICY_FIELDS).sort()).toEqual(["builds", "channels", "environment", "revision", "salesEnabled", "schema"]);
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

  // The server store and its two Edge Functions (U6-P2) may import the shared grammar: they are the
  // policy's publisher, not a client. Every other importer under packages/**, apps/** or supabase/**
  // is refused, so client dormancy stays enforced.
  const SERVER_IMPORTERS = /^supabase\/functions\/product-policy(-admin)?\//;

  it("has no client importer: free blocking, sync and Restore never consult it", () => {
    const importers = [...sources(join(root, "packages")), ...sources(join(root, "apps")), ...sources(join(root, "supabase"))]
      .filter(path => !/__tests__|\.test\.|\.spec\.|_test\.ts$/.test(path))
      .filter(path => /product-policy(\.js|\.ts)?["']/.test(readFileSync(path, "utf8")))
      .map(path => relative(root, path))
      .filter(path => !SERVER_IMPORTERS.test(path));
    expect(importers).toEqual(["packages/core/src/entitlement/product-policy.ts"]);
  });

  it("is not re-exported from either package index", () => {
    expect(readFileSync(join(root, "packages/shared-types/src/index.ts"), "utf8")).not.toMatch(/product-policy/);
    expect(readFileSync(join(root, "packages/core/src/entitlement/index.ts"), "utf8")).not.toMatch(/product-policy/);
  });
});
