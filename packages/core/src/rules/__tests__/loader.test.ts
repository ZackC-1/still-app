import { describe, it, expect, vi } from "vitest";
import { signRuleSet } from "../signature.js";
import { DEV_RULE_SET_KEYS, PRODUCTION_RULE_SET_KEYS } from "../trusted-keys.js";
import type { FetchConfig } from "../fetch.js";
import type { SignedRuleSet } from "@still/shared-types";
import seed from "../../../rules/seed.json";
import {
  ruleSetTrustedKeys,
  ruleSetTrust,
  ruleSetFetchConfig,
  createRuleSetRefresher,
  readCachedRuleSet,
  writeCachedRuleSet,
  refreshRuleSetCache,
  resolveRuleSetForLoad,
} from "../loader.js";

// The fixed throwaway dev private key (scripts/sign-seed.mjs) whose public half is DEV_RULE_SET_KEYS.
const DEV_PRIVATE_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KID = "still-dev-1";
const bundled = seed as unknown as SignedRuleSet;

/** A signed rule set at `version`, reusing the seed's (schema-valid) services. */
async function signedAt(version: string): Promise<SignedRuleSet> {
  return signRuleSet({ version, services: bundled.services }, DEV_PRIVATE_KEY_HEX, KID);
}

/** A fetchImpl that returns the given signed set as the Supabase RPC row shape. */
function fetchReturning(set: SignedRuleSet): typeof fetch {
  const row = [{ payload: { version: set.version, services: set.services }, signature: set.signature }];
  return (() => Promise.resolve(new Response(JSON.stringify(row), { status: 200 }))) as typeof fetch;
}

function memArea() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: (key: string) => Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
    set: (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      return Promise.resolve();
    },
  };
}

const endpoint = { url: "https://test.supabase.co", anonKey: "anon-key" };
const cfgWith = (fetchImpl: typeof fetch): FetchConfig => ({
  endpoint,
  allowedKeys: DEV_RULE_SET_KEYS,
  minVersion: "1.0.0",
  fetchImpl,
});
// The dev-build trust anchor used by the read/load paths in these tests.
const DEV_TRUST = { allowedKeys: DEV_RULE_SET_KEYS, minVersion: "1.0.0" } as const;

describe("rule-set build gating", () => {
  const DEV_KIDS = DEV_RULE_SET_KEYS.map((k) => k.kid);

  it("a dev build trusts the dev key", () => {
    expect(ruleSetTrustedKeys(false)).toBe(DEV_RULE_SET_KEYS);
    expect(ruleSetTrustedKeys(false).length).toBeGreaterThan(0);
  });

  it("a prod build trusts the production keys and NEVER the dev key", () => {
    expect(ruleSetTrustedKeys(true)).toBe(PRODUCTION_RULE_SET_KEYS);
    // The security invariant: the dev signing key must never be accepted in a production build,
    // regardless of whether production keys have been published yet.
    for (const kid of DEV_KIDS) {
      expect(ruleSetTrustedKeys(true).some((k) => k.kid === kid)).toBe(false);
    }
  });

  it("no fetch config without an endpoint (CI/dev with no .env)", () => {
    expect(ruleSetFetchConfig({ prod: false, endpoint: null })).toBeNull();
  });

  it("a dev build with an endpoint yields a usable fetch config (dev keys)", () => {
    const cfg = ruleSetFetchConfig({ prod: false, endpoint });
    expect(cfg).not.toBeNull();
    expect(cfg!.allowedKeys).toBe(DEV_RULE_SET_KEYS);
    expect(cfg!.minVersion).toBe("1.0.0");
  });

  it("a prod build with an endpoint fetches against the production keys", () => {
    // Production keys are published (PRODUCTION_RULE_SET_KEYS non-empty), so a prod build builds a
    // fetch config trusting only those. (When prod keys were empty, this returned null — the bundled
    // seed fail-safe, still enforced by the length===0 guard in ruleSetFetchConfig.)
    const cfg = ruleSetFetchConfig({ prod: true, endpoint });
    expect(cfg).not.toBeNull();
    expect(cfg!.allowedKeys).toBe(PRODUCTION_RULE_SET_KEYS);
  });

  it("captures one endpoint/configuration for repeated background refreshes", async () => {
    const area = memArea();
    const refresh = createRuleSetRefresher({
      prod: false,
      url: "",
      anonKey: "",
      area,
    });
    await expect(refresh()).resolves.toBeNull();
    await expect(refresh()).resolves.toBeNull();
    expect(area.store.size).toBe(0);
  });

  it("captures a configured fetcher and caches its verified response on every invocation", async () => {
    const area = memArea();
    const fetched = await signedAt("2.0.0");
    const fetchImpl = vi.fn(fetchReturning(fetched));
    const refresh = createRuleSetRefresher({
      prod: false,
      url: endpoint.url,
      anonKey: endpoint.anonKey,
      area,
      fetchImpl,
    });

    await expect(refresh()).resolves.toMatchObject({ version: "2.0.0" });
    await expect(refresh()).resolves.toMatchObject({ version: "2.0.0" });
    expect((await readCachedRuleSet(area, DEV_TRUST))?.version).toBe("2.0.0");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://test.supabase.co/rest/v1/rpc/get_current_rule_set",
      expect.objectContaining({ headers: expect.objectContaining({ apikey: "anon-key" }) }),
    );
  });
});

