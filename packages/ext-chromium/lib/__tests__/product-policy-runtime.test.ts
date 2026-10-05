import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import {
  PRODUCT_POLICY_STORAGE_KEYS, PRODUCT_POLICY_TIMEOUT_MS, createProductPolicyRuntime, extensionPolicySurface,
  fetchProductPolicy, productPolicyEndpoint, type ProductPolicyRuntimeOptions,
} from "../product-policy-runtime.js";
import { BUILD, ENDPOINT, SUPABASE_URL, clock, memoryArea, ok, ratingBody, salesBody, scriptedFetch } from "./product-policy-fixtures.js";

// The shipped compiled switch (PAID_TIER_ENABLED false). product-policy-runtime-sales.test.ts runs
// the sales path with the switch on through a test-only module mock.

const HIGHEST = "still:productPolicy:rating:highestSeenRevision";
const ORDINARY = "still:productPolicy:rating:ordinary";

function runtime(overrides: Partial<ProductPolicyRuntimeOptions> & Pick<ProductPolicyRuntimeOptions, "area">) {
  return createProductPolicyRuntime({
    supabaseUrl: SUPABASE_URL, environment: "production", surface: "chrome_desktop", build: BUILD, ...overrides,
  });
}

afterEach(() => { vi.useRealTimers(); });

describe("the request: one plain, identity-free read", () => {
  it("posts only the namespace and environment to the project origin, with no token, key, cookie or query", async () => {
    const storage = memoryArea();
    const net = scriptedFetch(() => ok(ratingBody()));
    await runtime({ area: storage.area, fetchImpl: net.fetchImpl }).freshCheck("rating");
    expect(net.calls).toHaveLength(1);
    const { url, init } = net.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(new URL(url).search).toBe("");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"namespace":"rating","environment":"production"}');
    // Exactly one header. A session token, the anon key or any client header fails here.
    expect(init.headers).toEqual({ "content-type": "application/json" });
    const names = Object.keys(init.headers as Record<string, string>).map(name => name.toLowerCase());
    for (const forbidden of ["authorization", "apikey", "x-client-info", "cookie"]) expect(names).not.toContain(forbidden);
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses only the configured origin and makes no request for an unconfigured build", async () => {
    expect(productPolicyEndpoint("https://abc.supabase.co")).toBe("https://abc.supabase.co/functions/v1/product-policy");
    expect(productPolicyEndpoint("  ")).toBeNull();
    expect(productPolicyEndpoint(undefined)).toBeNull();
    expect(productPolicyEndpoint("not a url")).toBeNull();
    expect(productPolicyEndpoint("https://user:pass@abc.supabase.co")).toBeNull();
    expect(productPolicyEndpoint("ftp://abc.supabase.co")).toBeNull();
    const net = scriptedFetch(() => ok(ratingBody()));
    const verdict = await runtime({ area: memoryArea().area, fetchImpl: net.fetchImpl, supabaseUrl: undefined }).freshCheck("rating");
    expect(verdict).toEqual({ allowed: false, reason: "missing", revision: null });
    expect(net.calls).toHaveLength(0);
  });

  it("maps each extension build to its own surface", () => {
    expect(extensionPolicySurface(false)).toBe("chrome_desktop");
    expect(extensionPolicySurface(true)).toBe("firefox_desktop");
  });
});

