import { describe, expect, expectTypeOf, it } from "vitest";
import type { SignedRuleSet, SignedRuleSetV2 } from "@still/shared-types";
import { fetchCurrentRuleSet, type FetchConfig } from "../fetch.js";
import {
  createRuleSetRefresher,
  readCachedRuleSet,
  ruleSetFetchConfig,
  ruleSetTrust,
  type RuleSetTrust,
} from "../loader.js";
import { signRuleSetV2 } from "../signature.js";
import { DEV_RULE_SET_KEYS } from "../trusted-keys.js";
import seed from "../../../rules/seed.json";
import { ruleSet } from "./format2-fixtures.js";

const endpoint = { url: "https://fixture.invalid", anonKey: "fixture" };
const anchor = { allowedKeys: DEV_RULE_SET_KEYS, minVersion: "1.0.0" };
const legacyConfig = { ...anchor, endpoint };
const storage = () => {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: async (key: string) => ({ [key]: values[key] }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items));
    },
  };
};

// The normal core typecheck checks these calls; do not execute their transport operations.
function compileTimeContracts() {
  const area = storage();
  // @ts-expect-error Format2 admission must declare its discriminator.
  const missingFetch: FetchConfig<2> = legacyConfig;
  // @ts-expect-error Format2 cache trust must declare its discriminator.
  const missingTrust: RuleSetTrust<2> = anchor;
  // @ts-expect-error Explicit result format cannot exceed the actual fetch lane.
  void fetchCurrentRuleSet<2>(legacyConfig);
  // @ts-expect-error Explicit result format cannot exceed the actual cache lane.
  void readCachedRuleSet<2>(area, anchor);
  // @ts-expect-error Format2 config constructors require the discriminator.
  ruleSetFetchConfig<2>({ prod: false, endpoint });
  // @ts-expect-error Format2 refresher constructors require the discriminator.
  createRuleSetRefresher<2>({
    prod: false,
    url: endpoint.url,
    anonKey: endpoint.anonKey,
    area,
  });
  // @ts-expect-error Format2 trust constructors require an explicit format argument.
  ruleSetTrust<2>(false);
  // @ts-expect-error Undefined cannot stand in for the format2 discriminator.
  ruleSetTrust<2>(false, undefined);
  void [missingFetch, missingTrust];
  expectTypeOf(fetchCurrentRuleSet(legacyConfig)).toEqualTypeOf<
    Promise<SignedRuleSet | null>
  >();
  expectTypeOf(
    fetchCurrentRuleSet({ ...legacyConfig, format: 2 }),
  ).toEqualTypeOf<Promise<SignedRuleSetV2 | null>>();
  expectTypeOf(
    ruleSetFetchConfig({ prod: false, endpoint, format: 2 }),
  ).toEqualTypeOf<FetchConfig<2> | null>();
  expectTypeOf(ruleSetTrust(false)).toEqualTypeOf<RuleSetTrust<1>>();
  expectTypeOf(ruleSetTrust(false, 2)).toEqualTypeOf<RuleSetTrust<2>>();
  expectTypeOf(
    createRuleSetRefresher({
      prod: false,
      url: endpoint.url,
      anonKey: endpoint.anonKey,
      area,
      format: 2,
    }),
  ).toEqualTypeOf<() => Promise<SignedRuleSetV2 | null>>();
}
void compileTimeContracts;

describe("format constructor and actual signed-lane contracts", () => {
  it("preserves omitted legacy inference and admits only its signed format through both constructors", async () => {
    const modern = await signRuleSetV2(
      { format: 2, version: "3.1.0", services: ruleSet.services },
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      "still-dev-1",
    );
    const legacy = seed as unknown as SignedRuleSet;
    const response = (set: SignedRuleSet | SignedRuleSetV2) => {
      const { signature, ...payload } = set;
      return async () => new Response(JSON.stringify([{ payload, signature }]));
    };
    const legacyCfg = ruleSetFetchConfig({ prod: false, endpoint })!;
    const modernCfg = ruleSetFetchConfig({ prod: false, endpoint, format: 2 })!;
    expect(legacyCfg).not.toHaveProperty("format");
    expect(
      (await fetchCurrentRuleSet({ ...legacyCfg, fetchImpl: response(legacy) }))
        ?.version,
    ).toBe(legacy.version);
    expect(
      await fetchCurrentRuleSet({ ...modernCfg, fetchImpl: response(legacy) }),
    ).toBeNull();
    expect(
      await fetchCurrentRuleSet({ ...legacyCfg, fetchImpl: response(modern) }),
    ).toBeNull();
    expect(
      await fetchCurrentRuleSet({ ...modernCfg, fetchImpl: response(modern) }),
    ).toMatchObject({ format: 2, version: "3.1.0" });
    for (const format of [1, 2] as const) {
      const area = storage();
      const set = format === 2 ? modern : legacy;
      const refresh = createRuleSetRefresher({
        prod: false,
        url: endpoint.url,
        anonKey: endpoint.anonKey,
        area,
        format,
        fetchImpl: response(set),
      });
      expect((await refresh())?.version).toBe(set.version);
      expect(Object.keys(area.values)).toEqual([
        format === 2 ? "still:ruleset:format2" : "still:ruleset",
      ]);
      expect(
        (await readCachedRuleSet(area, ruleSetTrust(false, format)))?.version,
      ).toBe(set.version);
    }
  });
});