describe("rule-set cache", () => {
  it("round-trips a stored set", async () => {
    const area = memArea();
    const set = await signedAt("2.0.0");
    await writeCachedRuleSet(area, set);
    expect((await readCachedRuleSet(area, DEV_TRUST))?.version).toBe("2.0.0");
  });

  it("returns null when nothing is cached", async () => {
    expect(await readCachedRuleSet(memArea(), DEV_TRUST)).toBeNull();
  });

  it("a write failure is swallowed (bundled seed still applies)", async () => {
    const failing = { set: () => Promise.reject(new Error("quota")) };
    await expect(writeCachedRuleSet(failing, bundled)).resolves.toBeUndefined();
  });

  // Storage outlives builds: the read path must re-verify, not trust verified-before-store.
  it("rejects a cached set whose key this build does not trust (dev cache in a prod build)", async () => {
    const area = memArea();
    await writeCachedRuleSet(area, await signedAt("9.9.9")); // dev-signed
    expect(await readCachedRuleSet(area, ruleSetTrust(true))).toBeNull();
  });

  it("rejects a tampered cached set (signature no longer matches)", async () => {
    const area = memArea();
    const valid = await signedAt("2.0.0");
    await writeCachedRuleSet(area, { ...valid, version: "2.0.1" });
    expect(await readCachedRuleSet(area, DEV_TRUST)).toBeNull();
  });

  it("rejects a schema-invalid cached blob", async () => {
    const area = memArea();
    area.store.set("still:ruleset", { version: "9.9.9", services: "not-an-object" });
    expect(await readCachedRuleSet(area, DEV_TRUST)).toBeNull();
  });

  it("rejects a cached set below this build's version floor", async () => {
    const area = memArea();
    await writeCachedRuleSet(area, await signedAt("0.9.0"));
    expect(await readCachedRuleSet(area, DEV_TRUST)).toBeNull(); // floor is 1.0.0
  });
});

