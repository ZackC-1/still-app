import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_FIELDS, readSettingsOperationRequest, type SettingsField, type SettingsV2 } from "@still/shared-types";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter, type SyncedSettingsEnvelope } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { migrateSettingsV2 } from "../../storage/settings-v2.js";
import { allocateSettingsFieldEdit, mergeSettingsField } from "../field-order.js";
import { SupabaseBackendPort } from "../profile.js";
import { SyncService } from "../service.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BackendPort } from "../ports.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const LINEAGE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const NEXT_SESSION = "dddddddd-dddd-dddd-dddd-dddddddddddd";
function value(settings: SettingsV2, path: SettingsField): boolean {
  if (path === "globalOn") return settings.globalOn;
  return (path.startsWith("services.") ? settings.services[path.slice(9)] : settings.sites[path.slice(6)]) as boolean;
}
function assign(settings: SettingsV2, path: SettingsField, on: boolean): SettingsV2 {
  if (path === "globalOn") return { ...settings, globalOn: on };
  const group = path.startsWith("services.") ? "services" : "sites";
  return { ...settings, [group]: { ...settings[group], [path.slice(group.length + 1)]: on } };
}
function harness(owner: "unknown" | "never-linked" | "previous-account" = "unknown", empty = false) {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
  const writer = new AtomicSettingsWriter(storage);
  const makeCache = () => new SettingsCache({ get: () => storage.get(), set: r => writer.replace(r).then(() => undefined),
    subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer), initializeAtomic: writer.initialize.bind(writer),
    enterScope: writer.enterScope.bind(writer), acknowledgeAtomic: writer.acknowledge.bind(writer) }, { atomicOwnership: owner, now: () => 100 });
  const cache = makeCache();
  cache.watch();
  let account: string | null = A;
  let sessionId = SESSION;
  let revision = empty ? 0 : 1, lastWriteId: string | null = null;
  const seed = empty ? migrateSettingsV2(null, { kind: "proven-fresh" }) : migrateSettingsV2({ ...DEFAULT_SETTINGS, updatedAt: 1 }, { kind: "acknowledged-account", revision });
  if (seed.status !== "ready") throw new Error("fixture");
  let settings = seed.settings;
  const requests: unknown[] = [], claims = new Map<string, string>();
  let release: (() => void) | null = null, started: (() => void) | null = null;
  let readRelease: (() => void) | null = null, readStarted: (() => void) | null = null;
  let profileListener: ((envelope: SyncedSettingsEnvelope) => void) | null = null;
  let reads = 0;
  const failures: ("before" | "after")[] = [];
  const response = () => ({ status: "ready", protocol: 2, empty: empty && revision === 0, settings: structuredClone(settings), settingsVersion: revision,
    settingsServerUpdatedAt: "2026-10-02T00:00:00Z", writeId: lastWriteId, lineage: LINEAGE,
    receipt: { version: 1, lineage: LINEAGE, revision, mac: "A".repeat(43) } });
  const invoke = vi.fn(async (_name: string, options: { body: unknown }) => {
    const body = options.body as { action?: string };
    if (body.action === "read") {
      reads += 1;
      const data = response();
      if (readRelease) {
        const wait = new Promise<void>(r => { readRelease = r; });
        readStarted?.();
        await wait;
      }
      return { data, error: null };
    }
    const parsed = readSettingsOperationRequest(body);
    if (parsed.status !== "parsed") return { data: null, error: new Error("request-shape") };
    const request = parsed.request;
    requests.push(structuredClone(request));
    const failure = failures.shift();
    if (failure === "before") return { data: null, error: new Error("offline before application") };
    const bytes = JSON.stringify(request), prior = claims.get(request.writeId);
    if (prior && prior !== bytes) return { data: null, error: new Error("write-id-conflict") };
    if (!prior) {
      claims.set(request.writeId, bytes);
      let changed = false;
      for (const op of request.operations) {
        const current = { value: value(settings, op.path), stamp: settings.clocks[op.path] };
        const merged = mergeSettingsField(current, { value: op.value, stamp: { ...current.stamp, baseRevision: op.baseRevision, localStep: op.localStep } });
        if (JSON.stringify(merged) !== JSON.stringify(current)) changed = true;
        settings = assign(settings, op.path, merged.value);
        settings = { ...settings, clocks: { ...settings.clocks, [op.path]: merged.stamp } };
      }
      if (changed) { revision += 1; lastWriteId = request.writeId; settings = { ...settings, updatedAt: 100 + revision }; }
    }
    const result = response();
    if (failure === "after") return { data: null, error: new Error("applied but response lost") };
    if (release) { const wait = new Promise<void>(r => { release = r; }); started?.(); await wait; }
    return { data: result, error: null };
  });
  const port = new SupabaseBackendPort({ functions: { invoke } } as unknown as SupabaseClient, { modernSettings: true });
  const backend: BackendPort = { modernSettingsEnabled: true, readCanonicalSettings: () => port.readCanonicalSettings(),
    writeSettingsOperation: request => port.writeSettingsOperation(request), reconcileEntitlement: async () => {}, readEntitlement: async () => "not-entitled",
    readProfile: async () => { throw new Error("coarse read forbidden"); }, writeProfile: async () => { throw new Error("coarse write forbidden"); },
    subscribeToProfile: (_subject, listener) => { profileListener = listener; return () => { profileListener = null; }; }, deleteAccount: async () => {} };
  const auth = { currentUserId: async () => account,
    currentSettingsSession: async () => account === null ? null : { userId: account, sessionId },
    signOut: async () => {}, signInWithMagicLink: async () => ({}) };
  const service = new SyncService(cache, auth, backend);
  return { cache, writer, storage, service, requests, invoke, port, auth,
    newLifetime() { const nextCache = makeCache(); nextCache.watch(); return { cache: nextCache, service: new SyncService(nextCache, auth, backend) }; },
    canonicalResponse: response,
    failNext(mode: "before" | "after" = "before") { failures.push(mode); },
    subscriptions: () => profileListener === null ? 0 : 1,
    reads: () => reads,
    nudge() { profileListener?.({ settings: { ...settings, pauses: [] }, version: revision,
      serverUpdatedAt: "2026-10-02T00:00:00Z", lastWriteId }); },
    holdRead() {
      const when = new Promise<void>(r => { readStarted = r; });
      readRelease = () => {};
      return { started: when, release() { const go = readRelease; readRelease = null; go?.(); } };
    },
    switchAccount(id: string | null) { account = id; },
    switchSession(id: string) { sessionId = id; },
    hold() { let began!: () => void; const when = new Promise<void>(r => { began = r; }); started = began; release = () => {};
      return { started: when, release() { const go = release; release = null; go?.(); } }; },
    peer(path: SettingsField, on: boolean) {
      const next = allocateSettingsFieldEdit({ value: value(settings, path), stamp: settings.clocks[path] }, revision, on);
      if (next.status === "unchanged") return;
      if (next.status !== "edited") throw new Error("peer fixture");
      settings = assign(settings, path, on); settings = { ...settings, clocks: { ...settings.clocks, [path]: next.field.stamp }, updatedAt: 100 + ++revision };
    }, settings: () => settings };
}
// Process termination cancels volatile work/subscriptions without calling the durable sign-out action.
function endLifetime(service: SyncService, cache: SettingsCache) {
  const host = service as unknown as { stopWriteThrough(): void; stopRealtime(): void };
  host.stopWriteThrough(); host.stopRealtime(); cache.watch()();
}
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
const settle = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("existing SyncService and exact Supabase modern port", () => {
  it.each([false, true])("failed explicit retirement never revives an old write after same-account authentication (restart=%s)", async restart => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    h.failNext(); await h.cache.setGlobalOn(false); await settle();
    const before = (await h.storage.get())!;
    const oldWrite = structuredClone(h.requests[0]);
    vi.spyOn(h.storage, "set").mockRejectedValueOnce(new Error("null-scope disk failure"));
    vi.spyOn(h.auth, "signOut").mockImplementation(async () => { h.switchAccount(null); });
    await h.service.signOut();
    expect(await h.auth.currentUserId()).toBeNull();
    expect(h.service.getState().userId).toBeNull();
    expect(h.cache.current().globalOn).toBe(false);
    expect((await h.storage.get())!.atomic!.pending).toEqual(before.atomic!.pending);
    expect(h.subscriptions()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    if (restart) endLifetime(h.service, h.cache);
    h.switchAccount(A);
    h.switchSession(NEXT_SESSION);
    const next = restart ? h.newLifetime() : { service: h.service, cache: h.cache };
    await next.cache.hydrate();
    if (restart) await next.service.resume(A, false);
    else await next.service.onSignedIn(A);
    await settle();
    expect(h.requests).toEqual([oldWrite]);
    expect(next.cache.currentRecord().atomic!.scope.generation).toBeGreaterThan(before.atomic!.scope.generation);
    await next.service.signOut(); next.cache.watch()();
    expect(h.subscriptions()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["resume", "onSignedIn"] as const)("a second SyncService lifetime resumes the same immutable offline operation without a null transition (%s)", async entry => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    h.failNext(); await h.cache.setGlobalOn(false); await settle();
    const durable = (await h.storage.get())!; const original = structuredClone(durable.atomic!.pending[0]!);
    expect(h.requests).toHaveLength(1); endLifetime(h.service, h.cache); expect(vi.getTimerCount()).toBe(0);
    const next = h.newLifetime(); await next.cache.hydrate(); const read = h.holdRead();
    const resumed = entry === "resume" ? next.service.resume(A, false) : next.service.onSignedIn(A); await read.started;
    expect(durable.atomic!.scope.sessionId).toBe(SESSION);
    expect(next.cache.currentRecord().atomic!.scope).toEqual(durable.atomic!.scope);
    expect(next.cache.currentRecord().atomic!.pending).toEqual([original]);
    read.release(); await resumed; await settle();
    expect(h.requests).toHaveLength(2); expect(h.requests[1]).toEqual(h.requests[0]);
    expect(next.cache.current().globalOn).toBe(false); expect(next.cache.currentRecord().atomic!.pending).toEqual([]);
    expect(next.service.getState().pendingUpload).toBe(false);
    await next.service.signOut(); next.cache.watch()(); expect(h.subscriptions()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("failed retirement holds same-session uploads until the null transition actually commits", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    h.failNext(); await h.cache.setGlobalOn(false); await settle();
    const before = (await h.storage.get())!; const requests = structuredClone(h.requests);
    vi.spyOn(h.storage, "set").mockRejectedValueOnce(new Error("disk unavailable")).mockRejectedValueOnce(new Error("disk still unavailable"));
    await h.service.signOut(); await h.service.onSignedIn(A); await settle();
    expect(await h.storage.get()).toEqual(before); expect(h.cache.current().globalOn).toBe(false);
    expect(h.requests).toEqual(requests); expect(h.service.getState().cloudReachable).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); await settle();
    expect(h.requests).toEqual(requests);
    expect(h.cache.currentRecord().atomic!.scope.generation).toBeGreaterThan(before.atomic!.scope.generation);
    expect(h.cache.currentRecord().atomic!.scope.sessionId).toBe(SESSION);
    expect(h.service.getState().cloudReachable).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await h.service.signOut(); h.cache.watch()(); expect(h.subscriptions()).toBe(0);
  });
  it.each(["missing-session", "unverified-auth", "missing-capability", "ended-auth-subject"])("a restarted host holds upload with %s while retaining useful choices and complete provenance", async reason => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    h.failNext(); await h.cache.setGlobalOn(false); await settle(); endLifetime(h.service, h.cache);
    if (reason === "missing-session") {
      const old = structuredClone((await h.storage.get())!);
      delete (old.atomic!.scope as { sessionId?: string }).sessionId;
      for (const pending of old.atomic!.pending) delete (pending.scope as { sessionId?: string }).sessionId;
      await h.storage.set(old);
    } else if (reason === "unverified-auth") vi.spyOn(h.auth, "currentSettingsSession").mockResolvedValue(null);
    else if (reason === "missing-capability") delete (h.auth as Partial<typeof h.auth>).currentSettingsSession;
    else vi.spyOn(h.auth, "currentUserId").mockResolvedValue(null);
    const before = structuredClone(await h.storage.get()); const requests = structuredClone(h.requests); const reads = h.reads();
    const next = h.newLifetime(); await next.cache.hydrate(); await next.service.resume(A, false); await settle();
    expect(await h.storage.get()).toEqual(before); expect(next.cache.current().globalOn).toBe(false);
    expect(h.requests).toEqual(requests); expect(h.reads()).toBe(reads);
    expect(next.service.getState()).toMatchObject({ userId: A, cloudReachable: false }); expect(vi.getTimerCount()).toBe(1);
    await next.service.signOut(); next.cache.watch()(); expect(vi.getTimerCount()).toBe(0); expect(h.subscriptions()).toBe(0);
  });
  it("a delayed write response cannot acknowledge intent after verified session replacement for the same UUID", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A);
    const held = h.hold(); await h.cache.setGlobalOn(false); await held.started;
    const before = structuredClone(await h.storage.get()); h.switchSession(NEXT_SESSION);
    held.release(); await drain(); expect(await h.storage.get()).toEqual(before);
    await h.service.signOut(); h.cache.watch()(); expect(h.subscriptions()).toBe(0);
  });
  it("a second SyncService lifetime preserves pre-anchor held choice on reconnect to a nonempty row", async () => {
    const h = harness("never-linked"); await h.cache.hydrate();
    h.invoke.mockResolvedValueOnce({ data: null as never, error: new Error("offline own-row read") });
    await h.service.onSignedIn(A); endLifetime(h.service, h.cache);
    await h.cache.setGlobalOn(false); const durable = (await h.storage.get())!;
    expect(durable.atomic).toMatchObject({ anchor: null, paused: "awaiting-anchor", held: { globalOn: false } });
    const next = h.newLifetime(); await next.cache.hydrate(); const read = h.holdRead();
    const resumed = next.service.resume(A, false); await read.started;
    expect(next.cache.currentRecord().atomic!.scope).toEqual(durable.atomic!.scope);
    read.release(); await resumed;
    expect(next.cache.current().globalOn).toBe(false); expect(h.settings().globalOn).toBe(true);
    expect(next.cache.currentRecord().atomic).toMatchObject({ anchor: { revision: 1 }, held: { globalOn: false }, pending: [] });
    expect(h.requests).toEqual([]); expect(next.service.getState().pendingUpload).toBe(true);
    await next.service.signOut(); next.cache.watch()(); expect(h.subscriptions()).toBe(0);
  });
  it("same-account process restart preserves held explicit choices across a delayed nonempty canonical read", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); endLifetime(h.service, h.cache);
    for (let i = 0; i < 65; i++) await h.cache.setGlobalOn(i % 2 !== 0);
    const durable = (await h.storage.get())!; expect(durable.atomic!.held).toEqual({ globalOn: false });
    const next = h.newLifetime(); await next.cache.hydrate(); const read = h.holdRead();
    const resumed = next.service.resume(A, false); await read.started;
    expect(next.cache.currentRecord().atomic!.scope).toEqual(durable.atomic!.scope);
    expect(next.cache.currentRecord().atomic!.anchor).toEqual(durable.atomic!.anchor);
    expect(next.cache.current().globalOn).toBe(false);
    read.release(); await resumed;
    expect(h.requests).toHaveLength(64);
    expect(h.requests.map(r => (r as { writeId: string }).writeId)).toEqual(durable.atomic!.pending.map(p => p.writeId));
    expect(next.cache.currentRecord().atomic).toMatchObject({ pending: [], held: { globalOn: false } });
    expect(next.cache.current().globalOn).toBe(false);
    await next.service.signOut(); next.cache.watch()(); expect(h.subscriptions()).toBe(0);
  });
  it.each([A, B])("64 retired operations cannot block a fresh action after actual sign-out and sign-in to %s", async account => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); endLifetime(h.service, h.cache);
    for (let i = 0; i < 64; i++) await h.cache.setGlobalOn(i % 2 !== 0);
    const old = (await h.storage.get())!.atomic!; expect(old.pending).toHaveLength(64);
    await h.service.signOut(); h.switchAccount(account); await h.service.onSignedIn(account);
    expect(h.cache.currentRecord().atomic!.scope.generation).toBeGreaterThan(old.scope.generation);
    expect(h.cache.currentRecord().atomic).toMatchObject({ pending: [], ownership: "previous-account" });
    expect(h.requests).toEqual([]);
    await h.cache.setService("youtube", false); await drain();
    expect(h.requests).toHaveLength(1); expect(h.requests[0]).toMatchObject({ operations: [{ path: "services.youtube", value: false }] });
    expect(old.pending.some(p => p.writeId === (h.requests[0] as { writeId: string }).writeId)).toBe(false);
    expect(h.cache.currentRecord().atomic).toMatchObject({ pending: [], paused: null });
    await h.service.signOut(); h.cache.watch()(); expect(h.subscriptions()).toBe(0);
  });
  it.each([false, true])("actual sign-out returning to A fences a delayed response (viaB=%s)", async viaB => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A);
    const held = h.hold(); await h.cache.setGlobalOn(false); await held.started;
    const old = h.cache.currentRecord().atomic!.scope;
    await h.service.signOut();
    if (viaB) { h.switchAccount(B); await h.service.onSignedIn(B); await h.service.signOut(); }
    h.switchAccount(A); await h.service.onSignedIn(A); const before = await h.storage.get();
    expect(before!.atomic!.scope.generation).toBeGreaterThan(old.generation);
    held.release(); await drain(); expect(await h.storage.get()).toEqual(before);
    expect(h.requests).toHaveLength(1); await h.service.signOut(); h.cache.watch()();
  });

  it.each(["lineage", "revision", "future", "legacy", "field-base", "damaged"])("rejects %s canonical response without changing durable bytes", async variant => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    try {
      const damaged = h.canonicalResponse() as unknown as Record<string, unknown>;
      const receipt = damaged.receipt as Record<string, unknown>;
      const settings = damaged.settings as Record<string, unknown>;
      if (variant === "lineage") damaged.lineage = B;
      if (variant === "revision") receipt.revision = 2;
      if (variant === "future") settings.schemaVersion = 99;
      if (variant === "legacy") damaged.settings = { ...DEFAULT_SETTINGS, updatedAt: 7, services: { youtube: false } };
      if (variant === "field-base") (settings.clocks as Record<string, unknown>).globalOn = { baseRevision: 2, localStep: 1 };
      if (variant === "damaged") settings.globalOn = 1;
      const before = await h.storage.get();
      h.invoke.mockResolvedValueOnce({ data: damaged as never, error: null });
      await expect(h.port.readCanonicalSettings()).rejects.toThrow("invalid-canonical-settings");
      h.invoke.mockResolvedValueOnce({ data: damaged as never, error: null });
      await h.service.retryNow();
      expect(await h.storage.get()).toEqual(before); expect(h.requests).toEqual([]);
      expect(h.service.getState().cloudReachable).toBe(false);
    } finally { await h.service.signOut(); h.cache.watch()(); }
    expect(vi.getTimerCount()).toBe(0);
  });
  it("actually retries the complete immutable failed operation after a newer read and later local edit", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    try {
      h.failNext(); await h.cache.setGlobalOn(false); await settle();
      expect(h.requests).toHaveLength(1); const original = JSON.stringify(h.requests[0]);
      expect(h.service.getState()).toMatchObject({ pendingUpload: true, cloudReachable: false });
      expect(vi.getTimerCount()).toBe(1);
      h.peer("services.youtube", false); const held = h.holdRead();
      await vi.advanceTimersByTimeAsync(1_000); await held.started;
      await h.cache.setGlobalOn(true); expect(h.requests).toHaveLength(1);
      held.release(); await vi.advanceTimersByTimeAsync(0); await settle();
      expect(h.requests).toHaveLength(3); expect(JSON.stringify(h.requests[1])).toBe(original);
      expect(h.requests[2]).toMatchObject({ receipt: { revision: 1 }, operations: [{ path: "globalOn", value: true, baseRevision: 1, localStep: 2 }] });
      expect(h.cache.current()).toMatchObject({ globalOn: true, services: { youtube: false } });
      expect(h.cache.currentRecord().atomic!.pending).toEqual([]);
      expect(h.service.getState().pendingUpload).toBe(false); expect(vi.getTimerCount()).toBe(0);
    } finally { await h.service.signOut(); h.cache.watch()(); }
    expect(h.subscriptions()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("an applied but lost acknowledgement retires the original intent on read without allocating a retry", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    try {
      h.failNext("after"); await h.cache.setGlobalOn(false); await settle();
      expect(h.requests).toHaveLength(1); const original = structuredClone(h.requests[0]);
      expect(h.cache.currentRecord().atomic!.pending).toHaveLength(1); expect(h.service.getState().pendingUpload).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000); await settle();
      expect(h.requests).toEqual([original]); expect(h.cache.currentRecord().atomic!.pending).toEqual([]);
      expect(h.cache.currentRecord().atomic!.anchor!.revision).toBe(2);
      expect(h.service.getState().pendingUpload).toBe(false); expect(vi.getTimerCount()).toBe(0);
    } finally { await h.service.signOut(); h.cache.watch()(); }
  });
  it("sign-out cancels a scheduled modern retry and realtime subscription", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    h.failNext(); await h.cache.setGlobalOn(false); await settle(); expect(vi.getTimerCount()).toBe(1);
    await h.service.signOut(); h.cache.watch()(); const calls = h.invoke.mock.calls.length;
    expect(h.subscriptions()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000); await h.cache.setService("youtube", false); await settle();
    expect(h.invoke.mock.calls).toHaveLength(calls); expect(h.requests).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("64 committed operations drain despite a held 65th choice and survive cache restart", async () => {
    const h = harness("never-linked", true); await h.cache.hydrate();
    for (let i = 0; i < 65; i++) await h.cache.setGlobalOn(i % 2 !== 0);
    expect(h.cache.currentRecord().atomic).toMatchObject({ paused: "pending-limit", held: { globalOn: false } });
    const original = structuredClone(h.cache.currentRecord().atomic!.pending);
    expect(original).toHaveLength(64);
    await h.service.onSignedIn(A);
    expect(h.requests).toHaveLength(64);
    expect(h.requests.map(r => (r as { writeId: string }).writeId)).toEqual(original.map(p => p.writeId));
    expect(h.cache.currentRecord().atomic!.pending).toEqual([]);
    const restarted = new SettingsCache({ get: () => h.storage.get(), set: r => h.storage.set(r), subscribe: h.storage.subscribe.bind(h.storage) });
    await restarted.hydrate(); expect(restarted.current().globalOn).toBe(false);
    expect(h.service.getState().pendingUpload).toBe(true); // unresolved unranked choice is retained
    await h.cache.setGlobalOn(true); await settle();
    expect(h.cache.currentRecord().atomic).toMatchObject({ paused: null, held: {} });
    expect(h.service.getState().pendingUpload).toBe(false); expect(h.requests).toHaveLength(64);
    await h.service.signOut(); h.cache.watch()(); expect(h.subscriptions()).toBe(0);
  });
  it("one idle realtime nudge performs one authenticated read and one durable acknowledgement", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A);
    const reads = h.reads(), sequence = h.cache.currentRecord().atomic!.sequence;
    h.peer("services.youtube", false); h.nudge(); await drain();
    expect(h.cache.current().services.youtube).toBe(false);
    expect(h.reads() - reads).toBe(1);
    expect(h.cache.currentRecord().atomic!.sequence - sequence).toBe(1);
    expect(h.requests).toEqual([]);
    await h.service.signOut(); h.cache.watch()();
  });
  it("a nudge during an active read retains one follow-up to obtain newer canonical state", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A);
    const reads = h.reads(), sequence = h.cache.currentRecord().atomic!.sequence;
    const held = h.holdRead();
    h.nudge(); await held.started;
    h.peer("services.youtube", false); h.nudge(); h.nudge();
    held.release(); await drain();
    expect(h.cache.current().services.youtube).toBe(false);
    expect(h.reads() - reads).toBe(2);
    expect(h.cache.currentRecord().atomic!.sequence - sequence).toBe(2);
    expect(h.requests).toEqual([]);
    await h.service.signOut(); h.cache.watch()();
  });
  it("empty account defaults keep unknown/previous-owner all-Off local choices held without upload", async () => {
    for (const owner of ["unknown", "previous-account"] as const) {
      const h = harness(owner, true); await h.cache.hydrate();
      await h.cache.setGlobalOn(false);
      for (const id of ["youtube", "instagram", "facebook", "tiktok"] as const) await h.cache.setService(id, false);
      await h.service.onSignedIn(A);
      expect(h.settings().globalOn).toBe(true);
      expect(h.cache.current().globalOn).toBe(false);
      expect(Object.values(h.cache.current().services).every(on => !on)).toBe(true);
      expect(h.cache.currentRecord().atomic).toMatchObject({ paused: "ownership-hold", held: { globalOn: false, "services.youtube": false } });
      expect((await h.storage.get())!.atomic!.pending).toEqual([]);
      expect((await h.storage.get())!.settings.globalOn).toBe(true);
      expect(h.requests).toEqual([]);
      await h.service.retryNow(); expect(h.requests).toEqual([]);
      await h.cache.setGlobalOn(true);
      for (const id of ["youtube", "instagram", "facebook", "tiktok"] as const) await h.cache.setService(id, true);
      await drain();
      expect(h.cache.currentRecord().atomic!.held).toEqual({});
      expect(h.cache.currentRecord().atomic!.paused).toBeNull();
      expect(h.requests).toEqual([]); // resolving a hold to the canonical value is no new edit
      expect((await h.storage.get())!.atomic!.pending).toEqual([]);
      await h.service.signOut(); h.cache.watch()();
    }
  });
  it("existing account wins unknown/previous-owner choices while proven never-linked empty intent seeds", async () => {
    for (const owner of ["unknown", "previous-account", "never-linked"] as const) {
      const h = harness(owner, owner === "never-linked"); await h.cache.hydrate();
      await h.cache.setGlobalOn(false); await h.service.onSignedIn(A);
      expect(h.cache.current().globalOn).toBe(owner !== "never-linked");
      expect(h.requests).toHaveLength(owner === "never-linked" ? 1 : 0);
      expect(h.cache.currentRecord().atomic!.held).toEqual({});
      if (owner === "never-linked") expect(h.requests[0]).toMatchObject({ receipt: { revision: 0 }, operations: [{ baseRevision: 0, localStep: 1 }] });
      await h.service.signOut(); h.cache.watch()();
    }
  });
  it("uploads real cache intent as receipt-bound partial operation and preserves saved independent peer key", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A);
    h.peer("services.youtube", false);
    await h.cache.setGlobalOn(false); await drain();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ protocol: 2, receipt: { revision: 1 }, operations: [{ path: "globalOn", value: false, baseRevision: 1, localStep: 1 }] });
    expect(h.cache.current()).toMatchObject({ globalOn: false, services: { youtube: false } });
    expect(h.cache.currentRecord().atomic!.pending).toEqual([]);
    expect(h.service.getState().pendingUpload).toBe(false);
    await h.service.signOut();
  });
  it("old RPC acknowledgement preserves a newer step with its captured receipt", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A);
    const held = h.hold();
    await h.cache.setGlobalOn(false); await held.started;
    await h.cache.setGlobalOn(true);
    held.release(); await drain();
    expect(h.cache.current().globalOn).toBe(true);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toMatchObject({ receipt: { revision: 1 }, operations: [{ value: true, baseRevision: 1, localStep: 2 }] });
    expect(h.cache.currentRecord().atomic!.pending).toEqual([]);
    await h.service.signOut();
  });
  it("A-to-B-to-A invalidates a delayed actual port response and teardown leaves no upload", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A);
    const held = h.hold(); await h.cache.setGlobalOn(false); await held.started;
    await h.service.signOut(); h.switchAccount(B); await h.service.onSignedIn(B);
    await h.service.signOut(); h.switchAccount(A); await h.service.onSignedIn(A);
    const before = await h.storage.get(); held.release(); await drain();
    expect(await h.storage.get()).toEqual(before);
    await h.service.signOut(); const requests = h.requests.length;
    await h.cache.setService("youtube", false); await drain();
    expect(h.requests).toHaveLength(requests);
  });
  it("disabled real port makes no endpoint call, and malformed partial request rejects before invoke", async () => {
    const h = harness(); const disabled = new SupabaseBackendPort({ functions: { invoke: h.invoke } } as unknown as SupabaseClient);
    await expect(disabled.readCanonicalSettings()).rejects.toThrow("rollout-held");
    await expect(h.port.writeSettingsOperation({ protocol: 2 } as never)).rejects.toThrow("request-shape");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("all-Off canonical roundtrip has no default seeding or implicit operations", async () => {
    const h = harness(); await h.cache.hydrate();
    for (const path of SETTINGS_FIELDS) h.peer(path, false);
    await h.service.onSignedIn(A);
    expect(h.cache.current().globalOn).toBe(false);
    expect(Object.values(h.cache.current().services).every(on => !on)).toBe(true);
    expect(h.requests).toEqual([]);
    await h.service.signOut();
  });
});
