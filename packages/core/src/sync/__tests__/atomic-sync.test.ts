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
import { EntitlementCache } from "../../entitlement/cache.js";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { createDesktopPopupBinding } from "../../ui/v3/desktop-popup-binding.js";

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
  let accountEmpty = empty, lineage = LINEAGE;
  const seed = empty ? migrateSettingsV2(null, { kind: "proven-fresh" }) : migrateSettingsV2({ ...DEFAULT_SETTINGS, updatedAt: 1 }, { kind: "acknowledged-account", revision });
  if (seed.status !== "ready") throw new Error("fixture");
  let settings = seed.settings;
  const requests: unknown[] = [], claims = new Map<string, string>();
  let release: (() => void) | null = null, started: (() => void) | null = null;
  let readRelease: (() => void) | null = null, readStarted: (() => void) | null = null;
  let profileListener: ((envelope: SyncedSettingsEnvelope) => void) | null = null;
  let reads = 0;
  const failures: ("before" | "after")[] = [];
  const response = () => ({ status: "ready", protocol: 2, empty: accountEmpty && revision === 0, settings: structuredClone(settings), settingsVersion: revision,
    settingsServerUpdatedAt: "2026-10-02T00:00:00Z", writeId: lastWriteId, lineage,
    receipt: { version: 1, lineage, revision, mac: "A".repeat(43) } });
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
  return { cache, writer, storage, service, requests, invoke, port, auth, backend,
    newLifetime() { const nextCache = makeCache(); nextCache.watch(); return { cache: nextCache, service: new SyncService(nextCache, auth, backend) }; },
    canonicalResponse: response,
    useUntouchedCanonicalGlobal() { settings = { ...settings, clocks: { ...settings.clocks, globalOn: { baseRevision: 0, localStep: 0 } } }; },
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
    /** The server side of one account: save it before moving to another, restore it on return. */
    serverAccount() { return { settings: structuredClone(settings), revision, lastWriteId, accountEmpty, lineage }; },
    restoreServerAccount(saved: { settings: SettingsV2; revision: number; lastWriteId: string | null; accountEmpty: boolean; lineage: string }) {
      ({ revision, lastWriteId, accountEmpty, lineage } = saved); settings = structuredClone(saved.settings);
    },
    /** A brand new account with nothing saved (sign-up, or the same email after deletion). */
    newEmptyAccount(nextLineage: string) {
      const fresh = migrateSettingsV2(null, { kind: "proven-fresh" });
      if (fresh.status !== "ready") throw new Error("fixture");
      settings = fresh.settings; revision = 0; lastWriteId = null; accountEmpty = true; lineage = nextLineage;
    },
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
  it.each(["signOut", "deleteAccount"] as const)("never-linked Off survives unavailable first-link proof, %s and later nonempty first link", async teardown => {
    const h = harness("never-linked"); h.useUntouchedCanonicalGlobal();
    await h.cache.hydrate(); await h.cache.setGlobalOn(false); vi.useFakeTimers();
    const before = JSON.stringify(await h.storage.get());
    const original = structuredClone(h.cache.currentRecord().atomic!.pending[0]!);
    const proof = vi.spyOn(h.auth, "currentSettingsSession").mockResolvedValue(null);
    await h.service.onSignedIn(A); await settle();
    expect(JSON.stringify(await h.storage.get())).toBe(before);
    expect(h.reads()).toBe(0); expect(h.requests).toEqual([]); expect(vi.getTimerCount()).toBe(1);
    await h.service[teardown]();
    expect.soft(JSON.stringify(await h.storage.get())).toBe(before);
    expect(h.cache.current().globalOn).toBe(false); expect(vi.getTimerCount()).toBe(0); expect(h.subscriptions()).toBe(0);
    proof.mockRestore(); h.switchSession(NEXT_SESSION);
    const firstReceipt = h.canonicalResponse().receipt;
    const write = h.hold(); const signingIn = h.service.onSignedIn(A); await Promise.race([write.started, signingIn]);
    expect.soft(h.cache.current().globalOn).toBe(false);
    expect.soft(h.cache.currentRecord().atomic!.pending[0]).toMatchObject({ writeId: original.writeId, operations: original.operations,
      originScope: original.scope, scope: { accountId: A, sessionId: NEXT_SESSION } });
    expect.soft(h.requests).toHaveLength(1);
    expect.soft(h.requests[0]).toMatchObject({ writeId: original.writeId, operations: original.operations,
      receipt: firstReceipt });
    write.release(); await signingIn; await settle();
    expect(h.cache.current().globalOn).toBe(false); expect(h.settings().globalOn).toBe(false);
    expect(h.cache.currentRecord().atomic!.pending).toEqual([]);
    await h.service.signOut(); h.cache.watch()(); expect(vi.getTimerCount()).toBe(0); expect(h.subscriptions()).toBe(0);
  });
  it.each(["first-link", "replacement-session", "failed-retirement"] as const)("unconfirmed getUser cannot mutate a %s record", async kind => {
    for (const proof of ["missing", "mismatched", "failed"] as const) {
      const h = harness(); await h.cache.hydrate(); vi.useFakeTimers();
      if (kind !== "first-link") {
        await h.service.onSignedIn(A);
        h.failNext(); await h.cache.setGlobalOn(false); await settle();
        if (kind === "failed-retirement") {
          vi.spyOn(h.storage, "set").mockRejectedValueOnce(new Error("retirement disk failure"));
          await h.service.signOut();
        } else endLifetime(h.service, h.cache);
      } else await h.cache.setGlobalOn(false);
      h.switchSession(NEXT_SESSION);
      const subject = vi.spyOn(h.auth, "currentUserId");
      if (proof === "failed") subject.mockRejectedValue(new Error("getUser unavailable"));
      else subject.mockResolvedValue(proof === "missing" ? null : B);
      const before = JSON.stringify(await h.storage.get());
      const requests = structuredClone(h.requests), reads = h.reads();
      const next = kind === "replacement-session" ? h.newLifetime() : { cache: h.cache, service: h.service };
      await next.cache.hydrate(); await next.service.resume(A, false); await settle();
      expect(JSON.stringify(await h.storage.get())).toBe(before);
      expect(next.cache.current().globalOn).toBe(false);
      expect(h.requests).toEqual(requests); expect(h.reads()).toBe(reads);
      expect(next.service.getState().cloudReachable).toBe(false); expect(vi.getTimerCount()).toBe(1);
      endLifetime(next.service, next.cache); expect(vi.getTimerCount()).toBe(0);
    }
  });
  it.each(["before-write", "after-response"] as const)("missing auth proof %s retries automatically with immutable intent", async phase => {
    for (const proof of ["missing-claims", "undefined-claims", "failed-claims", "missing-subject", "failed-subject"] as const) {
      const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
      const held = phase === "after-response" ? h.hold() : null;
      if (held) { await h.cache.setGlobalOn(false); await held.started; }
      const check = proof.endsWith("claims") ? vi.spyOn(h.auth, "currentSettingsSession") : vi.spyOn(h.auth, "currentUserId");
      if (proof.startsWith("failed")) check.mockRejectedValue(new Error("SDK proof unavailable"));
      else check.mockResolvedValue(proof === "undefined-claims" ? undefined as never : null);
      if (!held) await h.cache.setGlobalOn(false);
      const before = JSON.stringify(await h.storage.get());
      const original = structuredClone(h.cache.currentRecord().atomic!.pending[0]!);
      held?.release(); await settle();
      expect(JSON.stringify(await h.storage.get())).toBe(before);
      expect(h.service.getState()).toMatchObject({ pendingUpload: true, cloudReachable: false });
      expect(vi.getTimerCount()).toBe(1); expect(h.requests).toHaveLength(held ? 1 : 0);
      // Repeated missing proof uses the existing bounded backoff and allocates no new intent.
      await vi.advanceTimersByTimeAsync(1_000); await settle();
      expect(h.cache.currentRecord().atomic!.pending).toEqual([original]);
      expect(vi.getTimerCount()).toBe(1); expect(h.requests).toHaveLength(held ? 1 : 0);
      check.mockRestore();
      await vi.advanceTimersByTimeAsync(1_999); await settle();
      expect(h.cache.currentRecord().atomic!.pending).toEqual([original]);
      await vi.advanceTimersByTimeAsync(1); await settle();
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]).toMatchObject({ writeId: original.writeId, receipt: original.receipt, operations: original.operations });
      expect(h.cache.currentRecord().atomic!.pending).toEqual([]);
      expect(h.cache.current().globalOn).toBe(false);
      expect(h.service.getState()).toMatchObject({ pendingUpload: false, cloudReachable: true });
      expect(vi.getTimerCount()).toBe(0);
      await h.service.signOut(); h.cache.watch()(); expect(h.subscriptions()).toBe(0);
    }
  });
  it.each(["initial-reconcile", "before-write", "after-response"] as const)("late getUser failure during %s cannot poison a newer same-account lifecycle", async phase => {
    const h = harness(); await h.cache.hydrate(); vi.useFakeTimers();
    if (phase !== "initial-reconcile") await h.service.onSignedIn(A);
    const held = phase === "after-response" ? h.hold() : null;
    if (held) { await h.cache.setGlobalOn(false); await held.started; }
    let began!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const proof = new Promise<string | null>((_resolve, fail) => { reject = fail; });
    vi.spyOn(h.auth, "currentUserId").mockImplementationOnce(() => { began(); return proof; });
    const original = phase === "initial-reconcile" ? h.service.onSignedIn(A) :
      held ? Promise.resolve() : h.cache.setGlobalOn(false);
    held?.release(); await started;
    h.switchSession(NEXT_SESSION); await h.service.onSignedIn(A);
    await h.cache.setGlobalOn(false); await settle();
    const before = JSON.stringify(await h.storage.get()), state = structuredClone(h.service.getState());
    const requests = structuredClone(h.requests);
    expect(h.cache.current().globalOn).toBe(false); expect(state.cloudReachable).toBe(true);
    reject(new Error("old getUser failed late")); await original; await settle();
    expect(JSON.stringify(await h.storage.get())).toBe(before);
    expect(h.service.getState()).toEqual(state); expect(h.requests).toEqual(requests);
    expect(vi.getTimerCount()).toBe(0); expect(h.subscriptions()).toBe(1);
    await h.service.signOut(); h.cache.watch()(); expect(h.subscriptions()).toBe(0);
  });
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
  it.each(["verified", "missing-subject", "failed-subject"] as const)("a delayed write response cannot acknowledge intent or retry after verified session replacement (%s)", async proof => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    const held = h.hold(); await h.cache.setGlobalOn(false); await held.started;
    const before = structuredClone(await h.storage.get()); h.switchSession(NEXT_SESSION);
    if (proof === "missing-subject") vi.spyOn(h.auth, "currentUserId").mockResolvedValue(null);
    if (proof === "failed-subject") vi.spyOn(h.auth, "currentUserId").mockRejectedValue(new Error("old subject unavailable"));
    const state = structuredClone(h.service.getState());
    held.release(); await settle(); expect(await h.storage.get()).toEqual(before);
    expect(h.service.getState()).toEqual(state); expect(vi.getTimerCount()).toBe(0);
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
  it("empty account seeds the agreed defaults for unknown/previous-owner all-Off local choices without upload (VD-15)", async () => {
    for (const owner of ["unknown", "previous-account"] as const) {
      const h = harness(owner, true); await h.cache.hydrate();
      await h.cache.setGlobalOn(false);
      for (const id of ["youtube", "instagram", "facebook", "tiktok"] as const) await h.cache.setService(id, false);
      await h.service.onSignedIn(A);
      // The account wins with its defaults: what the page shows is what blocking enforces.
      expect(h.settings().globalOn).toBe(true);
      expect(h.cache.current()).toMatchObject({ globalOn: true, services: { youtube: true, instagram: true, facebook: true, tiktok: true } });
      expect(h.cache.currentRecord().atomic).toMatchObject({ paused: null, held: {}, pending: [] });
      expect((await h.storage.get())!.settings).toMatchObject({ globalOn: true, services: { instagram: true } });
      expect(h.requests).toEqual([]); // nothing of the earlier owner's is uploaded
      expect(h.service.getState()).toMatchObject({ pendingUpload: false, cloudReachable: true });
      await h.service.retryNow(); expect(h.requests).toEqual([]);
      // Commands are available and a new choice is this account's own edit, written with its receipt.
      await h.cache.setService("instagram", false); await drain();
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]).toMatchObject({ receipt: { revision: 0 }, operations: [{ path: "services.instagram", value: false }] });
      expect((h.requests[0] as { operations: unknown[] }).operations).toHaveLength(1);
      expect(h.settings()).toMatchObject({ globalOn: true, services: { youtube: true, instagram: false, facebook: true, tiktok: true } });
      expect(h.service.getState().pendingUpload).toBe(false);
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

// U3-W4 T12: the kill switch is pausing the sync-settings function. While every read and write of
// that function fails, a modern client keeps the person's choices on the device (blocking follows
// them), shows the existing unreachable state, retries no more often than every 30 s, and never
// falls back to the coarse whole-document path. When the function returns, the held choices upload.
describe("sync-settings paused (kill switch rehearsal at the client)", () => {
  it("keeps choices local, stays unreachable with bounded retries, never writes the coarse profile, and recovers", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A); vi.useFakeTimers();
    const serving = h.invoke.getMockImplementation()!;
    const coarseWrite = vi.spyOn(h.backend, "writeProfile");
    const coarseRead = vi.spyOn(h.backend, "readProfile");
    const callTimes: number[] = [];
    const calledFunctions = new Set<string>();
    const paused = vi.fn(async (name: string) => {
      callTimes.push(Date.now());
      calledFunctions.add(name);
      return { data: null, error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { name: "FunctionsHttpError" }) };
    });
    h.invoke.mockImplementation(paused as unknown as typeof serving);
    try {
      await h.cache.setGlobalOn(false); await settle();
      expect(h.service.getState()).toMatchObject({ cloudReachable: false, pendingUpload: true });
      expect(h.cache.current().globalOn).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000); await settle();
      await h.cache.setService("youtube", false); await settle();
      await vi.advanceTimersByTimeAsync(240_000); await settle();
      expect(h.service.getState()).toMatchObject({ cloudReachable: false, pendingUpload: true });
      expect(h.cache.current()).toMatchObject({ globalOn: false, services: { youtube: false } });
      expect(h.cache.currentRecord().atomic!.pending.length).toBeGreaterThan(0);
      const gaps = callTimes.slice(1).map((t, i) => t - callTimes[i]!);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
      expect(callTimes.length).toBeLessThanOrEqual(40); // about one exchange per 30 s over 5 minutes
      expect([...calledFunctions]).toEqual(["sync-settings"]); // only the per-field function is called while paused
      expect(h.settings().globalOn).toBe(true); // nothing reached the server while paused
      expect(coarseWrite).not.toHaveBeenCalled();
      expect(coarseRead).not.toHaveBeenCalled();

      h.invoke.mockImplementation(serving);
      await vi.advanceTimersByTimeAsync(30_000); await settle();
      expect(h.service.getState()).toMatchObject({ cloudReachable: true, pendingUpload: false });
      expect(h.settings().globalOn).toBe(false);
      expect(h.settings().services.youtube).toBe(false);
      expect(h.cache.currentRecord().atomic!.pending).toEqual([]);
    } finally { await h.service.signOut(); h.cache.watch()(); }
    expect(vi.getTimerCount()).toBe(0);
  });
});

