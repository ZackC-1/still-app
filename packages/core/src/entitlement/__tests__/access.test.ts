import { describe, expect, it, vi, afterEach } from "vitest";
import vectors from "../../../../../tests/access-proof/vectors.json";
import { verifyAccessProof, type AccessTrust, type VerifiedAccessProof } from "../access-proof.js";
import { installPaidClock, observePaidClock, resolveBenefitAccess } from "../access-policy.js";
import { EMPTY_ACCESS_RECORD, mutateAccessRecord } from "../access-record.js";
import { ChromeEntitlementAdapter } from "../chrome-adapter.js";
import { createEntitlementMessageRouter } from "../messages.js";
import { EntitlementCache } from "../cache.js";
import { NativeBridge } from "../../native/bridge.js";

const trust: AccessTrust = { environment: "sandbox", keys: [{ kid: "synthetic-access", purpose: "access", environment: "sandbox", publicKeyHex: vectors.publicKeyHex }],
  protectedSnapshot: { product: vectors.protectedProduct, benefits: ["youtube.comments"] } };
async function proof(name = "paid-account"): Promise<VerifiedAccessProof> {
  const vector = vectors.vectors.find(v => v.name === name)!;
  const result = await verifyAccessProof(vector.envelope, trust);
  if (result.status !== "verified") throw new Error(`${name}: ${result.status}`);
  return result.proof;
}
afterEach(() => vi.unstubAllGlobals());

describe("closed access proof parity vectors", () => {
  for (const vector of vectors.vectors) it(vector.name, async () => {
    expect((await verifyAccessProof(vector.envelope, trust)).status).toBe(vector.status);
  });
  it("holds missing CP109 context without inventing a snapshot or downgrading free core", async () => {
    const { protectedSnapshot: _, ...without } = trust;
    expect((await verifyAccessProof(vectors.vectors.find(v => v.name === "protected-local")!.envelope, without)).status).toBe("verification_required");
    expect(resolveBenefitAccess("youtube.shorts", [], { paidMode: true, supported: true, free: true, accountId: null, localRights: new Set(), evidenceStatus: "unknown" })).toBe("free");
  });
  it("rejects a settings/rules key even when the key bytes match", async () => {
    const key = trust.keys[0]!;
    expect((await verifyAccessProof(vectors.vectors[0]!.envelope, { ...trust, keys: [{ ...key, purpose: "rules" as "access" }] })).status).toBe("invalid");
  });
});

describe("D519 fixed deadline and persisted latches", () => {
  it("deadline minus one, exact and after", async () => {
    const p = await proof(), clock = installPaidClock(p, vectors.verifiedAt, 1000);
    for (const offset of [-1, 0, 1]) {
      const result = observePaidClock(p, clock, { wall: 1000 + vectors.expiresAt - vectors.verifiedAt + offset });
      expect(result.state).toBe(offset < 0 ? "valid" : "verification_required");
      expect(result.clock?.expired).toBe(offset >= 0);
    }
  });
  it("restart preserves anchor; wall covers sleep with stopped monotonic clock", async () => {
    const p = await proof(), original = installPaidClock(p, vectors.verifiedAt, 1000);
    const afterSleep = observePaidClock(p, JSON.parse(JSON.stringify(original)), { wall: 11_000, runningEstimate: vectors.verifiedAt });
    expect(afterSleep.state).toBe("valid");
    expect(afterSleep.clock?.highWater).toBe(vectors.verifiedAt + 10_000);
    expect(afterSleep.clock?.wallAtReceipt).toBe(1000);
    const restart = observePaidClock(p, afterSleep.clock, { wall: 21_000 });
    expect(restart.clock?.highWater).toBe(vectors.verifiedAt + 20_000);
    expect(restart.clock?.expiresAt).toBe(vectors.expiresAt);
  });
  it("rollback pauses persistently until authoritative replacement; expiry cannot roll back", async () => {
    const p = await proof(), original = installPaidClock(p, vectors.verifiedAt, 1000);
    const advanced = observePaidClock(p, original, { wall: 2000 }).clock;
    const rollback = observePaidClock(p, advanced, { wall: 1500 });
    expect(rollback.clock?.paused).toBe(true);
    expect(observePaidClock(p, rollback.clock, { wall: 3000 }).state).toBe("verification_required");
    const expired = observePaidClock(p, original, { wall: 1000 + vectors.expiresAt - vectors.verifiedAt }).clock;
    expect(observePaidClock(p, expired, { wall: 1000 }).clock?.expired).toBe(true);
  });
  it("imported/mismatched baseline holds and monotonic lower bound advances only supplied current runtime", async () => {
    const p = await proof(), clock = installPaidClock(p, vectors.verifiedAt, 1000);
    expect(observePaidClock(p, null, { wall: 1000 }).state).toBe("verification_required");
    expect(observePaidClock(p, { ...clock, proofIdentity: "copied" }, { wall: 1000 }).state).toBe("verification_required");
    expect(observePaidClock(p, clock, { wall: 1000, runningEstimate: vectors.verifiedAt + 2000 }).clock?.highWater).toBe(vectors.verifiedAt + 2000);
    expect(observePaidClock(p, clock, { wall: 1000 }).clock?.highWater).toBe(vectors.verifiedAt);
  });
  it("unsafe wall arithmetic pauses persistently rather than recovering on the next read", async () => {
    const p = await proof(), clock = installPaidClock(p, vectors.verifiedAt, 1000);
    const result = observePaidClock(p, clock, { wall: Number.MAX_SAFE_INTEGER });
    expect(result.state).toBe("verification_required");
    expect(result.clock?.paused).toBe(true);
    expect(observePaidClock(p, result.clock, { wall: 1001 }).state).toBe("verification_required");
  });
});

