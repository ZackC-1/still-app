import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IMPLEMENTED_PRO_FEATURES, accessCapabilities } from "../../entitlement/access-policy.js";
import { describe, expect, it, vi } from "vitest";
import { NativeBridge, parseNativeAppleAccessCommit, type NativeAppleAccessInstall } from "../bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { FEATURE_REGISTRY, PAID_ACCESS_WINDOW_MS } from "@still/shared-types";
const now = 1_800_000_000_000;
const identity = "synthetic-access:" + "ab".repeat(64);
const input: NativeAppleAccessInstall = { nativeBinding: "signed-binding", localProof: "signed-local", issuerTime: now };
const ack = { schema: 1, status: "committed", generation: 2, localRight: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownershipRevision: 1, verifiedAt: now, expiresAt: now + PAID_ACCESS_WINDOW_MS, localProofIdentity: identity, accountProofIdentity: null };
function host(reply: (value: unknown) => Promise<unknown>) {
  const post = vi.fn(reply);
  return { post, bridge: new NativeBridge({ webkit: { messageHandlers: { still: { postMessage: post } } } } as StillBridgeWindow) };
}
describe("native Apple signed access install/readback contract", () => {
  it("requires an exact durable local acknowledgment and paired verified account transport", async () => {
    const local = host(async () => JSON.stringify(ack));
    expect(await local.bridge.installAppleAccess(input)).toEqual(ack);
    expect(local.post).toHaveBeenCalledExactlyOnceWith({ kind: "installAppleAccess", ...input });
    const linked = host(async () => ({ ...ack, accountProofIdentity: identity }));
    expect(await linked.bridge.installAppleAccess({ ...input, accountProof: "signed-account", accessToken: "transient-token" })).toMatchObject({ accountProofIdentity: identity });
  });
  it.each([
    { ...ack, entitled: true }, { ...ack, generation: true }, { ...ack, localRight: "random" },
    { ...ack, ownershipRevision: -1 }, { ...ack, verifiedAt: now + 1 }, { ...ack, expiresAt: now + 1 },
    { ...ack, localProofIdentity: "receipt-entitled" }, { ...ack, accountProofIdentity: identity },
    { ...ack, status: "verified" }, { ok: true }, null,
  ])("rejects malformed, wrong-clock or wrong-scope install receipt %j", async (reply) => {
    const h = host(async () => reply);
    await expect(h.bridge.installAppleAccess(input)).rejects.toThrow();
  });
  it.each([
    { ...input, localRight: ack.localRight }, { ...input, issuerTime: true }, { ...input, issuerTime: -1 },
    { ...input, nativeBinding: "" }, { ...input, nativeBinding: "x".repeat(6145) },
    { ...input, accountProof: "signed-account" }, { ...input, accessToken: "transient-token" },
  ])("rejects caller authority and incomplete input before posting %j", async (value) => {
    const h = host(async () => ack);
    await expect(h.bridge.installAppleAccess(value as unknown as NativeAppleAccessInstall)).rejects.toThrow();
    expect(h.post).not.toHaveBeenCalled();
  });
  it("bounds a stalled install and refuses missing/failed native authority", async () => {
    const missing = new NativeBridge({} as StillBridgeWindow);
    await expect(missing.installAppleAccess(input)).rejects.toThrow();
    await expect(host(async () => { throw new Error("commit failed"); }).bridge.installAppleAccess(input)).rejects.toThrow();
    vi.useFakeTimers();
    try {
      const pending = host(() => new Promise(() => {})).bridge.installAppleAccess(input);
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
  it("observes signed native mappings and preserves the verification-required state", async () => {
    const right = { localRight: ack.localRight, ownershipRevision: 1, verifiedAt: now, expiresAt: ack.expiresAt, localProofIdentity: identity, status: "verification_required" };
    const h = host(async () => ({ schema: 1, generation: 3, rights: [right] }));
    expect(await h.bridge.observeAppleAccess()).toEqual({ schema: 1, generation: 3, rights: [right] });
    expect(h.post).toHaveBeenCalledExactlyOnceWith({ kind: "observeAppleAccess" });
    for (const reply of [
      { schema: 1, generation: 3, rights: [right, right] },
      { schema: 1, generation: 3, rights: [{ ...right, status: "entitled" }] },
      { schema: 1, generation: 3, rights: [{ ...right, extra: true }] },
      { schema: 1, generation: 3, rights: [{ ...right, expiresAt: now }] },
      { schema: 1, generation: 3, rights: [right], extra: true },
    ]) await expect(host(async () => reply).bridge.observeAppleAccess()).rejects.toThrow();
  });
  it("requires explicit null in anonymous acknowledgment", () => {
    const { accountProofIdentity: _ignored, ...missing } = ack;
    expect(() => parseNativeAppleAccessCommit(missing)).toThrow();
  });
});

it("keeps the compiled native Safari capability allowlists equal to the canonical host gate per platform", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../../../../../apps/apple/StillKit/Sources/StillKit/AppleRightBinding.swift"), "utf8");
  const list = (name: string) => {
    const native = source.match(new RegExp(`public static let ${name} = \\[([\\s\\S]*?)\\]`))?.[1];
    expect(native, name).toBeDefined();
    return [...native!.matchAll(/"([a-z]+\.[a-z]+)"/g)].map(match => match[1]!);
  };
  const pro = (platform: "desktop" | "ios") => [...accessCapabilities({ paidMode: true, host: "safari", platform })]
    .filter(id => FEATURE_REGISTRY.some(feature => feature.id === id && feature.tier === "pro")).sort();
  // iPhone/iPad Safari (`safariPro`) and macOS Safari (`safariPro + safariDesktopLayoutPro`).
  expect(list("safariPro").sort()).toEqual(pro("ios"));
  expect([...list("safariPro"), ...list("safariDesktopLayoutPro")].sort()).toEqual(pro("desktop"));
  expect(pro("desktop")).toEqual([...IMPLEMENTED_PRO_FEATURES.safari].sort());
});

it("uses a separate closed local evidence RPC and retains the purchased-only account-link RPC", async () => {
  const evidence = { productId: "still_pro_v3", bundleId: "org.example.Still", signedTransaction: "header.family.signature" };
  const h = host(async () => ({ evidence }));
  expect(await h.bridge.appleLocalPurchaseEvidence()).toEqual(evidence);
  expect(h.post).toHaveBeenLastCalledWith({ kind: "appleLocalPurchaseEvidence" });
  expect(await h.bridge.applePurchaseEvidence()).toEqual(evidence);
  expect(h.post).toHaveBeenLastCalledWith({ kind: "applePurchaseEvidence" });
  for (const forged of [{ ...evidence, ownership: "purchased" }, { ...evidence, familyShared: true }, { ...evidence, signedTransaction: "receipt-boolean" }]) {
    expect(await host(async () => ({ evidence: forged })).bridge.appleLocalPurchaseEvidence()).toBeNull();
  }
});

it("reads purchaser-only local provenance through its dedicated closed observation RPC", async () => {
  const right = {
    localRight: ack.localRight,
    ownershipRevision: 1,
    verifiedAt: now,
    expiresAt: ack.expiresAt,
    localProofIdentity: identity,
    status: "purchased",
  };
  const h = host(async () => ({ schema: 1, generation: 3, rights: [right] }));
  expect(await h.bridge.observeAppleLinkAccess()).toEqual({
    schema: 1,
    generation: 3,
    rights: [right],
  });
  expect(h.post).toHaveBeenCalledExactlyOnceWith({
    kind: "observeAppleLinkAccess",
  });
  expect(
    await host(async () => ({
      schema: 1,
      generation: 3,
      rights: [],
    })).bridge.observeAppleLinkAccess(),
  ).toEqual({ schema: 1, generation: 3, rights: [] });
  for (const reply of [
    { schema: 1, generation: 3, rights: [right], ownership: "purchased" },
    {
      schema: 1,
      generation: 3,
      rights: [{ ...right, ownership: "purchased" }],
    },
    { schema: 1, generation: 3, rights: [{ ...right, status: "protected" }] },
    { schema: 1, generation: 3, rights: [right, right] },
  ])
    await expect(
      host(async () => reply).bridge.observeAppleLinkAccess(),
    ).rejects.toThrow();
});
