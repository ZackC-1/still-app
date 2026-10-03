import { beforeAll, describe, expect, it } from "vitest";
import { FEATURE_REGISTRY, SERVICE_IDS, TIKTOK_ALIAS } from "@still/shared-types";
import type { RuleSetPayloadV2, SignedRuleSet } from "@still/shared-types";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as ed from "@noble/ed25519";
import seed from "../../../rules/seed.json";
import {
  canonicalize, ruleSetSigningBytes, ruleSetSigningBytesV2,
  validateRuleSet, validateRuleSetV2, signRuleSetV2, verifyRuleSetV2, publicKeyHexFor,
} from "../index.js";
import { fetchCurrentRuleSet } from "../fetch.js";
import { readCachedRuleSet, ruleSetTrust } from "../loader.js";

const privateKey = "0f".repeat(32);
const kid = "format2-test";
let options: { allowedKeys: { kid: string; publicKeyHex: string }[]; minVersion: string };
beforeAll(async () => {
  options = { allowedKeys: [{ kid, publicKeyHex: await publicKeyHexFor(privateKey) }], minVersion: "1.0.0" };
});

function payload(): RuleSetPayloadV2 {
  return {
    format: 2, version: "1.0.0",
    services: Object.fromEntries(SERVICE_IDS.map((service) => [service, {
      matches: [`*://*.${service}.com/*`],
      surfaces: service === TIKTOK_ALIAS.service
        ? [{ id: "tk-block", feature: TIKTOK_ALIAS.id, action: "blockSite" }]
        : FEATURE_REGISTRY.filter((f) => f.service === service).map((f) => ({
          id: `${f.id}-fixture`, feature: f.id, action: "hide", selectors: [".synthetic-owned-target"],
        })),
    }])),
  } as RuleSetPayloadV2;
}
function unsignedShape(): any {
  return { ...payload(), signature: { kid, alg: "ed25519", value: "00".repeat(64) } };
}
async function signedUnchecked(value: any) {
  const { signature: _signature, ...data } = value;
  return { ...data, signature: { kid, alg: "ed25519", value: bytesToHex(await ed.signAsync(
    new TextEncoder().encode(canonicalize(data)), new Uint8Array(32).fill(15),
  )) } };
}

