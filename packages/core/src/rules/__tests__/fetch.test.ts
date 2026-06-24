import { describe, it, expect } from "vitest";
import seed from "../../../rules/seed.json";
import type { SignedRuleSet } from "@still/shared-types";
import { fetchCurrentRuleSet, resolveRuleSet } from "../fetch.js";
import { signRuleSet } from "../signature.js";
import { DEV_RULE_SET_KEYS } from "../trusted-keys.js";

const DEV_PRIV = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const bundled = seed as unknown as SignedRuleSet;

async function signedRow(version: string, services: unknown = bundled.services) {
  const set = await signRuleSet({ version, services } as never, DEV_PRIV, "still-dev-1");
  return { set, row: { version, payload: { version, services: set.services }, signature: set.signature } };
}

function okFetch(body: string): typeof fetch {
  return (() => Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;
}
function failFetch(): typeof fetch {
  return (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
}

function cfg(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return {
    endpoint: { url: "http://local", anonKey: "anon" },
    allowedKeys: DEV_RULE_SET_KEYS,
    minVersion: "1.0.0",
    fetchImpl,
    ...over,
  };
}

describe("fetchCurrentRuleSet", () => {
  it("fetches + verifies a newer valid signed set", async () => {
    const { row } = await signedRow("1.1.0");
    const got = await fetchCurrentRuleSet(cfg(okFetch(JSON.stringify([row]))));
    expect(got?.version).toBe("1.1.0");
  });

  it("returns null when offline (→ bundled fallback, AE3)", async () => {
    const got = await fetchCurrentRuleSet(cfg(failFetch()));
    expect(got).toBeNull();
    expect(resolveRuleSet({ bundled, cached: null, fetched: got }).source).toBe("bundled");
  });

  it("rejects a malformed set (missing version)", async () => {
    const { set } = await signedRow("1.1.0");
    const row = { version: "1.1.0", payload: { services: set.services }, signature: set.signature };
    expect(await fetchCurrentRuleSet(cfg(okFetch(JSON.stringify([row]))))).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const { set } = await signedRow("1.1.0");
    const bad = { ...set.signature, value: set.signature.value.replace(/.$/, set.signature.value.endsWith("0") ? "1" : "0") };
    const row = { version: "1.1.0", payload: { version: "1.1.0", services: set.services }, signature: bad };
    expect(await fetchCurrentRuleSet(cfg(okFetch(JSON.stringify([row]))))).toBeNull();
  });

  it("rejects an unknown signing kid", async () => {
    const { set } = await signedRow("1.1.0");
    const row = { version: "1.1.0", payload: { version: "1.1.0", services: set.services }, signature: { ...set.signature, kid: "rogue-key" } };
    expect(await fetchCurrentRuleSet(cfg(okFetch(JSON.stringify([row]))))).toBeNull();
  });

  it("rejects a validly-signed set below the version floor", async () => {
    const { row } = await signedRow("0.9.0");
    expect(await fetchCurrentRuleSet(cfg(okFetch(JSON.stringify([row])), { minVersion: "1.0.0" }))).toBeNull();
  });

  it("rejects an oversized payload", async () => {
    const { set } = await signedRow("1.1.0");
    const row = { version: "1.1.0", payload: { version: "1.1.0", services: set.services }, signature: set.signature, pad: "x".repeat(300 * 1024) };
    expect(await fetchCurrentRuleSet(cfg(okFetch(JSON.stringify([row]))))).toBeNull();
  });

  it("rejects a payload with an unsafe (url()) selector", async () => {
    const services = JSON.parse(JSON.stringify(bundled.services));
    services.youtube.surfaces[1].selectors.push('a[style="background:url(//evil)"]');
    const { row } = await signedRow("1.1.0", services);
    expect(await fetchCurrentRuleSet(cfg(okFetch(JSON.stringify([row]))))).toBeNull();
  });
});

describe("resolveRuleSet", () => {
  it("adopts a newer fetched set", async () => {
    const { set } = await signedRow("2.0.0");
    expect(resolveRuleSet({ bundled, cached: null, fetched: set }).source).toBe("fetched");
  });

  it("ignores an older fetched set (keeps bundled)", async () => {
    const { set } = await signedRow("0.9.0");
    const r = resolveRuleSet({ bundled, cached: null, fetched: set });
    expect(r.source).toBe("bundled");
    expect(r.ruleSet.version).toBe("1.0.0");
  });

  it("uses a newer cached set when there is no fetch", async () => {
    const { set } = await signedRow("1.5.0");
    expect(resolveRuleSet({ bundled, cached: set, fetched: null }).source).toBe("cached");
  });
});