describe("offline or failed means Off", () => {
  const failures: [string, () => Response | Promise<Response>][] = [
    ["network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["no policy (404)", () => new Response(null, { status: 404 })],
    ["storage unavailable (503)", () => new Response(null, { status: 503 })],
    ["malformed request (400)", () => new Response(null, { status: 400 })],
    ["a non-200 that carries an On body", () => new Response(ratingBody(), { status: 500 })],
    ["an empty 200", () => new Response(null, { status: 200 })],
  ];
  for (const [name, answer] of failures) {
    it(`rating is Off on ${name}`, async () => {
      const storage = memoryArea();
      const net = scriptedFetch(answer);
      const verdict = await runtime({ area: storage.area, fetchImpl: net.fetchImpl }).freshCheck("rating");
      expect(verdict.allowed).toBe(false);
      expect(storage.data.has(HIGHEST)).toBe(false);
    });
  }

  it("sales is Off and is never even requested while the compiled switch is off", async () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    const storage = memoryArea({ "still:productPolicy:sales:ordinary": { schema: 1, revision: 9, projection: { on: true }, lastSuccess: 1, highWater: 1 } });
    const net = scriptedFetch(() => ok(salesBody()));
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl });
    expect(await policy.freshCheck("sales")).toEqual({ allowed: false, reason: "compiled_off", revision: null });
    await policy.ordinary.sales.onOrdinaryOpen();
    expect(net.calls).toHaveLength(0);
  });

  it("is Off when the answer takes longer than five seconds, and the request is aborted", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const net = scriptedFetch(({ init }) => new Promise<Response>((_, reject) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = runtime({ area: memoryArea().area, fetchImpl: net.fetchImpl }).freshCheck("rating");
    await vi.advanceTimersByTimeAsync(PRODUCT_POLICY_TIMEOUT_MS);
    expect(await pending).toEqual({ allowed: false, reason: "missing", revision: null });
    expect(signal?.aborted).toBe(true);
  });

  it("is Off when a valid On arrives after the freshness window", async () => {
    const time = clock();
    const net = scriptedFetch(() => { time.advance(5000); return ok(ratingBody()); });
    const verdict = await runtime({ area: memoryArea().area, fetchImpl: net.fetchImpl, monotonicNow: time.now }).freshCheck("rating");
    expect(verdict).toEqual({ allowed: false, reason: "late", revision: null });
  });

  it("is Off for the wrong environment or a build not on the allowlist", async () => {
    const wrongEnvironment = scriptedFetch(() => ok(ratingBody({ environment: "sandbox" })));
    expect((await runtime({ area: memoryArea().area, fetchImpl: wrongEnvironment.fetchImpl }).freshCheck("rating")).reason).toBe("environment");
    const otherBuild = scriptedFetch(() => ok(ratingBody({ build: "9.9.9" })));
    expect(await runtime({ area: memoryArea().area, fetchImpl: otherBuild.fetchImpl }).freshCheck("rating"))
      .toEqual({ allowed: false, reason: "build", revision: 5 });
  });
});

describe("raw bytes, never decoded text", () => {
  it("judges a byte-order mark as invalid, exactly as StillKit does", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(ratingBody())]);
    const net = scriptedFetch(() => ok(bytes));
    expect((await runtime({ area: memoryArea().area, fetchImpl: net.fetchImpl }).freshCheck("rating")).reason).toBe("invalid");
  });

  it("stops reading one byte past the cap and calls the body oversized", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(4096).fill(0x20)); },
    });
    const res = await fetchProductPolicy({
      endpoint: ENDPOINT, namespace: "rating", environment: "production", monotonicNow: () => 1,
      fetchImpl: (async () => new Response(stream, { status: 200 })) as typeof fetch,
    });
    expect(res.body?.byteLength).toBe(8193);
    expect(pulled).toBeLessThanOrEqual(4);
    const net = scriptedFetch(() => ok(ratingBody() + " ".repeat(8192)));
    expect((await runtime({ area: memoryArea().area, fetchImpl: net.fetchImpl }).freshCheck("rating")).reason).toBe("oversized");
  });
});