describe("opt-in rule format 2", () => {
  it("admits all 15 packaged IDs and the single TikTok service alias with a throwaway signature", async () => {
    const signed = await signRuleSetV2(payload(), privateKey, kid);
    expect(validateRuleSetV2(signed).ok).toBe(true);
    expect(await verifyRuleSetV2(signed, options)).toEqual({ ok: true });
    expect(Object.values(signed.services).flatMap((s) => s!.surfaces).map((s) => s.feature)).toHaveLength(16);
  });

  it("signs exact canonical format/version/services bytes, preserving array order", async () => {
    const data = payload();
    const signed = await signRuleSetV2(data, privateKey, kid);
    expect(new TextDecoder().decode(ruleSetSigningBytesV2(signed))).toBe(canonicalize(data));
    const reordered = { signature: signed.signature, services: signed.services, version: signed.version, format: 2 };
    expect(await verifyRuleSetV2(reordered, options)).toEqual({ ok: true });
    const reversed = structuredClone(signed);
    (reversed.services.youtube!.surfaces as any[]).reverse();
    expect((await verifyRuleSetV2(reversed, options)).ok).toBe(false);
  });

  it.each([
    ["missing discriminator", (s: any) => { delete s.format; }],
    ["unsupported format", (s: any) => { s.format = 3; }],
    ["malformed version", (s: any) => { s.version = "future"; }],
    ["unbounded version", (s: any) => { s.version = `${"9".repeat(80)}.0`; }],
    ["unknown service", (s: any) => { s.services.other = s.services.youtube; }],
    ["unknown feature", (s: any) => { s.services.youtube.surfaces[0].feature = "youtube.future"; }],
    ["cross-service feature", (s: any) => { s.services.youtube.surfaces[0].feature = "instagram.reels"; }],
    ["TikTok alias on another service", (s: any) => { s.services.youtube.surfaces[0].feature = "tiktok.all"; }],
    ["TikTok hide", (s: any) => { s.services.tiktok.surfaces[0].action = "hide"; s.services.tiktok.surfaces[0].selectors = ["body"]; }],
    ["non-TikTok block", (s: any) => { s.services.youtube.surfaces[0] = { id: "x", feature: "youtube.shorts", action: "blockSite" }; }],
    ["unknown action", (s: any) => { s.services.youtube.surfaces[0].action = "evalScript"; }],
    ["remove action", (s: any) => { s.services.youtube.surfaces[0].action = "remove"; }],
    ["placeholder action", (s: any) => { s.services.youtube.surfaces[0].action = "placeholder"; }],
    ["redirect without retained contract", (s: any) => { s.services.youtube.surfaces[0].action = "redirect"; }],
    ["remote tier", (s: any) => { s.services.youtube.surfaces[0].tier = "free"; }],
    ["remote default", (s: any) => { s.services.youtube.surfaces[0].enabledByDefault = true; }],
    ["remote price", (s: any) => { s.price = 0; }],
    ["remote benefit ownership", (s: any) => { s.services.youtube.surfaces[0].requiredCapability = "surface.youtube.shorts"; }],
    ["executable expression", (s: any) => { s.services.youtube.surfaces[0].onMatch = "fetch('/private')"; }],
    ["unknown nested key", (s: any) => { s.services.youtube.source = "other"; }],
    ["unknown signature key", (s: any) => { s.signature.format = 2; }],
    ["wrong signature algorithm", (s: any) => { s.signature.alg = "hmac"; }],
    ["short signature", (s: any) => { s.signature.value = "ab"; }],
    ["empty selectors", (s: any) => { s.services.youtube.surfaces[0].selectors = []; }],
    ["unsafe CSS", (s: any) => { s.services.youtube.surfaces[0].selectors = ["a:visited"]; }],
    ["long selector", (s: any) => { s.services.youtube.surfaces[0].selectors = ["a".repeat(513)]; }],
    ["too many selectors", (s: any) => { s.services.youtube.surfaces[0].selectors = Array(33).fill("a"); }],
    ["too many surfaces", (s: any) => { s.services.youtube.surfaces = Array.from({ length: 65 }, (_, i) => ({ id: `s${i}`, feature: "youtube.shorts", action: "hide", selectors: ["a"] })); }],
    ["duplicate surface ID", (s: any) => { s.services.youtube.surfaces[1].id = s.services.youtube.surfaces[0].id; }],
    ["empty services", (s: any) => { s.services = {}; }],
    ["cross-site host", (s: any) => { s.services.youtube.matches = ["*://*.instagram.com/*"]; }],
    ["lookalike host", (s: any) => { s.services.youtube.matches = ["*://youtube.com.evil.example/*"]; }],
    ["all hosts", (s: any) => { s.services.youtube.matches = ["<all_urls>"]; }],
    ["executable path", (s: any) => { s.services.youtube.matches = ["javascript:alert(1)"]; }],
    ["path authority outside minimal contract", (s: any) => { s.services.youtube.matches = ["*://*.youtube.com/shorts/*"]; }],
  ])("rejects %s before any signature can authorize it", async (_name, mutate) => {
    const set = unsignedShape(); mutate(set);
    expect(validateRuleSetV2(set).ok).toBe(false);
    expect((await verifyRuleSetV2(set, options)).ok).toBe(false);
  });

  it("rejects disallowed authority even with a cryptographically valid signature", async () => {
    const set = unsignedShape(); set.services.youtube.surfaces[0].tier = "free";
    expect((await verifyRuleSetV2(await signedUnchecked(set), options)).ok).toBe(false);
  });

  it("rejects non-JSON executable input without invoking it", () => {
    let invoked = false;
    const set = unsignedShape();
    Object.defineProperty(set, "format", { enumerable: true, get() { invoked = true; return 2; } });
    expect(validateRuleSetV2(set).ok).toBe(false);
    expect(invoked).toBe(false);
  });

  it("rejects sparse arrays, custom array properties and inherited hooks", () => {
    for (const selectors of [Array(1), Object.assign(["a"], { extra: "a" }), Object.assign(Array(1), { extra: "a" })]) {
      const set = unsignedShape(); set.services.youtube.surfaces[0].selectors = selectors;
      expect(validateRuleSetV2(set).ok).toBe(false);
    }
    const set = unsignedShape();
    Object.setPrototypeOf(set.services.youtube, { toJSON: () => ({}) });
    expect(validateRuleSetV2(set).ok).toBe(false);
  });

  it("bounds total bytes even when each selector and collection fits its individual limit", () => {
    const set = unsignedShape();
    set.services.youtube.surfaces = Array.from({ length: 32 }, (_, i) => ({
      id: `s${i}`, feature: "youtube.shorts", action: "hide", selectors: Array(20).fill("a".repeat(450)),
    }));
    expect(validateRuleSetV2(set).ok).toBe(false);
  });

  it("snapshots signing data before async signing and rejects getters without invocation", async () => {
    const data = payload();
    const pending = signRuleSetV2(data, privateKey, kid);
    (data.services.youtube!.surfaces[0] as any).selectors = [".later-mutation"];
    const signed = await pending;
    expect((await verifyRuleSetV2(signed, options)).ok).toBe(true);
    expect((signed.services.youtube!.surfaces[0] as any).selectors).toEqual([".synthetic-owned-target"]);
    let invoked = false;
    Object.defineProperty(data, "format", { enumerable: true, get() { invoked = true; return 2; } });
    await expect(signRuleSetV2(data, privateKey, kid)).rejects.toThrow();
    expect(invoked).toBe(false);
  });

  it("rejects wrong keys, unknown kid, rollback and malformed floors", async () => {
    const signed = await signRuleSetV2(payload(), privateKey, kid);
    for (const opts of [
      { ...options, allowedKeys: [{ kid, publicKeyHex: await publicKeyHexFor("10".repeat(32)) }] },
      { ...options, allowedKeys: [] }, { ...options, minVersion: "2.0.0" },
      { ...options, minVersion: "future" },
    ]) expect((await verifyRuleSetV2(signed, opts)).ok).toBe(false);
    expect((await verifyRuleSetV2({ ...signed, signature: { ...signed.signature, value: "ff".repeat(64) } }, options)).ok).toBe(false);
  });

  it("binds discriminator, version, feature, selectors, IDs and host bytes", async () => {
    const signed = await signRuleSetV2(payload(), privateKey, kid);
    for (const mutate of [
      (s: any) => { s.format = 1; }, (s: any) => { s.version = "1.1.0"; },
      (s: any) => { s.services.youtube.surfaces[0].feature = "youtube.related"; },
      (s: any) => { s.services.youtube.surfaces[0].selectors = [".changed"]; },
      (s: any) => { s.services.youtube.surfaces[0].id = "changed"; },
      (s: any) => { s.services.youtube.matches = ["https://www.youtube.com/*"]; },
    ]) { const changed = structuredClone(signed); mutate(changed); expect((await verifyRuleSetV2(changed, options)).ok).toBe(false); }
  });

  it("legacy signatures cannot authenticate format 2 and format 2 cannot enter legacy fetch/cache", async () => {
    const signed = await signRuleSetV2(payload(), privateKey, kid);
    const legacySignature = bytesToHex(await ed.signAsync(ruleSetSigningBytes(signed as unknown as SignedRuleSet), new Uint8Array(32).fill(15)));
    expect((await verifyRuleSetV2({ ...signed, signature: { ...signed.signature, value: legacySignature } }, options)).ok).toBe(false);
    expect(validateRuleSet(signed).ok).toBe(false);
    const area = { get: async (key: string) => ({ [key]: signed }) };
    expect(await readCachedRuleSet(area, options)).toBeNull();
    const { signature, ...data } = signed;
    const fetchImpl = (async () => new Response(JSON.stringify([{ payload: data, signature }]))) as typeof fetch;
    expect(await fetchCurrentRuleSet({ endpoint: { url: "https://synthetic.invalid", anonKey: "synthetic" }, ...options, fetchImpl })).toBeNull();
    expect((await verifyRuleSetV2(seed, options)).ok).toBe(false);
    expect(ruleSetTrust(true).allowedKeys.some((key) => key.kid === kid)).toBe(false);
  });
});