// VD-15: a browser linked to account X, holding non-default choices, signs in to a NEW empty
// account Y (sign-up, or the same email after X was deleted). Approved rule (CP-019/020): a
// previous, other or unknown owner entering a definitively empty account seeds the agreed
// defaults and the account wins; X's choices are never uploaded; the switches stay usable.
describe("VD-15 empty-account ownership", () => {
  const Y = "33333333-3333-3333-3333-333333333333";
  const Y_LINEAGE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  type Request = { receipt: { lineage: string; revision: number }; operations: { path: string; value: boolean }[] };
  async function commandsOf(h: ReturnType<typeof harness>) {
    const access = new EntitlementCache({ get: async () => false, set: async () => {}, subscribe: () => () => {},
      observeBenefits: async () => initialAccessSnapshot() });
    await access.refreshAccess();
    return createDesktopPopupBinding(h.cache, access);
  }
  async function linkedToXWithInstagramOff() {
    const h = harness("never-linked"); await h.cache.hydrate();
    await h.service.onSignedIn(A);
    await h.cache.setService("instagram", false); await drain();
    expect(h.settings().services.instagram).toBe(false); // X holds the choice
    const x = h.serverAccount();
    return { h, x };
  }
  async function expectYAdoptedDefaults(h: ReturnType<typeof harness>, before: number) {
    expect(h.cache.current()).toMatchObject({ globalOn: true, services: { youtube: true, instagram: true, facebook: true, tiktok: true } });
    const saved = (await h.storage.get())!;
    expect(saved.settings).toMatchObject({ globalOn: true, services: { instagram: true } }); // what blocking reads
    expect(saved.atomic).toMatchObject({ ownership: "previous-account", paused: null, held: {}, pending: [], anchor: { lineage: Y_LINEAGE, revision: 0 } });
    expect(h.requests).toHaveLength(before); // nothing of X's was uploaded to Y
    expect(h.service.getState()).toMatchObject({ userId: Y, pendingUpload: false, cloudReachable: true });
    const binding = await commandsOf(h);
    expect(binding.current()).toMatchObject({ commandAvailability: "ready", reason: null });
    // Y's own next choice is an ordinary Y write: Y's lineage, only that field.
    expect(await binding.setService("youtube", false)).toEqual({ status: "committed" }); await drain();
    const sent = h.requests.at(-1) as Request;
    expect(h.requests).toHaveLength(before + 1);
    expect(sent).toMatchObject({ receipt: { lineage: Y_LINEAGE, revision: 0 }, operations: [{ path: "services.youtube", value: false }] });
    expect(sent.operations).toHaveLength(1);
    expect(h.settings().services).toMatchObject({ youtube: false, instagram: true });
    expect(h.service.getState().pendingUpload).toBe(false);
    binding.stop();
  }

  it("sign out of X, sign in to a new empty Y: Y holds the defaults, switches work, X's choices stay off Y", async () => {
    const { h } = await linkedToXWithInstagramOff();
    await h.service.signOut();
    expect(h.cache.current().services.instagram).toBe(false); // local choices kept at sign-out
    h.switchAccount(Y); h.newEmptyAccount(Y_LINEAGE);
    const before = h.requests.length;
    await h.service.onSignedIn(Y);
    await expectYAdoptedDefaults(h, before);
    await h.service.signOut(); h.cache.watch()();
  });

  it("X deleted, then the same email signs up again (a new uid): the same defaults, no lock-up", async () => {
    const { h } = await linkedToXWithInstagramOff();
    await h.service.deleteAccount();
    h.switchAccount(Y); h.newEmptyAccount(Y_LINEAGE);
    const before = h.requests.length;
    await h.service.onSignedIn(Y);
    await expectYAdoptedDefaults(h, before);
    await h.service.signOut(); h.cache.watch()();
  });

  it("a 2.x upgrader (ownership unknown) with a changed switch signing in to a new account starts from the defaults", async () => {
    const h = harness("unknown", true); await h.cache.hydrate();
    expect(h.cache.currentRecord().atomic!.ownership).toBe("unknown");
    await h.cache.setService("instagram", false);
    h.switchAccount(Y); h.newEmptyAccount(Y_LINEAGE);
    await h.service.onSignedIn(Y);
    await expectYAdoptedDefaults(h, 0);
    await h.service.signOut(); h.cache.watch()();
  });

  it("A to empty B to A: B gets defaults without A's choice, A's own row comes back on return", async () => {
    const { h, x } = await linkedToXWithInstagramOff();
    await h.service.signOut();
    h.switchAccount(Y); h.newEmptyAccount(Y_LINEAGE);
    const before = h.requests.length;
    await h.service.onSignedIn(Y);
    expect(h.cache.current().services.instagram).toBe(true);
    expect(h.requests).toHaveLength(before);
    await h.cache.setService("facebook", false); await drain(); // B's own choice
    expect(h.requests).toHaveLength(before + 1);
    await h.service.signOut();
    h.switchAccount(A); h.restoreServerAccount(x);
    await h.service.onSignedIn(A);
    expect(h.cache.current().services).toMatchObject({ instagram: false, facebook: true }); // A's row; B's choice stays in B
    expect(h.cache.currentRecord().atomic).toMatchObject({ paused: null, held: {}, pending: [] });
    expect(h.requests).toHaveLength(before + 1); // nothing of B's went to A
    expect(h.settings().services.facebook).toBe(true);
    await h.service.signOut(); h.cache.watch()();
  });

  it("a never-linked first sign-in to an empty account still seeds its explicit choices", async () => {
    const h = harness("never-linked", true); await h.cache.hydrate();
    await h.cache.setService("instagram", false);
    await h.service.onSignedIn(A); await drain();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ receipt: { revision: 0 }, operations: [{ path: "services.instagram", value: false }] });
    expect(h.settings().services.instagram).toBe(false);
    expect(h.cache.current().services.instagram).toBe(false);
    expect(h.cache.currentRecord().atomic).toMatchObject({ paused: null, held: {} });
    await h.service.signOut(); h.cache.watch()();
  });

  it("a same-account offline edit is kept and sent once the account is reachable again", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A);
    h.failNext("before");
    await h.cache.setService("instagram", false); await drain();
    expect(h.service.getState()).toMatchObject({ cloudReachable: false, pendingUpload: true });
    expect(h.cache.current().services.instagram).toBe(false);
    expect(h.cache.currentRecord().atomic).toMatchObject({ paused: null, held: {} });
    await h.service.retryNow(); await drain();
    expect(h.settings().services.instagram).toBe(false);
    expect(h.service.getState()).toMatchObject({ cloudReachable: true, pendingUpload: false });
    await h.service.signOut(); h.cache.watch()();
  });

  describe("a stored ownership-hold from an earlier build always has a way out", () => {
    // What VD-15 left behind: Y's defaults saved, X's Instagram-off held over them, every switch off.
    async function stuckOnY() {
      const h = harness("never-linked", true); h.switchAccount(Y); h.newEmptyAccount(Y_LINEAGE); await h.cache.hydrate();
      await h.service.onSignedIn(Y); await drain();
      const record = (await h.storage.get())!;
      await h.storage.set({ ...record, atomic: { ...record.atomic!, ownership: "previous-account", sequence: record.atomic!.sequence + 1,
        paused: "ownership-hold", held: { "services.instagram": false } } });
      await drain();
      expect(h.cache.currentRecord().atomic!.paused).toBe("ownership-hold");
      const binding = await commandsOf(h);
      expect(binding.current()).toMatchObject({ commandAvailability: "unavailable", reason: "ownership-hold" });
      binding.stop();
      return h;
    }
    async function expectRecovered(h: ReturnType<typeof harness>, before: number) {
      expect(h.cache.currentRecord().atomic).toMatchObject({ paused: null, held: {} });
      expect(h.cache.current().services.instagram).toBe(true);
      expect(h.requests).toHaveLength(before);
      const binding = await commandsOf(h);
      expect(binding.current().commandAvailability).toBe("ready");
      binding.stop();
    }
    it("Try again (a sync retry) recovers", async () => {
      const h = await stuckOnY(); const before = h.requests.length;
      await h.service.retryNow(); await drain();
      await expectRecovered(h, before);
      expect(h.service.getState().pendingUpload).toBe(false);
      await h.service.signOut(); h.cache.watch()();
    });
    it("a worker restart recovers", async () => {
      const h = await stuckOnY(); const before = h.requests.length;
      endLifetime(h.service, h.cache);
      const next = h.newLifetime(); await next.cache.hydrate();
      await next.service.resume(Y, false); await drain();
      expect(next.cache.currentRecord().atomic).toMatchObject({ paused: null, held: {} });
      expect(next.cache.current().services.instagram).toBe(true);
      expect(h.requests).toHaveLength(before);
      expect(next.service.getState().pendingUpload).toBe(false);
      await next.service.signOut(); next.cache.watch()();
    });
    it("signing out releases the hold back to local-only control", async () => {
      const h = await stuckOnY(); const before = h.requests.length;
      h.invoke.mockRejectedValue(new Error("offline")); // sign-out alone must be enough
      await h.service.signOut(); await drain();
      expect(h.service.getState().userId).toBeNull();
      await expectRecovered(h, before);
      await h.cache.setService("instagram", false);
      expect((await h.storage.get())!.settings.services.instagram).toBe(false);
      h.cache.watch()();
    });
  });
});