describe("a fresh check never trusts the cache", () => {
  it("a cached On cannot authorize a rating request when the fresh check fails", async () => {
    const storage = memoryArea({
      [ORDINARY]: { schema: 1, revision: 9, projection: { on: true }, lastSuccess: 1_000, highWater: 1_000 },
      [HIGHEST]: 9,
    });
    const net = scriptedFetch(() => Promise.reject(new TypeError("offline")));
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl, wallNow: () => 2_000 });
    await policy.ordinary.rating.onOrdinaryOpen();
    // The advisory cache still shows the stored On...
    expect(policy.ordinary.rating.current()).toMatchObject({ status: "loaded", projection: { on: true }, revision: 9 });
    // ...and the fresh check, which is what a request needs, is Off.
    expect(await policy.freshCheck("rating")).toEqual({ allowed: false, reason: "missing", revision: null });
  });

  it("a cached On is ignored even when the fresh answer is a valid Off", async () => {
    const storage = memoryArea({ [ORDINARY]: { schema: 1, revision: 9, projection: { on: true }, lastSuccess: 1, highWater: 1 } });
    const net = scriptedFetch(() => ok(ratingBody({ revision: 10, master: false })));
    expect(await runtime({ area: storage.area, fetchImpl: net.fetchImpl }).freshCheck("rating"))
      .toEqual({ allowed: false, reason: "off", revision: 10 });
  });
});

describe("the revision fence", () => {
  it("persists the accepted revision as max(), and only after an accepted verdict", async () => {
    const storage = memoryArea();
    let body = ratingBody({ revision: 7 });
    const net = scriptedFetch(() => ok(body));
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl });
    expect(await policy.freshCheck("rating")).toEqual({ allowed: true, reason: "on", revision: 7 });
    expect(storage.data.get(HIGHEST)).toBe(7);

    body = ratingBody({ revision: 6 });
    expect(await policy.freshCheck("rating")).toEqual({ allowed: false, reason: "stale", revision: 6 });
    expect(storage.data.get(HIGHEST)).toBe(7);

    body = "{\"schema\":1}";
    expect((await policy.freshCheck("rating")).reason).toBe("invalid");
    expect(storage.data.get(HIGHEST)).toBe(7);

    body = ratingBody({ revision: 12, build: "9.9.9" });
    expect((await policy.freshCheck("rating")).reason).toBe("build");
    expect(storage.data.get(HIGHEST)).toBe(12);

    body = ratingBody({ revision: 12, master: false });
    expect((await policy.freshCheck("rating")).reason).toBe("off");
    expect(storage.data.get(HIGHEST)).toBe(12);
  });

  it("is Off without a request when the stored fence is unreadable", async () => {
    for (const bad of ["7", -1, 1.5, null, { revision: 7 }]) {
      const net = scriptedFetch(() => ok(ratingBody()));
      const verdict = await runtime({ area: memoryArea({ [HIGHEST]: bad }).area, fetchImpl: net.fetchImpl }).freshCheck("rating");
      expect(verdict.allowed).toBe(false);
      expect(net.calls).toHaveLength(0);
    }
  });

  it("an On whose fence cannot be written is Off", async () => {
    const storage = memoryArea();
    storage.state.failSet = true;
    const net = scriptedFetch(() => ok(ratingBody()));
    expect(await runtime({ area: storage.area, fetchImpl: net.fetchImpl }).freshCheck("rating"))
      .toEqual({ allowed: false, reason: "context", revision: null });
  });

  it("keeps the fence monotonic across concurrent checks", async () => {
    const storage = memoryArea();
    const revisions = [9, 4, 11, 2];
    const net = scriptedFetch(() => ok(ratingBody({ revision: revisions.shift()! })));
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl });
    await Promise.all([1, 2, 3, 4].map(() => policy.freshCheck("rating")));
    expect(storage.data.get(HIGHEST)).toBe(11);
  });
});

