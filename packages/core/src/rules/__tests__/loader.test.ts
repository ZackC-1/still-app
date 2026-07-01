import { describe, it, expect } from "vitest";
import { signRuleSet } from "../signature.js";
import { DEV_RULE_SET_KEYS, PRODUCTION_RULE_SET_KEYS } from "../trusted-keys.js";
import type { FetchConfig } from "../fetch.js";
import type { SignedRuleSet } from "@still/shared-types";
import seed from "../../../rules/seed.json";
import {
  ruleSetTrustedKeys,
  ruleSetFetchConfig,
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
});

describe("rule-set cache", () => {
  it("round-trips a stored set", async () => {
    const area = memArea();
    const set = await signedAt("2.0.0");
    await writeCachedRuleSet(area, set);
    expect((await readCachedRuleSet(area))?.version).toBe("2.0.0");
  });

  it("returns null when nothing is cached", async () => {
    expect(await readCachedRuleSet(memArea())).toBeNull();
  });

  it("a write failure is swallowed (bundled seed still applies)", async () => {
    const failing = { set: () => Promise.reject(new Error("quota")) };
    await expect(writeCachedRuleSet(failing, bundled)).resolves.toBeUndefined();
  });
});

describe("refreshRuleSetCache", () => {
  it("fetches, verifies, and caches a newer signed set", async () => {
    const area = memArea();
    const newer = await signedAt("2.0.0");
    const got = await refreshRuleSetCache(cfgWith(fetchReturning(newer)), area);
    expect(got?.version).toBe("2.0.0");
    expect((await readCachedRuleSet(area))?.version).toBe("2.0.0");
  });

  it("a tampered/unverifiable response is not cached (null)", async () => {
    const area = memArea();
    const valid = await signedAt("2.0.0");
    const tampered = { ...valid, version: "2.0.1" }; // signature is for 2.0.0 → mismatch
    const got = await refreshRuleSetCache(cfgWith(fetchReturning(tampered)), area);
    expect(got).toBeNull();
    expect(await readCachedRuleSet(area)).toBeNull();
  });

  it("a null config (no endpoint / prod w/o keys) is a no-op", async () => {
    const area = memArea();
    expect(await refreshRuleSetCache(null, area)).toBeNull();
    expect(area.store.size).toBe(0);
  });
});

describe("resolveRuleSetForLoad", () => {
  it("uses a newer cached set over the bundled seed", async () => {
    const area = memArea();
    await writeCachedRuleSet(area, await signedAt("9.9.9"));
    const { ruleSet, source } = await resolveRuleSetForLoad(bundled, area);
    expect(source).toBe("cached");
    expect(ruleSet.version).toBe("9.9.9");
  });

  it("falls back to the bundled seed when nothing is cached", async () => {
    const { ruleSet, source } = await resolveRuleSetForLoad(bundled, memArea());
    expect(source).toBe("bundled");
    expect(ruleSet.version).toBe(bundled.version);
  });

  it("ignores an older cached set (rollback floor of the bundled seed)", async () => {
    const area = memArea();
    await writeCachedRuleSet(area, await signedAt("0.9.0"));
    const { source } = await resolveRuleSetForLoad(bundled, area);
    expect(source).toBe("bundled"); // bundled 1.0.0 > cached 0.9.0
  });
});
