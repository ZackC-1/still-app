import { describe, expect, it, vi } from "vitest";
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
  const cache = new SettingsCache({ get: () => storage.get(), set: r => writer.replace(r).then(() => undefined),
    subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer), initializeAtomic: writer.initialize.bind(writer),
    enterScope: writer.enterScope.bind(writer), acknowledgeAtomic: writer.acknowledge.bind(writer) }, { atomicOwnership: owner, now: () => 100 });
  cache.watch();
  let account = A, revision = empty ? 0 : 1, lastWriteId: string | null = null;
  const seed = empty ? migrateSettingsV2(null, { kind: "proven-fresh" }) : migrateSettingsV2({ ...DEFAULT_SETTINGS, updatedAt: 1 }, { kind: "acknowledged-account", revision });
  if (seed.status !== "ready") throw new Error("fixture");
  let settings = seed.settings;
  const requests: unknown[] = [], claims = new Map<string, string>();
  let release: (() => void) | null = null, started: (() => void) | null = null;
  let readRelease: (() => void) | null = null, readStarted: (() => void) | null = null;
  let profileListener: ((envelope: SyncedSettingsEnvelope) => void) | null = null;
  let reads = 0;
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
    if (release) { const wait = new Promise<void>(r => { release = r; }); started?.(); await wait; }
    return { data: result, error: null };
  });
  const port = new SupabaseBackendPort({ functions: { invoke } } as unknown as SupabaseClient, { modernSettings: true });
  const backend: BackendPort = { modernSettingsEnabled: true, readCanonicalSettings: () => port.readCanonicalSettings(),
    writeSettingsOperation: request => port.writeSettingsOperation(request), reconcileEntitlement: async () => {}, readEntitlement: async () => "not-entitled",
    readProfile: async () => { throw new Error("coarse read forbidden"); }, writeProfile: async () => { throw new Error("coarse write forbidden"); },
    subscribeToProfile: (_subject, listener) => { profileListener = listener; return () => { profileListener = null; }; }, deleteAccount: async () => {} };
  const auth = { currentUserId: async () => account, signOut: async () => {}, signInWithMagicLink: async () => ({}) };
  const service = new SyncService(cache, auth, backend);
  return { cache, writer, storage, service, requests, invoke, port,
    reads: () => reads,
    nudge() { profileListener?.({ settings: { ...settings, pauses: [] }, version: revision,
      serverUpdatedAt: "2026-10-02T00:00:00Z", lastWriteId }); },
    holdRead() {
      const when = new Promise<void>(r => { readStarted = r; });
      readRelease = () => {};
      return { started: when, release() { const go = readRelease; readRelease = null; go?.(); } };
    },
    switchAccount(id: string) { account = id; },
    hold() { let began!: () => void; const when = new Promise<void>(r => { began = r; }); started = began; release = () => {};
      return { started: when, release() { const go = release; release = null; go?.(); } }; },
    peer(path: SettingsField, on: boolean) {
      const next = allocateSettingsFieldEdit({ value: value(settings, path), stamp: settings.clocks[path] }, revision, on);
      if (next.status === "unchanged") return;
      if (next.status !== "edited") throw new Error("peer fixture");
      settings = assign(settings, path, on); settings = { ...settings, clocks: { ...settings.clocks, [path]: next.field.stamp }, updatedAt: 100 + ++revision };
    }, settings: () => settings };
}
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

describe("existing SyncService and exact Supabase modern port", () => {
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
      const prior = structuredClone((await h.storage.get())!.atomic!.pending);
      await h.service.onSignedIn(A);
      expect(h.settings().globalOn).toBe(true);
      expect(h.cache.current().globalOn).toBe(false);
      expect(Object.values(h.cache.current().services).every(on => !on)).toBe(true);
      expect(h.cache.currentRecord().atomic).toMatchObject({ paused: "ownership-hold", held: { globalOn: false, "services.youtube": false } });
      expect((await h.storage.get())!.atomic!.pending).toEqual(prior);
      expect((await h.storage.get())!.settings.globalOn).toBe(true);
      expect(h.requests).toEqual([]);
      await h.service.retryNow(); expect(h.requests).toEqual([]);
      await h.cache.setGlobalOn(true);
      for (const id of ["youtube", "instagram", "facebook", "tiktok"] as const) await h.cache.setService(id, true);
      await drain();
      expect(h.cache.currentRecord().atomic!.held).toEqual({});
      expect(h.cache.currentRecord().atomic!.paused).toBeNull();
      expect(h.requests).toEqual([]); // resolving a hold to the canonical value is no new edit
      expect((await h.storage.get())!.atomic!.pending).toEqual(prior);
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
  it("old RPC acknowledgement cannot erase newer step; saved retry body is not rebased", async () => {
    const h = harness(); await h.cache.hydrate(); await h.service.onSignedIn(A);
    const held = h.hold();
    await h.cache.setGlobalOn(false); await held.started;
    await h.cache.setGlobalOn(true);
    const original = JSON.stringify(h.requests[0]);
    held.release(); await drain();
    expect(h.cache.current().globalOn).toBe(true);
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests[0])).toBe(original);
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