describe("nothing from a response is ever stored", () => {
  it("stores only the fence and the advisory record, never the body, headers or request", async () => {
    const storage = memoryArea();
    const body = ratingBody({ revision: 8 });
    const net = scriptedFetch(() => new Response(body, { status: 200, headers: { "content-type": "application/json", etag: "\"marker-etag\"" } }));
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl, wallNow: () => 50_000 });
    await policy.ordinary.rating.onOrdinaryOpen();
    await policy.freshCheck("rating");
    const stored = storage.dump();
    for (const key of Object.keys(stored)) expect(PRODUCT_POLICY_STORAGE_KEYS).toContain(key);
    expect(stored).toEqual({
      [HIGHEST]: 8,
      [ORDINARY]: { schema: 1, revision: 8, projection: { on: true }, lastSuccess: 50_000, highWater: 50_000 },
    });
    const serialized = JSON.stringify(storage.writes);
    for (const marker of [body, "builds", "environment", "surfaces", "chrome_desktop", "marker-etag", "namespace", "requestStartedAt"]) {
      expect(serialized).not.toContain(marker);
    }
  });
});

describe("the ordinary cache over chrome.storage.local", () => {
  it("checks once on an ordinary open and then respects its six-hour spacing", async () => {
    const storage = memoryArea();
    let wall = 1_000_000;
    const net = scriptedFetch(() => ok(ratingBody({ revision: 3 })));
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl, wallNow: () => wall });
    await policy.ordinary.rating.onOrdinaryOpen();
    expect(policy.ordinary.rating.current()).toMatchObject({ status: "loaded", revision: 3, projection: { on: true } });
    wall += 60_000;
    await policy.ordinary.rating.onOrdinaryOpen();
    expect(net.calls).toHaveLength(1);
  });

  it("treats a malformed stored record as unreadable and never overwrites it", async () => {
    const storage = memoryArea({ [ORDINARY]: { schema: 1, revision: 3, projection: { on: "yes" }, lastSuccess: 1, highWater: 1 } });
    const net = scriptedFetch(() => ok(ratingBody()));
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl });
    await policy.ordinary.rating.onOrdinaryOpen();
    expect(policy.ordinary.rating.current().status).toBe("unreadable");
    expect(storage.data.get(ORDINARY)).toEqual({ schema: 1, revision: 3, projection: { on: "yes" }, lastSuccess: 1, highWater: 1 });
    expect(net.calls).toHaveLength(0);
  });

  it("does not commit after it is stopped mid-check", async () => {
    const storage = memoryArea();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const net = scriptedFetch(async () => { await gate; return ok(ratingBody()); });
    const policy = runtime({ area: storage.area, fetchImpl: net.fetchImpl });
    const open = policy.ordinary.rating.onOrdinaryOpen();
    await Promise.resolve();
    policy.ordinary.rating.stop();
    release();
    await open;
    expect(storage.data.has(ORDINARY)).toBe(false);
  });
});

// Static guards over the shipped extension sources.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (["node_modules", "dist", ".wxt", ".output", "__tests__", "public"].includes(name)) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|svelte|js)$/.test(name) ? [path] : [];
  });
}

describe("dormant, background-only and never on a free path", () => {
  it("is imported by no extension source: no background wiring, content script, page or Restore path", () => {
    const users = [...sources(join(root, "entrypoints")), ...sources(join(root, "lib"))]
      .filter(path => !path.endsWith("product-policy-runtime.ts"))
      .filter(path => /product-policy|ProductPolicy|evaluateSalesPolicy|evaluateRatingPolicy/.test(readFileSync(path, "utf8")))
      .map(path => relative(root, path));
    expect(users).toEqual([]);
  });

  it("schedules nothing and reads no identity", () => {
    const source = readFileSync(join(root, "lib", "product-policy-runtime.ts"), "utf8");
    const code = source.split("\n").filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/**")).join("\n");
    for (const forbidden of ["alarms", "setInterval", "onMessage", "runtime.id", "auth-storage", "session", "Authorization", "apikey",
      "anonKey", "installId", "accountId", "deviceId", "posthog", "storage.sync", "storage.session"]) {
      expect(code).not.toContain(forbidden);
    }
    // Exactly one timer: the five-second request limit.
    expect(code.match(/setTimeout\(/g)).toHaveLength(1);
  });
});
