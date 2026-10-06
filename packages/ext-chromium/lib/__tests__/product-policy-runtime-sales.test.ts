import { describe, expect, it, vi } from "vitest";
import { createProductPolicyRuntime, type ProductPolicyRuntimeOptions } from "../product-policy-runtime.js";
import { BUILD, ENDPOINT, SUPABASE_URL, memoryArea, ok, salesBody, scriptedFetch } from "./product-policy-fixtures.js";

// Test-only seam, as in core's product-policy-vectors.test.ts: this file alone sees the compiled
// paid switch on, so the sales path is exercised end to end. Production cannot reach a vitest
// module mock; product-policy-runtime.test.ts proves the shipped switch keeps sales Off unasked.
vi.mock("@still/shared-types", async importOriginal => ({
  ...await importOriginal<typeof import("@still/shared-types")>(), PAID_TIER_ENABLED: true,
}));

const HIGHEST = "still:productPolicy:sales:highestSeenRevision";
const ORDINARY = "still:productPolicy:sales:ordinary";

function runtime(overrides: Partial<ProductPolicyRuntimeOptions> & Pick<ProductPolicyRuntimeOptions, "area">) {
  return createProductPolicyRuntime({
    supabaseUrl: SUPABASE_URL, environment: "production", surface: "chrome_desktop", build: BUILD, ...overrides,
  });
}

describe("sales on a build compiled paid-capable", () => {
  it("allows a purchase start only on a fresh, valid, allowlisted On, and fences its revision", async () => {
    const storage = memoryArea();
    const net = scriptedFetch(() => ok(salesBody({ revision: 4 })));
    expect(await runtime({ area: storage.area, fetchImpl: net.fetchImpl }).freshCheck("sales"))
      .toEqual({ allowed: true, reason: "on", revision: 4 });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe(ENDPOINT);
    expect(net.calls[0]!.init.body).toBe('{"namespace":"sales","environment":"production"}');
    expect(net.calls[0]!.init.headers).toEqual({ "content-type": "application/json" });
    expect(storage.data.get(HIGHEST)).toBe(4);
  });

  it("is Off when the remote master or this surface's channel is off", async () => {
    for (const body of [salesBody({ salesEnabled: false }), salesBody({ web: false })]) {
      const net = scriptedFetch(() => ok(body));
      expect((await runtime({ area: memoryArea().area, fetchImpl: net.fetchImpl }).freshCheck("sales")).allowed).toBe(false);
    }
  });

  it("is Off offline, on failure and on no policy", async () => {
    const answers = [() => Promise.reject(new TypeError("offline")), () => new Response(null, { status: 404 }), () => new Response(null, { status: 503 })];
    for (const answer of answers) {
      const net = scriptedFetch(answer);
      expect((await runtime({ area: memoryArea().area, fetchImpl: net.fetchImpl }).freshCheck("sales")).allowed).toBe(false);
    }
  });

  it("a cached On cannot authorize a purchase start", async () => {
    const storage = memoryArea({
      [ORDINARY]: { schema: 1, revision: 4, projection: { on: true }, lastSuccess: 1_000, highWater: 1_000 },
      [HIGHEST]: 4,
    });
    const net = scriptedFetch(() => Promise.reject(new TypeError("offline")));
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl, wallNow: () => 2_000 });
    await policy.ordinary.sales.onOrdinaryOpen();
    expect(policy.ordinary.sales.current()).toMatchObject({ projection: { on: true } });
    expect(await policy.freshCheck("sales")).toEqual({ allowed: false, reason: "missing", revision: null });
  });

  it("rejects a replayed older On after a newer revision was accepted", async () => {
    const storage = memoryArea();
    let body = salesBody({ revision: 6, salesEnabled: false });
    const net = scriptedFetch(() => ok(body));
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl });
    expect((await policy.freshCheck("sales")).reason).toBe("off");
    body = salesBody({ revision: 5 });
    expect(await policy.freshCheck("sales")).toEqual({ allowed: false, reason: "stale", revision: 5 });
    expect(storage.data.get(HIGHEST)).toBe(6);
  });

  it("keeps a deferred surface Off without a request", async () => {
    const net = scriptedFetch(() => ok(salesBody()));
    expect((await runtime({ area: memoryArea().area, fetchImpl: net.fetchImpl, surface: "edge_desktop" }).freshCheck("sales")).reason)
      .toBe("deferred_surface");
    expect(net.calls).toHaveLength(0);
  });
});