describe("scope, union and immutable cache identity", () => {
  it("new authoritative proof repairs a forward jump; old proof and known revocation cannot return", async () => {
    const old = await proof(), fresh = await proof("paid-new-validation");
    let record = (await mutateAccessRecord(EMPTY_ACCESS_RECORD, { kind: "account", accountId: vectors.account }, trust)).record;
    const install = { kind: "install" as const, generation: record.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set<string>() };
    record = (await mutateAccessRecord(record, { ...install, proof: old }, trust)).record;
    record = (await mutateAccessRecord(record, { kind: "observe", observation: { wall: 1000 + vectors.expiresAt - vectors.verifiedAt } }, trust)).record;
    record = (await mutateAccessRecord(record, { ...install, proof: fresh, issuerNow: vectors.verifiedAt + 1000, wall: 9000 }, trust)).record;
    expect((await mutateAccessRecord(record, { kind: "observe", observation: { wall: 9001 } }, trust)).evidence[0]!.paidState).toBe("valid");
    await expect(mutateAccessRecord(record, { ...install, proof: old }, trust)).rejects.toThrow("Stale access proof");
  });
  it("holder matching never copies an Apple-local proof into a browser/account", async () => {
    const local = await proof("paid-apple-local");
    const item = { proof: local, paidState: "valid" as const, revoked: false };
    const context = { paidMode: true, supported: true, free: false, accountId: vectors.account, localRights: new Set<string>(), evidenceStatus: "unknown" as const };
    expect(resolveBenefitAccess("youtube.comments", [item], context)).toBe("verification_required");
    expect(resolveBenefitAccess("youtube.comments", [item], { ...context, localRights: new Set([vectors.localRight]) })).toBe("purchased");
    expect(resolveBenefitAccess("youtube.comments", [item], { ...context, supported: false })).toBe("unsupported");
  });
  it("known revocation/expiry excludes only that right; protected and free rights survive", async () => {
    const purchased = await proof(), protectedRight = await proof("protected-local");
    const evidence = [{ proof: purchased, paidState: "verification_required" as const, revoked: true }, { proof: protectedRight, paidState: "verification_required" as const, revoked: false }];
    const context = { paidMode: true, supported: true, free: false, accountId: null, localRights: new Set([vectors.localRight]), evidenceStatus: "unknown" as const };
    expect(resolveBenefitAccess("youtube.comments", evidence, context)).toBe("protected");
    expect(resolveBenefitAccess("youtube.related", evidence, context)).toBe("verification_required");
    expect(resolveBenefitAccess("youtube.related", evidence, { ...context, paidMode: false })).toBe("free");
  });
  it("same proof reads/retries do not reset anchors or expiry; known revoke is sticky", async () => {
    const p = await proof();
    let state = (await mutateAccessRecord(EMPTY_ACCESS_RECORD, { kind: "account", accountId: vectors.account }, trust)).record;
    const install = { kind: "install" as const, proof: p, generation: state.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set<string>() };
    state = (await mutateAccessRecord(state, install, trust)).record;
    state = (await mutateAccessRecord(state, { kind: "observe", observation: { wall: 1000 + vectors.expiresAt - vectors.verifiedAt } }, trust)).record;
    const retry = (await mutateAccessRecord(state, { ...install, issuerNow: vectors.verifiedAt + 10, wall: 5000 }, trust)).record;
    expect(retry.rights[0]!.clock).toEqual(state.rights[0]!.clock);
    state = (await mutateAccessRecord(state, { kind: "revoke", right: p.claims.right, revision: 1, generation: state.generation }, trust)).record;
    await expect(mutateAccessRecord(state, install, trust)).rejects.toThrow("Known revoked");
  });
  it("A -> null -> B -> null -> A fences delayed account proof and preserves local protection", async () => {
    const paid = await proof(), local = await proof("protected-local");
    let record = (await mutateAccessRecord(EMPTY_ACCESS_RECORD, { kind: "account", accountId: vectors.account }, trust)).record;
    const oldGeneration = record.generation;
    record = (await mutateAccessRecord(record, { kind: "install", proof: local, generation: oldGeneration, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set([vectors.localRight]) }, trust)).record;
    for (const accountId of [null, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", null, vectors.account]) record = (await mutateAccessRecord(record, { kind: "account", accountId }, trust)).record;
    expect(record.rights).toHaveLength(1);
    await expect(mutateAccessRecord(record, { kind: "install", proof: paid, generation: oldGeneration, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set() }, trust)).rejects.toThrow("Stale access scope");
  });
  it("one invalid right cannot deny independently valid permanent protection", async () => {
    const local = await proof("protected-local");
    let record = (await mutateAccessRecord(EMPTY_ACCESS_RECORD, { kind: "install", proof: local, generation: 0, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set([vectors.localRight]) }, trust)).record;
    record = { ...record, rights: [...record.rights, { envelope: "unreadable", clock: null }] };
    const result = await mutateAccessRecord(record, { kind: "observe", observation: { wall: 2000 } }, trust);
    expect(result.record.rights).toHaveLength(2);
    expect(resolveBenefitAccess("youtube.comments", result.evidence, { paidMode: true, supported: true, free: false, accountId: null, localRights: new Set([vectors.localRight]), evidenceStatus: "unknown" })).toBe("protected");
  });
});

function chromeHarness() {
  const store: Record<string, unknown> = {};
  const local = { get: vi.fn(async (key: string) => ({ [key]: structuredClone(store[key]) })),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(store, structuredClone(items)); }) };
  const runtime = { sendMessage: vi.fn((message: unknown) => new Promise(resolve => {
    if (!router(message, { id: "still", url: "chrome-extension://still/popup.html" }, resolve)) resolve(null);
  })) };
  vi.stubGlobal("chrome", { storage: { local }, runtime });
  const authority = new ChromeEntitlementAdapter(() => 1000, { authority: true, trust });
  const router = createEntitlementMessageRouter(authority, "still", "chrome-extension://still/");
  return { store, local, authority, router };
}

