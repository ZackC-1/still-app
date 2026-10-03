import { describe, expect, it } from "vitest";
import {
  readCachedRuleSet,
  resolveRuleSetForLoad,
  writeCachedRuleSet,
  refreshRuleSetCache,
} from "../loader.js";
import { fetchCurrentRuleSet } from "../fetch.js";
import { DEV_RULE_SET_KEYS } from "../trusted-keys.js";
import { signRuleSetV2 } from "../signature.js";
import { ruleSet } from "./format2-fixtures.js";
const key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const trust = {
  allowedKeys: DEV_RULE_SET_KEYS,
  minVersion: "1.0.0",
  format: 2 as const,
};
function area() {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: async (key: string) => ({ [key]: values[key] }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items));
    },
  };
}
async function signed(version: string) {
  return signRuleSetV2(
    { format: 2, version, services: ruleSet.services },
    key,
    "still-dev-1",
  );
}
describe("maintained format2 load admission", () => {
  it("re-verifies a newer format2 cache through the existing loader and resolves its immutable snapshot", async () => {
    const storage = area();
    const bundled = await signed("3.0.0");
    const newer = await signed("3.1.0");
    await writeCachedRuleSet(storage, newer);
    const resolved = await resolveRuleSetForLoad(bundled, storage, trust);
    expect(resolved.source).toBe("cached");
    expect(resolved.ruleSet.version).toBe("3.1.0");
    expect(resolved.ruleSet).not.toBe(newer);
    expect(Object.keys(storage.values)).toEqual(["still:ruleset:format2"]);
  });
  it("rejects unsigned/mutated format2 cache and preserves the packaged offline fallback", async () => {
    const storage = area();
    const bundled = await signed("3.0.0");
    const bad = await signed("9.0.0");
    storage.values["still:ruleset:format2"] = { ...bad, version: "9.1.0" };
    expect(await readCachedRuleSet(storage, trust)).toBeNull();
    expect(await resolveRuleSetForLoad(bundled, storage, trust)).toMatchObject({
      source: "bundled",
      ruleSet: { format: 2, version: "3.0.0" },
    });
  });
  it("keeps format namespaces separate and enforces the current key and version floor", async () => {
    const storage = area();
    const newer = await signed("3.1.0");
    storage.values["still:ruleset"] = newer;
    expect(await readCachedRuleSet(storage, trust)).toBeNull();
    await writeCachedRuleSet(storage, newer);
    expect(
      await readCachedRuleSet(storage, { ...trust, allowedKeys: [] }),
    ).toBeNull();
    expect(
      await readCachedRuleSet(storage, { ...trust, minVersion: "4.0.0" }),
    ).toBeNull();
    storage.values["still:ruleset:format2"] = {
      ...newer,
      signature: { ...newer.signature, kid: "unknown" },
    };
    expect(await readCachedRuleSet(storage, trust)).toBeNull();
  });
  it("snapshots the packaged input before an asynchronous storage wait", async () => {
    const bundled = structuredClone(await signed("3.0.0"));
    let release!: () => void;
    const pending = resolveRuleSetForLoad(
      bundled,
      {
        get: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {};
        },
      },
      trust,
    );
    Object.assign(bundled, { version: "99.0.0" });
    const surface = bundled.services.youtube!.surfaces[0]!;
    if (surface.action === "hide")
      Object.assign(surface, { selectors: [...surface.selectors, ".unverified-mutation"] });
    release();
    const result = await pending;
    expect(result.ruleSet.version).toBe("3.0.0");
    const admitted = result.ruleSet.services.youtube!.surfaces[0]!;
    expect(admitted.action).toBe("hide");
    if (admitted.action === "hide")
      expect(admitted.selectors).not.toContain(".unverified-mutation");
  });
  it("unavailable cache remains an offline packaged fallback without a network dependency", async () => {
    const bundled = await signed("3.0.0");
    expect(
      await resolveRuleSetForLoad(
        bundled,
        {
          get: async () => {
            throw new Error("unavailable");
          },
        },
        trust,
      ),
    ).toMatchObject({ source: "bundled", ruleSet: { version: "3.0.0" } });
  });
  it("admits format2 over the same capped signed fetch transport; default format1 rejects it", async () => {
    const set = await signed("3.1.0");
    const { signature, ...payload } = set;
    const cfg = {
      ...trust,
      endpoint: { url: "https://fixture.invalid", anonKey: "fixture" },
      fetchImpl: async () =>
        new Response(JSON.stringify([{ payload, signature }])),
    };
    expect((await fetchCurrentRuleSet(cfg))?.version).toBe("3.1.0");
    expect(await fetchCurrentRuleSet({ ...cfg, format: 1 })).toBeNull();
    expect(await fetchCurrentRuleSet({ ...cfg, maxBytes: 20 })).toBeNull();
    expect(await fetchCurrentRuleSet({ ...cfg, allowedKeys: [] })).toBeNull();
  });
  it("shares one format2 flight without borrowing an active legacy flight or its cache", async () => {
    const set = await signed("3.1.0");
    const { signature, ...payload } = set;
    const storage = area();
    let release!: () => void;
    let requests = 0;
    const legacy = refreshRuleSetCache(
      {
        ...trust,
        format: 1,
        endpoint: { url: "https://fixture.invalid", anonKey: "fixture" },
        fetchImpl: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return new Response("{}");
        },
      },
      storage,
    );
    const cfg = {
      ...trust,
      endpoint: { url: "https://fixture.invalid", anonKey: "fixture" },
      fetchImpl: async () => {
        requests++;
        return new Response(JSON.stringify([{ payload, signature }]));
      },
    };
    const modern = refreshRuleSetCache(cfg, storage);
    const concurrent = refreshRuleSetCache(cfg, storage);
    expect(concurrent).toBe(modern);
    expect((await modern)?.version).toBe("3.1.0");
    expect(requests).toBe(1);
    release();
    expect(await legacy).toBeNull();
    expect(Object.keys(storage.values)).toEqual(["still:ruleset:format2"]);
    await refreshRuleSetCache(cfg, storage);
    expect(requests).toBe(2);
  });
});