describe("refreshRuleSetCache", () => {
  it("fetches, verifies, and caches a newer signed set", async () => {
    const area = memArea();
    const newer = await signedAt("2.0.0");
    const got = await refreshRuleSetCache(cfgWith(fetchReturning(newer)), area);
    expect(got?.version).toBe("2.0.0");
    expect((await readCachedRuleSet(area, DEV_TRUST))?.version).toBe("2.0.0");
  });

  it("a tampered/unverifiable response is not cached (null)", async () => {
    const area = memArea();
    const valid = await signedAt("2.0.0");
    const tampered = { ...valid, version: "2.0.1" }; // signature is for 2.0.0 → mismatch
    const got = await refreshRuleSetCache(cfgWith(fetchReturning(tampered)), area);
    expect(got).toBeNull();
    expect(await readCachedRuleSet(area, DEV_TRUST)).toBeNull();
  });

  it("a null config (no endpoint / prod w/o keys) is a no-op", async () => {
    const area = memArea();
    expect(await refreshRuleSetCache(null, area)).toBeNull();
    expect(area.store.size).toBe(0);
  });

  // A rollback / stale deployment must not clobber a newer cached hotfix.
  it("keeps a strictly newer cached set when the endpoint serves an older one", async () => {
    const area = memArea();
    await writeCachedRuleSet(area, await signedAt("3.0.0"));
    const older = await signedAt("2.0.0");
    const got = await refreshRuleSetCache(cfgWith(fetchReturning(older)), area);
    expect(got?.version).toBe("2.0.0"); // fetch itself succeeded…
    expect((await readCachedRuleSet(area, DEV_TRUST))?.version).toBe("3.0.0"); // …but the cache kept the hotfix
  });

  it("replaces an older cache with a newer fetched set", async () => {
    const area = memArea();
    await writeCachedRuleSet(area, await signedAt("2.0.0"));
    const newer = await signedAt("3.0.0");
    await refreshRuleSetCache(cfgWith(fetchReturning(newer)), area);
    expect((await readCachedRuleSet(area, DEV_TRUST))?.version).toBe("3.0.0");
  });

  // R6 single-flight: N tabs navigating at once must share ONE fetch+verify+write pass.
  it("single-flights concurrent refreshes: one fetch shared by both callers, then a fresh slot", async () => {
    const area = memArea();
    const set = await signedAt("2.0.0");
    // A fetchImpl gated on a controllable promise, counting invocations — both concurrent calls
    // must land while the first fetch is provably still in flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let fetches = 0;
    const gatedFetch = (async () => {
      fetches++;
      await gate;
      const row = [{ payload: { version: set.version, services: set.services }, signature: set.signature }];
      return new Response(JSON.stringify(row), { status: 200 });
    }) as typeof fetch;
    const cfg = cfgWith(gatedFetch);

    const first = refreshRuleSetCache(cfg, area);
    const second = refreshRuleSetCache(cfg, area); // joins the in-flight refresh
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(fetches).toBe(1); // ONE network pass for the burst
    expect(a?.version).toBe("2.0.0");
    expect(b).toBe(a); // the same shared result, not a parallel re-fetch
    expect((await readCachedRuleSet(area, DEV_TRUST))?.version).toBe("2.0.0");

    // The slot cleared on settle: a later refresh fetches fresh (release() already ran, so the
    // gate is open for it).
    const third = await refreshRuleSetCache(cfg, area);
    expect(fetches).toBe(2);
    expect(third?.version).toBe("2.0.0");
  });
});

describe("resolveRuleSetForLoad", () => {
  it("uses a newer cached set over the bundled seed", async () => {
    const area = memArea();
    await writeCachedRuleSet(area, await signedAt("9.9.9"));
    const { ruleSet, source } = await resolveRuleSetForLoad(bundled, area, DEV_TRUST);
    expect(source).toBe("cached");
    expect(ruleSet.version).toBe("9.9.9");
  });

  it("falls back to the bundled seed when nothing is cached", async () => {
    const { ruleSet, source } = await resolveRuleSetForLoad(bundled, memArea(), DEV_TRUST);
    expect(source).toBe("bundled");
    expect(ruleSet.version).toBe(bundled.version);
  });

  it("ignores an older cached set (rollback floor of the bundled seed)", async () => {
    const area = memArea();
    await writeCachedRuleSet(area, await signedAt("0.9.0"));
    const { source } = await resolveRuleSetForLoad(bundled, area, DEV_TRUST);
    expect(source).toBe("bundled"); // bundled 1.0.0 > cached 0.9.0
  });

  it("falls back to the bundled seed when the cache fails this build's trust anchor", async () => {
    const area = memArea();
    await writeCachedRuleSet(area, await signedAt("9.9.9")); // dev-signed, higher version
    const { ruleSet, source } = await resolveRuleSetForLoad(bundled, area, ruleSetTrust(true));
    expect(source).toBe("bundled"); // a prod build never applies a dev-signed cache
    expect(ruleSet.version).toBe(bundled.version);
  });
});

// The failure half of the single-flight contract: a fetch that dies mid-flight must resolve (not
// reject) for every joiner — fetchCurrentRuleSet swallows network errors to null — and must not
// wedge the slot: the next burst gets a fresh fetch.
it("a failed shared refresh resolves null for all joiners and never wedges the slot", async () => {
  const area = memArea();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let fetches = 0;
  const failingFetch = (async () => {
    fetches++;
    await gate;
    throw new Error("network down");
  }) as typeof fetch;
  const cfg = cfgWith(failingFetch);

  const first = refreshRuleSetCache(cfg, area);
  const second = refreshRuleSetCache(cfg, area); // joins the doomed in-flight refresh
  release();
  const [a, b] = await Promise.all([first, second]); // resolves — never an unhandled rejection
  expect(fetches).toBe(1);
  expect(a).toBeNull();
  expect(b).toBeNull();
  expect(await readCachedRuleSet(area, DEV_TRUST)).toBeNull(); // nothing was cached

  // Slot cleared despite the failure: the next call runs a fresh fetch.
  expect(await refreshRuleSetCache(cfg, area)).toBeNull();
  expect(fetches).toBe(2);
});