describe("actual browser writer/broker preservation", () => {
  it("legacy writes preserve opaque record fields and reject damaged or oversized records without replacing them", async () => {
    const { authority, store, local } = chromeHarness();
    store["still:entitlement"] = { entitled: true, userId: vectors.account, updatedAt: 1000, futureMetadata: { revision: 7 } };
    await authority.set(false, 2000);
    expect(store["still:entitlement"]).toEqual({ entitled: false, updatedAt: 2000, futureMetadata: { revision: 7 } });
    store["still:entitlement"] = "damaged";
    local.set.mockClear();
    await expect(authority.set(false, 3000)).rejects.toThrow("Unreadable entitlement record");
    expect(store["still:entitlement"]).toBe("damaged"); expect(local.set).not.toHaveBeenCalled();
    const oversized = { entitled: true, updatedAt: 1000, futureMetadata: "x".repeat(131_072) };
    store["still:entitlement"] = oversized;
    await expect(authority.set(false, 3000)).rejects.toThrow("Access record full");
    expect(store["still:entitlement"]).toEqual(oversized); expect(local.set).not.toHaveBeenCalled();
  });
  it("native bridge sends no caller-selected proof/clock and reports an unavailable read/teardown", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, record: EMPTY_ACCESS_RECORD });
    const bridge = new NativeBridge({ webkit: { messageHandlers: { still: { postMessage } } } });
    expect(await bridge.observeAccess()).toEqual(EMPTY_ACCESS_RECORD);
    expect(postMessage).toHaveBeenCalledWith({ kind: "getAccess" });
    postMessage.mockResolvedValue({ ok: false });
    await expect(bridge.observeAccess()).rejects.toThrow("requires verification");
    postMessage.mockResolvedValue({ ok: true, access: "verification_required" });
    await expect(bridge.signOut()).rejects.toThrow("requires verification");
  });
  it("two hosts use the same serialized authority and cannot overwrite a stronger bound/revoke", async () => {
    const { authority, store } = chromeHarness();
    const p = await proof("paid-apple-local");
    const scope = await authority.mutateAccess({ kind: "account", accountId: null });
    await authority.mutateAccess({ kind: "install", proof: p, generation: scope.record.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set([vectors.localRight]) });
    const a = new ChromeEntitlementAdapter(), b = new ChromeEntitlementAdapter();
    await Promise.all([a.set(false, 1000), b.observeAccess(), authority.mutateAccess({ kind: "observe", observation: { wall: 4000 } }), authority.mutateAccess({ kind: "revoke", right: p.claims.right, revision: 1, generation: scope.record.generation })]);
    const record = (store["still:entitlement"] as { access: { rights: { clock: { highWater: number } }[]; revocations: unknown[] } }).access;
    expect(record.rights[0]!.clock.highWater).toBe(vectors.verifiedAt + 3000);
    expect(record.revocations).toHaveLength(1);
    await a.set(true, 5000); // legacy SDK compatibility does not clear modern revoke/high-water
    expect((store["still:entitlement"] as { access: unknown }).access).toEqual(record);
  });
  it("actual legacy sign-out route fences the account generation before delayed proof can return", async () => {
    const { authority } = chromeHarness(); const p = await proof();
    const scope = await authority.mutateAccess({ kind: "account", accountId: vectors.account });
    const install = { kind: "install" as const, proof: p, generation: scope.record.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set<string>() };
    await authority.mutateAccess(install);
    const departingHost = new ChromeEntitlementAdapter();
    await departingHost.setRecord({ entitled: false, updatedAt: 1000 });
    await departingHost.setRecord({ entitled: true, userId: vectors.account, updatedAt: 2000 });
    expect((await authority.observeAccess()).rights).toHaveLength(0);
    await expect(authority.mutateAccess(install)).rejects.toThrow("Stale access scope");
  });
  it("failed persistence publishes no weaker in-memory entitlement and queue recovers", async () => {
    const { authority, local, store } = chromeHarness();
    const cache = new EntitlementCache(authority, { initial: false });
    const listener = vi.fn(); cache.subscribe(listener);
    local.set.mockRejectedValueOnce(new Error("disk full"));
    await expect(cache.setEntitled(true)).rejects.toThrow("disk full");
    expect(cache.current()).toBe(false); expect(listener).not.toHaveBeenCalled(); expect(store).toEqual({});
    await cache.setEntitled(true); expect(cache.current()).toBe(true);
  });
  it("broker denies content scripts, foreign origins and caller-chosen proof/time commands", () => {
    const { router, local } = chromeHarness(); const reply = vi.fn();
    expect(router({ kind: "observeAccess" }, { id: "still", url: "https://youtube.com/" }, reply)).toBe(false);
    expect(router({ kind: "observeAccess" }, { id: "other", url: "chrome-extension://still/popup.html" }, reply)).toBe(false);
    expect(router({ kind: "observeAccess", wall: 1 }, { id: "still", url: "chrome-extension://still/popup.html" }, reply)).toBe(false);
    expect(router({ kind: "setEntitlementRecord", record: { entitled: true, updatedAt: 1, access: {} } }, { id: "still", url: "chrome-extension://still/popup.html" }, reply)).toBe(false);
    expect(local.set).not.toHaveBeenCalled();
  });
});
