import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "../../../../../tests/access-proof/vectors.json";
import { ChromeEntitlementAdapter } from "../chrome-adapter.js";
import { EntitlementCache } from "../cache.js";
import { ACCESS_OBSERVATION_DEADLINE_MS, initialAccessSnapshot, isBenefitEffective, parseBenefitAccessSnapshot } from "../access-policy.js";
import type { SettingsV2 } from "@still/shared-types";
import * as proofModule from "../access-proof.js";
import { createEntitlementMessageRouter } from "../messages.js";
import { parseAccessCacheRecord } from "../access-record.js";
import { verifyAccessProof, type AccessTrust } from "../access-proof.js";
import { FEATURE_IDS, type BenefitId } from "@still/shared-types";

const benefits = new Set<BenefitId>([...FEATURE_IDS, "tiktok.all"]);
const session = { userId: vectors.account, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const trust: AccessTrust = { environment: "sandbox", keys: [{ kid: "synthetic-access", purpose: "access", environment: "sandbox", publicKeyHex: vectors.publicKeyHex }], protectedSnapshot: { product: vectors.protectedProduct, benefits: ["youtube.comments"] } };
async function proof(name = "paid-account") {
  const result = await verifyAccessProof(vectors.vectors.find(v => v.name === name)!.envelope, trust);
  if (result.status !== "verified") throw new Error("Synthetic proof rejected");
  return result.proof;
}
function harness() {
  const store: Record<string, unknown> = {};
  const changed = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const local = { get: vi.fn(async (key: string) => ({ [key]: structuredClone(store[key]) })), set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(store, structuredClone(items)); for (const listener of changed) listener(Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { newValue }])), "local"); }) };
  const context = { paidMode: true, supported: benefits, session: session as typeof session | null | undefined, localRights: new Set<string>(), evidenceStatus: "unknown" as "unknown" | "absent" | "checking" };
  const runtime = { sendMessage: vi.fn((message: unknown) => new Promise(resolve => { if (!router(message, { id: "still", url: "https://www.youtube.com/" }, resolve)) resolve(null); })) };
  vi.stubGlobal("chrome", { storage: { local, onChanged: { addListener: (fn: typeof changed extends Set<infer T> ? T : never) => changed.add(fn), removeListener: (fn: typeof changed extends Set<infer T> ? T : never) => changed.delete(fn) } }, runtime });
  let wall = 1000;
  const contextRead = vi.fn(() => context);
  const authority = new ChromeEntitlementAdapter(() => wall, { authority: true, trust, context: contextRead });
  const router = createEntitlementMessageRouter(authority, "still", "chrome-extension://still/");
  return { store, local, context, contextRead, authority, router, runtime, changed, setWall: (value: number) => { wall = value; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("committed per-benefit consumer", () => {
  it("free core is synchronous and offline without reading account or native authority", () => {
    const h = harness(); const cache = new EntitlementCache(h.authority);
    expect(cache.currentAccess("youtube.shorts")).toBe("free");
    expect(cache.currentAccess("tiktok.all")).toBe("free");
    expect(h.contextRead).not.toHaveBeenCalled(); expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  });
  it("observes one committed grant, preserves verified same session across wake, fences new same-UUID session", async () => {
    const h = harness(); await h.authority.observeBenefits();
    const current = await h.authority.observeAccess();
    const p = await proof(); await h.authority.mutateAccess({ kind: "install", proof: p, generation: current.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set() });
    const first = await h.authority.observeBenefits();
    expect(first.states["youtube.comments"]).toBe("purchased");
    expect((await h.authority.observeBenefits()).generation).toBe(first.generation);
    const waking = new ChromeEntitlementAdapter(() => 1000, { authority: true, trust, context: () => h.context });
    expect((await waking.observeBenefits()).states["youtube.comments"]).toBe("purchased");
    h.context.session = { ...session, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    h.authority.invalidateAccessContext();
    const replacement = await h.authority.observeBenefits();
    expect(replacement.generation).toBeGreaterThan(first.generation);
    expect(replacement.states["youtube.comments"]).toBe("verification_required");
    await expect(h.authority.mutateAccess({ kind: "install", proof: p, generation: first.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set() })).rejects.toThrow();
  });
  it("malformed optional protection preserves independently valid signed rights and opaque bytes", async () => {
    const h = harness(); h.context.localRights.add(vectors.localRight);
    const p = await proof("protected-local"); await h.authority.mutateAccess({ kind: "install", proof: p, generation: 0, issuerNow: vectors.verifiedAt, wall: 1000, localRights: h.context.localRights });
    const retained = h.store["still:entitlement"] as { access: Record<string, unknown> };
    retained.access.localProtection = { broken: "retain-me" }; retained.access.future = { raw: "opaque" };
    expect(() => parseAccessCacheRecord(retained.access)).not.toThrow();
    const result = await h.authority.observeBenefits();
    expect(result.states["youtube.comments"]).toBe("protected");
    expect((h.store["still:entitlement"] as typeof retained).access.localProtection).toEqual({ broken: "retain-me" });
    expect((h.store["still:entitlement"] as typeof retained).access.future).toEqual({ raw: "opaque" });
  });
  it("missing verification never becomes absent and independent local rights survive unknown session", async () => {
    const h = harness(); h.context.session = undefined; h.context.localRights.add(vectors.localRight);
    const p = await proof("protected-local"); await h.authority.mutateAccess({ kind: "install", proof: p, generation: 0, issuerNow: vectors.verifiedAt, wall: 1000, localRights: h.context.localRights });
    const result = await h.authority.observeBenefits();
    expect(result.states["youtube.comments"]).toBe("protected");
    expect(result.states["youtube.related"]).toBe("verification_required");
    expect(result.states["youtube.shorts"]).toBe("free");
  });
  it("failed persistence cannot publish a grant and successful retry recovers", async () => {
    const h = harness(); await h.authority.observeBenefits();
    const current = await h.authority.observeAccess(); await h.authority.mutateAccess({ kind: "install", proof: await proof(), generation: current.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set() });
    const cache = new EntitlementCache(h.authority, { access: { paidMode: true, supported: benefits } }); const listener = vi.fn(); cache.subscribeAccess(listener);
    h.local.set.mockRejectedValueOnce(new Error("disk full"));
    await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
    expect(listener.mock.calls.some(([snapshot]) => snapshot.states["youtube.comments"] === "purchased")).toBe(false);
    await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("purchased");
  });
  it("broker read is limited to exact own supported hosts and never expands mutation authority", async () => {
    const h = harness(), reply = vi.fn();
    const sender = { id: "still", url: "https://www.youtube.com/shorts/abc" };
    expect(h.router({ kind: "observeBenefits" }, sender, reply)).toBe(true);
    for (const url of ["https://youtube.com.evil.test/", "https://evil.youtube.com/", "http://www.youtube.com/", "https://www.youtube.com@evil.test/", "https://www.example.com/"]) expect(h.router({ kind: "observeBenefits" }, { ...sender, url }, reply)).toBe(false);
    expect(h.router({ kind: "observeBenefits" }, { ...sender, id: "foreign" }, reply)).toBe(false);
    expect(h.router({ kind: "observeBenefits", paidMode: true }, sender, reply)).toBe(false);
    expect(h.router({ kind: "setEntitlementRecord", record: { entitled: true, updatedAt: 1 } }, sender, reply)).toBe(false);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0]![0]).not.toHaveProperty("record");
  });
  it("one snapshot covers every benefit; expiry and revoke commit while free remains usable", async () => {
    const h = harness(); await h.authority.observeBenefits(); const current = await h.authority.observeAccess(); const p = await proof();
    await h.authority.mutateAccess({ kind: "install", proof: p, generation: current.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set() });
    const grant = await h.authority.observeBenefits(); expect(Object.keys(grant.states)).toHaveLength(16);
    h.setWall(1000 + vectors.expiresAt - vectors.verifiedAt); const expired = await h.authority.observeBenefits();
    expect(expired.states["youtube.comments"]).toBe("verification_required");
    expect(expired.states["youtube.shorts"]).toBe("free");
    expect((await h.authority.observeAccess()).rights[0]!.clock?.expired).toBe(true);
    await h.authority.mutateAccess({ kind: "revoke", right: p.claims.right, revision: 1, generation: current.generation });
    h.setWall(1000); expect((await h.authority.observeBenefits()).states["youtube.comments"]).toBe("verification_required");
  });
  it("coalesces concurrent reads and invalidations with one bounded timer and teardown", async () => {
    vi.useFakeTimers(); const h = harness(); const cache = new EntitlementCache(h.authority, { access: { paidMode: true, supported: benefits } });
    const stop = cache.watch(); await Promise.all([cache.refreshAccess(), cache.refreshAccess(), cache.refreshAccess()]);
    const reads = h.contextRead.mock.calls.length;
    expect(reads).toBeLessThanOrEqual(2);
    for (const callback of h.changed) { callback({ "still:entitlement": { newValue: {} } }, "local"); callback({ "still:entitlement": { newValue: {} } }, "local"); }
    await Promise.resolve(); await Promise.resolve();
    stop(); expect(h.changed.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("known absence/checking/capability and all-Off intentions remain independent of grants", async () => {
    const h = harness(); h.context.evidenceStatus = "absent";
    expect((await h.authority.observeBenefits()).states["youtube.comments"]).toBe("locked");
    h.context.evidenceStatus = "checking"; h.authority.invalidateAccessContext();
    expect((await h.authority.observeBenefits()).states["youtube.comments"]).toBe("checking");
    const settings = { globalOn: true, services: { youtube: true, instagram: true, facebook: true, tiktok: false }, sites: Object.fromEntries(FEATURE_IDS.map(id => [id, false])) } as unknown as SettingsV2;
    const before = JSON.stringify(settings);
    for (const state of ["free", "purchased", "protected", "checking", "verification_required", "locked", "unsupported"] as const) {
      for (const benefit of benefits) expect(isBenefitEffective(settings, benefit, state)).toBe(false);
    }
    expect(JSON.stringify(settings)).toBe(before);
    const enabled = { ...settings, sites: { ...settings.sites, "youtube.comments": true } };
    expect(isBenefitEffective(enabled, "youtube.comments", "purchased")).toBe(true);
    expect(isBenefitEffective(enabled, "youtube.comments", "purchased", false)).toBe(false);
    expect(isBenefitEffective({ ...enabled, globalOn: false }, "youtube.comments", "purchased")).toBe(false);
    expect(isBenefitEffective({ ...enabled, services: { ...enabled.services, youtube: false } }, "youtube.comments", "purchased")).toBe(false);
  });
  it("drops an old native observation after host context changes", async () => {
    const h = harness(); let release!: (value: ReturnType<typeof initialAccessSnapshot>) => void;
    const native = new Promise<ReturnType<typeof initialAccessSnapshot>>(resolve => { release = resolve; });
    const nativeObservation = vi.fn(() => native);
    const adapter = new ChromeEntitlementAdapter(() => 1000, { authority: true, context: () => h.context, nativeObservation });
    const pending = adapter.observeBenefits(); await vi.waitFor(() => expect(nativeObservation).toHaveBeenCalledTimes(1));
    adapter.invalidateAccessContext(); release(initialAccessSnapshot({ paidMode: false, supported: benefits }));
    await expect(pending).rejects.toThrow("Stale access context");
  });
  it("never accepts a raw record, unknown state or incomplete transport as resolved authority", () => {
    const valid = initialAccessSnapshot({ paidMode: false, supported: benefits });
    expect(Object.values(valid.states).every(state => state === "free")).toBe(true);
    expect(() => parseBenefitAccessSnapshot({ schema: 1, generation: 0, rights: [], revocations: [] })).toThrow();
    expect(() => parseBenefitAccessSnapshot({ ...valid, states: { ...valid.states, "youtube.comments": "pro" } })).toThrow();
    expect(() => parseBenefitAccessSnapshot({ ...valid, refreshAfterMs: 60_001 })).toThrow();
  });
  it("verifies one retained proof once per committed same-session snapshot, not per benefit", async () => {
    const h = harness(); await h.authority.observeBenefits(); const current = await h.authority.observeAccess();
    await h.authority.mutateAccess({ kind: "install", proof: await proof(), generation: current.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set() });
    const checked = vi.spyOn(proofModule, "verifyAccessProof"); checked.mockClear();
    const snapshots = await Promise.all([h.authority.observeBenefits(), h.authority.observeBenefits(), h.authority.observeBenefits()]);
    expect(snapshots.every(snapshot => snapshot.states["youtube.comments"] === "purchased")).toBe(true);
    expect(checked).toHaveBeenCalledTimes(1); checked.mockRestore();
  });

  it("retains only independent permanent local protection when a later read fails", async () => {
    const h = harness(); h.context.localRights.add(vectors.localRight);
    await h.authority.observeBenefits(); const scope = await h.authority.observeAccess();
    await h.authority.mutateAccess({ kind: "install", proof: await proof("protected-local"), generation: scope.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: h.context.localRights });
    const cache = new EntitlementCache(h.authority, { access: { paidMode: true, supported: benefits } });
    await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("protected");
    h.authority.invalidateAccessContext(); h.local.get.mockRejectedValueOnce(new Error("unavailable"));
    await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("protected");
    expect(cache.currentAccess("youtube.related")).toBe("verification_required");
    expect(cache.currentAccessSnapshot().independentProtection).toEqual(["youtube.comments"]);
  });
  it("bounds sequential shared snapshots and rejects a clock rollback before returning cached paid access", async () => {
    const h = harness(); await h.authority.observeBenefits(); const current = await h.authority.observeAccess();
    await h.authority.mutateAccess({ kind: "install", proof: await proof(), generation: current.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set() });
    expect((await h.authority.observeBenefits()).states["youtube.comments"]).toBe("purchased");
    h.contextRead.mockClear(); h.local.get.mockClear();
    for (let i = 0; i < 50; i++) expect((await h.authority.observeBenefits()).states["youtube.comments"]).toBe("purchased");
    expect(h.contextRead).not.toHaveBeenCalled(); expect(h.local.get).not.toHaveBeenCalled();
    h.setWall(999);
    expect((await h.authority.observeBenefits()).states["youtube.comments"]).toBe("verification_required");
    expect((await h.authority.observeAccess()).rights[0]!.clock?.paused).toBe(true);
  });
  it("an expired front-end freshness timer cannot retain a paid grant while its page is suspended", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const h = harness(); await h.authority.observeBenefits(); const scope = await h.authority.observeAccess();
    await h.authority.mutateAccess({ kind: "install", proof: await proof(), generation: scope.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set() });
    const cache = new EntitlementCache(h.authority, { access: { paidMode: true, supported: benefits } });
    await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("purchased");
    vi.setSystemTime(61_001);
    expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
    expect(cache.currentAccess("youtube.shorts")).toBe("free");
  });

  it("releases a hung broker at its deadline and permits a fresh read", async () => {
    vi.useFakeTimers(); const h = harness();
    h.runtime.sendMessage.mockImplementationOnce(() => new Promise(() => undefined));
    const adapter = new ChromeEntitlementAdapter();
    const pending = adapter.observeBenefits(); const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(ACCESS_OBSERVATION_DEADLINE_MS);
    await rejected; expect(vi.getTimerCount()).toBe(0);
    await expect(adapter.observeBenefits()).resolves.toHaveProperty("schema", 1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("teardown cancels an in-flight native read and rejects its late grant", async () => {
    vi.useFakeTimers(); const h = harness(); let release!: (snapshot: ReturnType<typeof initialAccessSnapshot>) => void;
    const native = new Promise<ReturnType<typeof initialAccessSnapshot>>(resolve => { release = resolve; });
    const nativeObservation = vi.fn(() => native);
    const adapter = new ChromeEntitlementAdapter(() => 1000, { authority: true, context: () => h.context, nativeObservation });
    const cache = new EntitlementCache(adapter, { access: { paidMode: true, supported: benefits } });
    const stop = cache.watch(); const pending = cache.refreshAccess();
    await vi.advanceTimersByTimeAsync(0); expect(nativeObservation).toHaveBeenCalledTimes(1); stop(); await pending;
    expect(vi.getTimerCount()).toBe(0); expect(h.changed.size).toBe(0);
    release(initialAccessSnapshot({ paidMode: false, supported: benefits })); await Promise.resolve(); await Promise.resolve();
    expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes the same immutable committed snapshot to every subscriber", async () => {
    const h = harness(); h.context.evidenceStatus = "absent";
    const cache = new EntitlementCache(h.authority, { access: { paidMode: true, supported: benefits } });
    const seen: ReturnType<typeof initialAccessSnapshot>[] = []; cache.subscribeAccess(value => seen.push(value));
    await cache.refreshAccess();
    expect(seen).toHaveLength(1); expect(seen[0]).toBe(cache.currentAccessSnapshot());
    expect(Object.isFrozen(seen[0])).toBe(true); expect(Object.isFrozen(seen[0]!.states)).toBe(true);
  });

  it("a second consumer receives only the original signed deadline's remaining interval", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const h = harness(); await h.authority.observeBenefits(); const scope = await h.authority.observeAccess();
    await h.authority.mutateAccess({ kind: "install", proof: await proof(), generation: scope.generation,
      issuerNow: vectors.expiresAt - 30, wall: 1000, localRights: new Set() });
    const original = await h.authority.observeBenefits(); expect(original.refreshAfterMs).toBe(30);
    h.setWall(1029); vi.setSystemTime(1029);
    const cache = new EntitlementCache(h.authority, { access: { paidMode: true, supported: benefits } });
    await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("purchased");
    expect(cache.currentAccessSnapshot().refreshAfterMs).toBe(1);
    expect(original.refreshAfterMs).toBe(30); expect(Object.isFrozen(cache.currentAccessSnapshot())).toBe(true);
    h.setWall(1030); vi.setSystemTime(1030);
    expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
    expect((await h.authority.observeBenefits()).states["youtube.comments"]).toBe("verification_required");
    expect((await h.authority.observeAccess()).rights[0]!.clock?.expired).toBe(true);
  });

  it("does not renew signed freshness during an actual delayed authority commit", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const h = harness(); await h.authority.observeBenefits(); const scope = await h.authority.observeAccess();
    await h.authority.mutateAccess({ kind: "install", proof: await proof(), generation: scope.generation,
      issuerNow: vectors.expiresAt - 30, wall: 1000, localRights: new Set() });
    const set = h.local.set.getMockImplementation()!;
    h.local.set.mockImplementationOnce(async items => { h.setWall(1029); vi.setSystemTime(1029); await set(items); });
    const snapshot = await h.authority.observeBenefits(); expect(snapshot.refreshAfterMs).toBe(1);
    h.setWall(1030); vi.setSystemTime(1030);
    expect((await h.authority.observeBenefits()).states["youtube.comments"]).toBe("verification_required");
  });

  it("binds broker freshness to request start, including actual transport delay", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const h = harness(); await h.authority.observeBenefits(); const scope = await h.authority.observeAccess();
    await h.authority.mutateAccess({ kind: "install", proof: await proof(), generation: scope.generation,
      issuerNow: vectors.expiresAt - 30, wall: 1000, localRights: new Set() });
    const send = h.runtime.sendMessage.getMockImplementation()!;
    h.runtime.sendMessage.mockImplementationOnce(async message => { const reply = await send(message); h.setWall(1029); vi.setSystemTime(1029); return reply; });
    const broker = new ChromeEntitlementAdapter(() => Date.now());
    const cache = new EntitlementCache(broker, { access: { paidMode: true, supported: benefits } });
    await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("purchased");
    vi.setSystemTime(1030); expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
  });

  it("holds a reply whose durable commit completes after its freshness deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const h = harness(); await h.authority.observeBenefits(); const scope = await h.authority.observeAccess();
    await h.authority.mutateAccess({ kind: "install", proof: await proof(), generation: scope.generation,
      issuerNow: vectors.expiresAt - 30, wall: 1000, localRights: new Set() });
    const set = h.local.set.getMockImplementation()!;
    h.local.set.mockImplementationOnce(async items => { h.setWall(1031); vi.setSystemTime(1031); await set(items); });
    const cache = new EntitlementCache(h.authority, { access: { paidMode: true, supported: benefits } });
    const grants = vi.fn(); cache.subscribeAccess(grants);
    await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
    expect(grants.mock.calls.some(([snapshot]) => snapshot.states["youtube.comments"] === "purchased")).toBe(false);
    await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
    expect((await h.authority.observeAccess()).rights[0]!.clock?.expired).toBe(true);
  });

  it("bounds near-expiry failure retries, preserves independent protection, recovers and stops", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const h = harness(); h.context.localRights.add(vectors.localRight);
    await h.authority.observeBenefits(); const scope = await h.authority.observeAccess();
    await h.authority.mutateAccess({ kind: "install", proof: await proof("protected-local"), generation: scope.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: h.context.localRights });
    await h.authority.mutateAccess({ kind: "install", proof: await proof(), generation: scope.generation, issuerNow: vectors.expiresAt - 1, wall: 1000, localRights: new Set() });
    const cache = new EntitlementCache(h.authority, { access: { paidMode: true, supported: benefits } });
    const stop = cache.watch(); await cache.refreshAccess(); expect(cache.currentAccessSnapshot().refreshAfterMs).toBe(1);
    const observe = h.authority.observeBenefits.bind(h.authority);
    const reads = vi.spyOn(h.authority, "observeBenefits").mockRejectedValue(new Error("authority down"));
    await vi.advanceTimersByTimeAsync(11);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(cache.currentAccess("youtube.comments")).toBe("protected");
    expect(cache.currentAccess("youtube.related")).toBe("verification_required");
    reads.mockResolvedValueOnce({ malformed: true } as never);
    await vi.advanceTimersByTimeAsync(59_990); expect(reads).toHaveBeenCalledTimes(2);
    expect(cache.currentAccess("youtube.related")).toBe("verification_required");
    // Install a real fresh signed proof; its material change triggers recovery immediately.
    const fresh = await proof("paid-new-validation"); h.setWall(Date.now());
    reads.mockImplementationOnce(observe);
    await h.authority.mutateAccess({ kind: "install", proof: fresh, generation: scope.generation,
      issuerNow: fresh.claims.expires_at! - 1, wall: Date.now(), localRights: new Set() });
    await vi.advanceTimersByTimeAsync(0); await cache.refreshAccess(); expect(cache.currentAccess("youtube.comments")).toBe("purchased");
    expect(cache.currentAccessSnapshot().refreshAfterMs).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect(reads).toHaveBeenCalledTimes(4);
    // A real material revocation bypasses the failure recovery interval and fences protection now.
    await h.authority.mutateAccess({ kind: "revoke", right: (await proof("protected-local")).claims.right, revision: 1, generation: scope.generation });
    expect(cache.currentAccess("youtube.comments")).toBe("verification_required");
    await vi.advanceTimersByTimeAsync(0); expect(reads).toHaveBeenCalledTimes(5);
    stop(); const count = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000); expect(reads).toHaveBeenCalledTimes(count);
    expect(h.changed.size).toBe(0); expect(vi.getTimerCount()).toBe(0); reads.mockRestore();
  });

});
