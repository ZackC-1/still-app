import { expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SETTINGS, readSettingsOperationRequest, type SettingsField, type SettingsV2 } from "@still/shared-types";
import { AtomicSettingsWriter } from "../../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../../storage/adapter.js";
import { SettingsCache } from "../../../storage/cache.js";
import { migrateSettingsV2 } from "../../../storage/settings-v2.js";
import { mergeSettingsField } from "../../field-order.js";
import { SupabaseBackendPort } from "../../profile.js";
import type { BackendRouteProfile } from "../../backend-route-profile.js";
import { SyncService, type SyncState } from "../../service.js";
import { EntitlementCache } from "../../../entitlement/cache.js";
import { initialAccessSnapshot } from "../../../entitlement/access-policy.js";
import { createDesktopPopupBinding } from "../../../ui/v3/desktop-popup-binding.js";

export const ACCOUNT = "11111111-1111-1111-1111-111111111111";
export const OTHER = "22222222-2222-2222-2222-222222222222";
const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LINEAGE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const settle = async () => { for (let i = 0; i < 250; i++) await Promise.resolve(); };

// Only the network/auth boundaries are synthetic. Both independent clients use the real QA route
// adapter, service, durable writer, cache and popup projection. No realtime callback is fabricated.
export function canonicalServer() {
  const initial = migrateSettingsV2({ ...DEFAULT_SETTINGS, updatedAt: 1 }, { kind: "acknowledged-account", revision: 1 });
  if (initial.status !== "ready") throw new Error("fixture");
  let settings = initial.settings;
  let revision = 1;
  let lastWrite: string | null = null;
  const claims = new Map<string, string>();
  const snapshot = () => ({ status: "ready", protocol: 2, empty: false,
    settings: structuredClone(settings), settingsVersion: revision,
    settingsServerUpdatedAt: "2026-10-14T00:00:00Z", writeId: lastWrite, lineage: LINEAGE,
    receipt: { version: 1, lineage: LINEAGE, revision, mac: "A".repeat(43) } });
  function exchange(body: unknown) {
    if ((body as { action?: string }).action === "read") return snapshot();
    const parsed = readSettingsOperationRequest(body);
    if (parsed.status !== "parsed") throw new Error("request-shape");
    const request = parsed.request;
    const prior = claims.get(request.writeId);
    if (prior && prior !== JSON.stringify(request)) throw new Error("write-id-conflict");
    if (!prior) {
      claims.set(request.writeId, JSON.stringify(request));
      let changed = false;
      for (const op of request.operations) {
        const current = { value: field(settings, op.path), stamp: settings.clocks[op.path] };
        const merged = mergeSettingsField(current, { value: op.value, stamp: { baseRevision: op.baseRevision, localStep: op.localStep } });
        changed ||= JSON.stringify(current) !== JSON.stringify(merged);
        if (op.path === "globalOn") settings = { ...settings, globalOn: merged.value };
        else {
          const group = op.path.startsWith("services.") ? "services" : "sites";
          settings = { ...settings, [group]: { ...settings[group], [op.path.slice(group.length + 1)]: merged.value } };
        }
        settings = { ...settings, clocks: { ...settings.clocks, [op.path]: merged.stamp } };
      }
      if (changed) { revision++; lastWrite = request.writeId; }
    }
    return snapshot();
  }
  return { exchange, snapshot, claims };
}
function field(settings: SettingsV2, path: SettingsField): boolean {
  if (path === "globalOn") return settings.globalOn;
  return (path.startsWith("services.") ? settings.services[path.slice(9)] : settings.sites[path.slice(6)]) as boolean;
}
export async function client(server: ReturnType<typeof canonicalServer>, routeProfile: BackendRouteProfile = "shared-hosted-sandbox",
  storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 })) {
  const writer = new AtomicSettingsWriter(storage);
  const cache = new SettingsCache({ get: () => storage.get(), set: r => writer.replace(r).then(() => undefined),
    subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer), initializeAtomic: writer.initialize.bind(writer),
    enterScope: writer.enterScope.bind(writer), acknowledgeAtomic: writer.acknowledge.bind(writer) }, { atomicOwnership: "unknown" });
  const unwatch = cache.watch(); await cache.hydrate();
  let online = true, account = ACCOUNT, activeServer = server;
  let held: { started(): void; wait: Promise<void> } | null = null;
  const reads: number[] = [], writes: unknown[] = [];
  const invoke = vi.fn(async (name: string, options: { body: unknown }) => {
    if (name.endsWith("reconcile-entitlement")) return { data: {}, error: null };
    expect(name).toBe(routeProfile === "shared-hosted-sandbox" ? "qa-sandbox-sync-settings" : "sync-settings");
    const read = (options.body as { action?: string }).action === "read";
    if (read) reads.push(Date.now()); else writes.push(structuredClone(options.body));
    if (!online) return { data: null, error: new Error("offline") };
    const data = activeServer.exchange(options.body);
    if (read && held) { const pending = held; held = null; pending.started(); await pending.wait; }
    return { data, error: null };
  });
  const channel = vi.fn(() => ({ on() { return this; }, subscribe() { return this; }, unsubscribe() {} }));
  const backend = new SupabaseBackendPort({ functions: { invoke }, channel,
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: { still_sync: false }, error: null }) }) }),
  } as unknown as SupabaseClient, { modernSettings: true, routeProfile });
  const auth = { currentUserId: async () => account,
    currentSettingsSession: async () => ({ userId: account, sessionId: SESSION }),
    signOut: async () => {}, signInWithMagicLink: async () => ({}) };
  let receiveState: ((state: SyncState) => void) | undefined;
  const service = new SyncService(cache, auth, backend, state => receiveState?.(state));
  const events: { at: number; version: number | undefined }[] = [];
  const unsubscribe = cache.subscribe(() => events.push({ at: Date.now(), version: cache.currentRecord().atomic?.anchor?.revision }));
  const access = new EntitlementCache({ get: async () => false, set: async () => {}, subscribe: () => () => {},
    observeBenefits: async () => initialAccessSnapshot() });
  await access.refreshAccess();
  const binding = await createDesktopPopupBinding(cache, access);
  await service.onSignedIn(ACCOUNT);
  return { service, cache, storage, writer, binding, channel, reads, writes, events,
    observeState(receive: (state: SyncState) => void) { receiveState = receive; receive(service.getState()); },
    setOnline(value: boolean) { online = value; },
    setAccount(value: string, nextServer = server) { account = value; activeServer = nextServer; },
    holdRead() {
      let started!: () => void, release!: () => void;
      const began = new Promise<void>(r => { started = r; });
      const wait = new Promise<void>(r => { release = r; });
      held = { started, wait }; return { began, release };
    },
    async close() { await service.signOut(); unwatch(); unsubscribe(); binding.stop(); },
    terminate() {
      // Simulate process termination, preserving the actual durable session record.
      const host = service as unknown as { stopWriteThrough(): void; stopRealtime(): void };
      host.stopWriteThrough(); host.stopRealtime(); unwatch(); unsubscribe(); binding.stop();
    },
  };
}

