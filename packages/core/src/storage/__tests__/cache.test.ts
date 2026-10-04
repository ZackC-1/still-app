import { describe, it, expect, vi } from "vitest";
import type { SettingsField, StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../cache.js";
import { AtomicSettingsWriter, SettingsStorageRecovery, requireModernSettings } from "../atomic-settings.js";
import { InMemoryStorageAdapter } from "../adapter.js";
import type { StoredSettingsRecord } from "../adapter.js";
import { ChromeStorageAdapter } from "../chrome-adapter.js";
import { EntitlementCache } from "../../entitlement/cache.js";
import { createDesktopPopupBinding } from "../../ui/v3/desktop-popup-binding.js";

/** A cache backed by an in-memory adapter with a deterministic monotonic clock. */
function makeCache(initial?: StillSettings) {
  const adapter = new InMemoryStorageAdapter(initial ?? null);
  let t = 1000;
  const cache = new SettingsCache(adapter, { now: () => ++t });
  return { adapter, cache };
}

function settings(over: Partial<StillSettings> = {}): StillSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}

describe("newer legacy hydration after delayed command receipts", () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }

  function record(globalOn: boolean, updatedAt: number, syncEpoch: number, version: number): StoredSettingsRecord {
    return { settings: settings({ globalOn, updatedAt }), syncEpoch,
      syncMetadata: { version, serverUpdatedAt: "2026-07-09T18:00:00.000Z", lastWriteId: null } };
  }

  const schedules = [false, true].flatMap(watch => [false, true].flatMap(changed =>
    ["epoch", "version"].map(authority => ({ watch, changed, authority }))));

  it.each(schedules)("recovers newer $authority authority (watch=$watch, changed=$changed)", async scenario => {
    const saved = record(scenario.changed, 9000, 1, 5);
    const storage = new InMemoryStorageAdapter(saved);
    const writer = new AtomicSettingsWriter(storage);
    const commandWritten = gate(); const commandReply = gate();
    const readCaptured = gate(); const readReply = gate();
    let receipt!: StoredSettingsRecord;
    let captured: StoredSettingsRecord | null = null;
    const cache = new SettingsCache({
      get: async () => { captured = await storage.get(); readCaptured.release(); await readReply.promise; return captured; },
      set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage),
      commitIntent: async intent => {
        receipt = await writer.commit(intent);
        commandWritten.release(); await commandReply.promise; return receipt;
      },
    }, { initial: saved.settings, now: () => 5000 });
    const legacy = vi.fn(); cache.subscribe(legacy);
    const authority: StoredSettingsRecord[] = [];
    cache.subscribeAuthority(() => authority.push(structuredClone(cache.currentRecord())));
    const writes = vi.spyOn(storage, "set");
    const stop = scenario.watch ? cache.watch() : () => {};
    const old = { ...saved, settings: settings({ globalOn: false, updatedAt: scenario.changed ? 9001 : 9000 }) };
    const newer = record(true, 1, scenario.authority === "epoch" ? 2 : 1, scenario.authority === "epoch" ? 1 : 6);
    try {
      const command = cache.setGlobalOn(false);
      await commandWritten.promise;
      expect(receipt).toEqual({ ...old, intentCommitted: scenario.changed });
      expect(await storage.get()).toEqual(old);
      // The actual writer has finished; only its transport reply remains delayed.
      await expect(writer.replace(newer)).resolves.toEqual(newer);
      const hydration = cache.hydrate(); const settled = cache.whenHydrated();
      await readCaptured.promise;
      expect(captured).toEqual(newer);
      commandReply.release();
      await expect(command).resolves.toEqual(old.settings);
      expect(cache.currentRecord()).toEqual(old);
      expect(await storage.get()).toEqual(newer);
      expect(legacy.mock.calls).toEqual(scenario.changed ? [[old.settings, "local"]] : []);
      readReply.release();
      await expect(hydration).resolves.toEqual(newer.settings);
      await expect(settled).resolves.toBeUndefined();
      await expect(cache.whenHydrated()).resolves.toBeUndefined();
      expect(cache.currentRecord()).toEqual(newer);
      expect(cache.currentSyncMetadata()).toEqual(newer.syncMetadata);
      expect(await storage.get()).toEqual(newer);
      expect(legacy.mock.calls).toEqual([
        ...(scenario.changed ? [[old.settings, "local"]] : []), [newer.settings, "external"],
      ]);
      expect(authority).toEqual(scenario.watch
        ? [...(scenario.changed ? [old] : []), newer, old, newer] : [old, newer]);
      expect(writes.mock.calls).toEqual([...(scenario.changed ? [[old]] : []), [newer]]);
    } finally { commandReply.release(); readReply.release(); stop(); }
  });

  it.each([undefined, 5])("keeps a real no-op receipt over an older same-authority read (version=%s)", async version => {
    const saved: StoredSettingsRecord = { settings: settings({ globalOn: true, updatedAt: 9000 }), syncEpoch: 1,
      syncMetadata: version === undefined ? null : record(true, 9000, 1, version).syncMetadata };
    const storage = new InMemoryStorageAdapter(saved);
    const writer = new AtomicSettingsWriter(storage);
    const readCaptured = gate(); const readReply = gate();
    const cache = new SettingsCache({
      get: async () => { const captured = await storage.get(); readCaptured.release(); await readReply.promise; return captured; },
      set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer),
    }, { now: () => 5000 });
    const legacy = vi.fn(); cache.subscribe(legacy);
    const authority: StoredSettingsRecord[] = [];
    cache.subscribeAuthority(() => authority.push(structuredClone(cache.currentRecord())));
    const writes = vi.spyOn(storage, "set");
    const hydration = cache.hydrate(); const settled = cache.whenHydrated();
    await readCaptured.promise;
    const stop = cache.watch();
    const committed = { ...saved, settings: settings({ globalOn: false, updatedAt: 9001 }) };
    try {
      // A backward injected clock still advances the durable authority stamp while the older get is held.
      await expect(writer.commit({ path: "globalOn", value: false, updatedAt: 5000 }))
        .resolves.toEqual({ ...committed, intentCommitted: true });
      const receipt = await writer.commit({ path: "globalOn", value: false, updatedAt: 5000 });
      expect(receipt).toEqual({ ...committed, intentCommitted: false });
      await expect(cache.setGlobalOn(false)).resolves.toEqual(committed.settings);
      expect(cache.currentRecord()).toEqual(committed);
      const before = [...authority]; const legacyBefore = [...legacy.mock.calls];
      readReply.release();
      await expect(hydration).resolves.toEqual(committed.settings);
      await expect(settled).resolves.toBeUndefined();
      await expect(cache.whenHydrated()).resolves.toBeUndefined();
      expect(cache.currentRecord()).toEqual(committed);
      expect(cache.currentSyncMetadata()).toEqual(saved.syncMetadata);
      expect(await storage.get()).toEqual(committed);
      expect(authority).toEqual(before);
      expect(legacy.mock.calls).toEqual(legacyBefore);
      expect(writes).toHaveBeenCalledExactlyOnceWith(committed);
    } finally { readReply.release(); stop(); }
  });
});

describe("legacy hydration arbitration", () => {
  function record(globalOn: boolean, updatedAt: number, version?: number, syncEpoch = 0): StoredSettingsRecord {
    return { settings: settings({ globalOn, updatedAt }), syncEpoch,
      syncMetadata: version === undefined ? null : {
        version, serverUpdatedAt: "2026-07-09T18:00:00.000Z", lastWriteId: null,
      } };
  }

  const saved = record(false, 300);
  const intermediate = record(true, 200);
  const newer = record(true, 400);
  const versioned = record(false, 1, 5);
  const skewed = record(true, 9000, 4);
  const reset = record(false, 1, 1, 2);
  const priorAccount = record(true, 9000, 99, 1);
  const currentAccount = record(true, 1, 3, 2);

  it.each([
    { name: "ignored equal-timestamp notification", saved, notification: record(true, 0), chosen: saved, events: [saved] },
    { name: "accepted intermediate older notification", saved, notification: intermediate, chosen: saved, events: [intermediate, saved] },
    { name: "server version ahead of a skewed timestamp", saved: versioned, notification: skewed, chosen: versioned, events: [skewed, versioned] },
    { name: "new epoch reset ahead of old account version", saved: reset, notification: priorAccount, chosen: reset, events: [priorAccount, reset] },
    { name: "stale saved epoch denied after account reset", saved: priorAccount, notification: currentAccount, chosen: currentAccount, events: [currentAccount] },
    { name: "genuinely newer notification", saved, notification: newer, chosen: newer, events: [newer] },
    { name: "no notification", saved, notification: null, chosen: saved, events: [saved] },
  ])("preserves $name while the saved get is pending", async scenario => {
    const storage = new InMemoryStorageAdapter(scenario.saved);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { started = resolve; });
    const writes = vi.spyOn(storage, "set");
    const cache = new SettingsCache({
      get: async () => { const captured = await storage.get(); started(); await gate; return captured; },
      set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage),
    });
    const legacy = vi.fn(); cache.subscribe(legacy);
    const hydration = cache.hydrate();
    const settled = cache.whenHydrated();
    await reached;
    const stop = cache.watch();
    try {
      if (scenario.notification) storage.emitExternal(scenario.notification);
      release();
      await expect(hydration).resolves.toEqual(scenario.chosen.settings);
      await expect(settled).resolves.toBeUndefined();
      await expect(cache.whenHydrated()).resolves.toBeUndefined();
      expect(cache.currentRecord()).toEqual(scenario.chosen);
      expect(cache.currentSyncMetadata()).toEqual(scenario.chosen.syncMetadata);
      expect(legacy.mock.calls).toEqual(scenario.events.map(event => [event.settings, "external"]));
      expect(writes).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(scenario.notification ?? scenario.saved);
    } finally { release(); stop(); }
  });

  it("arbitrates an ignored Chrome onChanged signal against the held saved get", async () => {
    let release!: (values: Record<string, unknown>) => void;
    let changed!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
    const get = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { release = resolve; }));
    const set = vi.fn();
    const sendMessage = vi.fn();
    const sendNativeMessage = vi.fn();
    const addListener = vi.fn(listener => { changed = listener; });
    const removeListener = vi.fn();
    vi.stubGlobal("chrome", {
      storage: { local: { get, set }, onChanged: { addListener, removeListener } },
      runtime: { getURL: () => "chrome-extension://test/", sendMessage, sendNativeMessage },
    });
    const adapter = new ChromeStorageAdapter();
    const commit = vi.spyOn(adapter, "commitIntent");
    const initialize = vi.spyOn(adapter, "initializeAtomic");
    const cache = new SettingsCache(adapter);
    const legacy = vi.fn(); cache.subscribe(legacy);
    const hydration = cache.hydrate();
    const settled = cache.whenHydrated();
    const stop = cache.watch();
    try {
      expect(get).toHaveBeenCalledExactlyOnceWith("still:settings");
      changed({ "still:settings": { newValue: record(true, 0) } }, "local");
      expect(cache.current()).toEqual(DEFAULT_SETTINGS);
      expect(legacy).not.toHaveBeenCalled();
      release({ "still:settings": saved });
      await expect(hydration).resolves.toEqual(saved.settings);
      await expect(settled).resolves.toBeUndefined();
      await expect(cache.whenHydrated()).resolves.toBeUndefined();
      expect(cache.currentRecord()).toEqual(saved);
      expect(cache.currentSyncMetadata()).toBeNull();
      expect(legacy.mock.calls).toEqual([[saved.settings, "external"]]);
      expect(set).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled(); expect(sendNativeMessage).not.toHaveBeenCalled();
    } finally {
      release({ "still:settings": saved }); stop();
      expect(removeListener).toHaveBeenCalledExactlyOnceWith(changed);
      vi.unstubAllGlobals();
    }
  });
});

describe("hydration after accepted legacy commands", () => {
  it.each([undefined, 5])("preserves a real writer receipt over a captured saved read (version=%s)", async version => {
    const metadata = version === undefined ? null : {
      version, serverUpdatedAt: "2026-07-09T18:00:00.000Z", lastWriteId: null,
    };
    const saved: StoredSettingsRecord = {
      settings: settings({ globalOn: false, updatedAt: 9000 }), syncMetadata: metadata, syncEpoch: 0,
    };
    const storage = new InMemoryStorageAdapter(saved);
    const writer = new AtomicSettingsWriter(storage);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { started = resolve; });
    const cache = new SettingsCache({
      get: async () => { const captured = await storage.get(); started(); await gate; return captured; },
      set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer),
    }, { now: () => 5000 });
    const legacy = vi.fn(); cache.subscribe(legacy);
    const authority = vi.fn(); cache.subscribeAuthority(authority);
    const writes = vi.spyOn(storage, "set");
    const hydration = cache.hydrate();
    const settled = cache.whenHydrated();
    await reached;
    const stop = cache.watch();
    const committed = { ...saved, settings: settings({ globalOn: true, updatedAt: 9001 }) };
    try {
      await expect(cache.setGlobalOn(true)).resolves.toEqual(committed.settings);
      expect(cache.currentRecord()).toEqual(committed);
      expect(await storage.get()).toEqual(committed);
      expect(legacy.mock.calls).toEqual([[committed.settings, "local"]]);
      expect(authority).toHaveBeenCalledOnce();
      release();
      await expect(hydration).resolves.toEqual(committed.settings);
      await expect(settled).resolves.toBeUndefined();
      await expect(cache.whenHydrated()).resolves.toBeUndefined();
      expect(cache.currentRecord()).toEqual(committed);
      expect(cache.currentSyncMetadata()).toEqual(metadata);
      expect(await storage.get()).toEqual(committed);
      expect(legacy.mock.calls).toEqual([[committed.settings, "local"]]);
      expect(authority).toHaveBeenCalledOnce();
      storage.emitExternal(committed);
      expect(cache.currentRecord()).toEqual(committed);
      expect(await storage.get()).toEqual(committed);
      expect(legacy.mock.calls).toEqual([[committed.settings, "local"]]);
      expect(authority).toHaveBeenCalledOnce();
      expect(writes).toHaveBeenCalledExactlyOnceWith(committed);
    } finally { release(); stop(); }
  });

  it("keeps a captured atomic read fenced after a current legacy notification", async () => {
    const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
    const writer = new AtomicSettingsWriter(storage);
    const saved = await writer.initialize("never-linked");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { started = resolve; });
    const cache = new SettingsCache({
      get: async () => { const captured = await storage.get(); started(); await gate; return captured; },
      set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer),
    });
    const legacy = vi.fn(); cache.subscribe(legacy);
    const writes = vi.spyOn(storage, "set");
    const hydration = cache.hydrate();
    await reached;
    const stop = cache.watch();
    const current = { settings: settings({ globalOn: false, updatedAt: 100 }), syncMetadata: null, syncEpoch: 0 };
    try {
      expect(saved.atomic).toBeDefined();
      storage.emitExternal(current);
      release();
      await expect(hydration).resolves.toEqual(current.settings);
      await expect(cache.whenHydrated()).resolves.toBeUndefined();
      expect(cache.currentRecord()).toEqual(current);
      expect(legacy.mock.calls).toEqual([[current.settings, "external"]]);
      expect(await storage.get()).toEqual(current);
      expect(writes).not.toHaveBeenCalled();
    } finally { release(); stop(); }
  });
});

describe("read-only authority observation", () => {
  async function fixture() {
    const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
    const writer = new AtomicSettingsWriter(storage);
    const durable = await writer.initialize("never-linked");
    let port: typeof writer.commit = writer.commit.bind(writer);
    const cache = new SettingsCache({ get: storage.get.bind(storage), set: storage.set.bind(storage),
      subscribe: storage.subscribe.bind(storage), commitIntent: intent => port(intent) }, { now: () => 100 });
    await cache.hydrate();
    const stop = cache.watch();
    return { storage, writer, durable, cache, stop, port: (next: typeof port) => { port = next; } };
  }

  it("publishes metadata-only authority holds and recovery without legacy edit events or writes", async () => {
    const f = await fixture();
    const seen: (string | null | undefined)[] = [];
    const off = f.cache.subscribeAuthority(() => seen.push(f.cache.currentRecord().atomic!.paused));
    const legacy = vi.fn(); f.cache.subscribe(legacy);
    const writes = vi.spyOn(f.storage, "set");
    f.storage.emitExternal({ ...f.durable, atomic: { ...f.durable.atomic!, paused: "ownership-hold" } });
    f.storage.emitExternal(f.durable);
    f.storage.emitExternal(f.durable); // Repeated identical receipt is no new observable state.
    expect(seen).toEqual(["ownership-hold", null]);
    expect(legacy).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    expect(await f.storage.get()).toEqual(f.durable);
    off(); f.stop();
  });

  it("publishes a coherent held projection after accepted metadata is installed", async () => {
    const f = await fixture();
    const seen: unknown[] = [];
    f.cache.subscribeAuthority(() => seen.push(structuredClone(f.cache.currentRecord())));
    const legacy = vi.fn(); f.cache.subscribe(legacy);
    const supplied = { ...f.durable, atomic: { ...f.durable.atomic!, paused: "ownership-hold", held: { globalOn: false } } };
    const writes = vi.spyOn(f.storage, "set");
    f.storage.emitExternal(supplied);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ settings: { globalOn: false }, atomic: { paused: "ownership-hold", held: { globalOn: false } } });
    expect(legacy).toHaveBeenCalledOnce(); expect(legacy.mock.calls[0]![1]).toBe("external");
    expect(await f.storage.get()).toEqual(supplied); expect(writes).not.toHaveBeenCalled(); f.stop();
  });

  it("publishes current recovery and its unchanged healthy reread to authority listeners only", async () => {
    const f = await fixture(); const seen: (string | null)[] = [];
    f.cache.subscribeAuthority(() => seen.push(f.cache.currentRecord().atomic!.paused));
    const legacy = vi.fn(); f.cache.subscribe(legacy);
    f.port(async () => { throw new SettingsStorageRecovery("native-authority-unavailable"); });
    await expect(f.cache.commitAtomicIntent("globalOn", false)).rejects.toThrow("native-authority-unavailable");
    f.storage.emitExternal(f.durable);
    expect(seen).toEqual(["native-authority-unavailable", null]);
    expect(legacy).not.toHaveBeenCalled(); expect(await f.storage.get()).toEqual(f.durable); f.stop();
  });

  it("does not publish stale authority or an obsolete failed request over a newer accepted edit", async () => {
    const f = await fixture(); const seen: unknown[] = [];
    f.cache.subscribeAuthority(() => seen.push(structuredClone(f.cache.currentRecord())));
    let reject!: (error: Error) => void;
    f.port(() => new Promise((_resolve, r) => { reject = r; }));
    const pending = f.cache.commitAtomicIntent("sites.youtube.shorts", false);
    const failed = expect(pending).rejects.toThrow("native-authority-unavailable");
    await f.writer.commit({ path: "services.instagram", value: false, updatedAt: 101 });
    const healthy = f.cache.currentRecord();
    expect(seen).toHaveLength(1);
    reject(new SettingsStorageRecovery("native-authority-unavailable")); await failed;
    f.storage.emitExternal(f.durable);
    expect(seen).toHaveLength(1); expect(f.cache.currentRecord()).toEqual(healthy); f.stop();
  });

  it.each(["success", "failure"] as const)("fences late hydration %s after a newer authority receipt", async kind => {
    const f = await fixture();
    let resolve!: (record: typeof f.durable) => void, reject!: (error: Error) => void;
    const cache = new SettingsCache({ get: () => new Promise((r, j) => { resolve = r; reject = j; }),
      set: f.storage.set.bind(f.storage), subscribe: f.storage.subscribe.bind(f.storage), commitIntent: f.writer.commit.bind(f.writer) });
    const seen: unknown[] = []; cache.subscribeAuthority(() => seen.push(structuredClone(cache.currentRecord())));
    const hydration = cache.hydrate();
    const result = kind === "failure" ? expect(hydration).rejects.toThrow("native-authority-unavailable") : expect(hydration).resolves.toHaveProperty("globalOn", false);
    await cache.setGlobalOn(false); const healthy = cache.currentRecord();
    if (kind === "failure") reject(new SettingsStorageRecovery("native-authority-unavailable", f.durable)); else resolve(f.durable);
    await result; expect(seen).toHaveLength(1); expect(cache.currentRecord()).toEqual(healthy);
    await expect(cache.whenHydrated()).resolves.toBeUndefined(); f.stop();
  });

  it("does not publish a retired generation even with a higher incoming sequence", async () => {
    const f = await fixture(); const seen: unknown[] = [];
    f.cache.subscribeAuthority(() => seen.push(structuredClone(f.cache.currentRecord())));
    await f.writer.enterScope("00000000-0000-4000-8000-000000000091", "00000000-0000-4000-8000-000000000092");
    const current = f.cache.currentRecord();
    expect(current.atomic!.scope.generation).toBe(1); expect(seen).toHaveLength(1);
    f.storage.emitExternal({ ...f.durable, atomic: { ...f.durable.atomic!, sequence: current.atomic!.sequence + 1 } });
    expect(seen).toHaveLength(1); expect(f.cache.currentRecord()).toEqual(current); f.stop();
  });

  it("never announces briefly ready during retained-load recovery", async () => {
    const f = await fixture();
    const cache = new SettingsCache({ get: async () => { throw new SettingsStorageRecovery("native-authority-unavailable", f.durable); },
      set: f.storage.set.bind(f.storage), subscribe: f.storage.subscribe.bind(f.storage), commitIntent: f.writer.commit.bind(f.writer) });
    const seen: (string | null | undefined)[] = []; cache.subscribeAuthority(() => seen.push(cache.currentRecord().atomic?.paused));
    const legacy = vi.fn(); cache.subscribe(legacy);
    await cache.hydrate();
    expect(seen).toEqual(["native-authority-unavailable"]); expect(legacy).toHaveBeenCalledOnce();
    await expect(cache.whenHydrated()).rejects.toThrow("native-authority-unavailable");
    expect(await f.storage.get()).toEqual(f.durable); f.stop();
  });

  it("keeps unsubscribed observers silent even when another observer disposes them reentrantly", async () => {
    const f = await fixture(); const later = vi.fn();
    let offLater = () => {};
    const offFirst = f.cache.subscribeAuthority(() => offLater());
    offLater = f.cache.subscribeAuthority(later);
    f.storage.emitExternal({ ...f.durable, atomic: { ...f.durable.atomic!, paused: "ownership-hold" } });
    expect(later).not.toHaveBeenCalled(); offFirst();
    f.storage.emitExternal(f.durable); expect(later).not.toHaveBeenCalled(); f.stop();
  });

  it("keeps read-only observer errors outside the writer outcome and other observer delivery", async () => {
    const f = await fixture(); const seen: boolean[] = [];
    f.cache.subscribeAuthority(() => { throw new Error("observer failed"); });
    f.cache.subscribeAuthority(() => seen.push(f.cache.current().globalOn));
    const legacy = vi.fn(); f.cache.subscribe(legacy);
    const result = await f.cache.commitAtomicIntent("globalOn", false);
    expect(result.intentCommitted).toBe(true); expect(seen).toEqual([false]);
    expect((await f.storage.get())!.settings.globalOn).toBe(false);
    expect(legacy).toHaveBeenCalledOnce(); expect(legacy.mock.calls[0]![1]).toBe("local"); f.stop();
  });
});

describe("SettingsCache", () => {
  it("round-trips a write through the adapter and the snapshot", async () => {
    const { adapter, cache } = makeCache();
    await cache.setService("youtube", false);
    expect(cache.current().services.youtube).toBe(false);
    expect((await adapter.get())!.settings.services.youtube).toBe(false);
  });

  it("stamps a fresh updatedAt on every write", async () => {
    const { cache } = makeCache();
    const a = await cache.setGlobalOn(false);
    const b = await cache.setGlobalOn(true);
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt);
  });

  it("notifies subscribers on change", async () => {
    const { cache } = makeCache();
    const seen = vi.fn();
    cache.subscribe(seen);
    await cache.setService("tiktok", false);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0].services.tiktok).toBe(false);
  });

  it("resolves a stale incoming write by updatedAt (LWW)", async () => {
    const { cache } = makeCache(settings({ globalOn: true, updatedAt: 5000 }));
    await cache.hydrate();
    // older incoming → ignored
    expect(cache.applyRemote(settings({ globalOn: false, updatedAt: 4000 }))).toBe(false);
    expect(cache.current().globalOn).toBe(true);
    // newer incoming → applied
    expect(cache.applyRemote(settings({ globalOn: false, updatedAt: 6000 }))).toBe(true);
    expect(cache.current().globalOn).toBe(false);
  });

  it("hydrates the snapshot from the adapter", async () => {
    const stored = settings({ globalOn: false, updatedAt: 9000 });
    const { cache } = makeCache(stored);
    await cache.hydrate();
    expect(cache.current().globalOn).toBe(false);
  });

  it("a free-user write touches only the adapter — never the network (AE6)", async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { adapter, cache } = makeCache();
      const setSpy = vi.spyOn(adapter, "set");
      await cache.setService("facebook", false);
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("applies external writes once watching, deduping echoes", async () => {
    const { adapter, cache } = makeCache(settings({ updatedAt: 100 }));
    await cache.hydrate();
    cache.watch();
    const seen = vi.fn();
    cache.subscribe(seen);
    // external newer write → applied + notified
    adapter.emitExternal(settings({ globalOn: false, updatedAt: 200 }));
    expect(cache.current().globalOn).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    // external older write → ignored
    adapter.emitExternal(settings({ globalOn: true, updatedAt: 150 }));
    expect(cache.current().globalOn).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("applies a higher server version and persists metadata", () => {
    const { cache } = makeCache(settings({ globalOn: true, updatedAt: 10 }));
    const applied = cache.applySyncedEnvelope({
      settings: settings({ globalOn: false, updatedAt: 1 }),
      version: 2,
      serverUpdatedAt: "2026-07-09T18:00:00.000Z",
      lastWriteId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    });
    expect(applied).toBe(true);
    expect(cache.current().globalOn).toBe(false);
    expect(cache.currentSyncMetadata()?.version).toBe(2);
  });

  it("ignores a lower server version", () => {
    const { cache } = makeCache(settings({ globalOn: true, updatedAt: 10 }));
    cache.applySyncedEnvelope({
      settings: settings({ globalOn: false, updatedAt: 1 }),
      version: 3,
      serverUpdatedAt: "2026-07-09T18:00:00.000Z",
      lastWriteId: null,
    });
    expect(cache.applySyncedEnvelope({
      settings: settings({ globalOn: true, updatedAt: 99 }),
      version: 2,
      serverUpdatedAt: "2026-07-09T18:00:01.000Z",
      lastWriteId: null,
    })).toBe(false);
    expect(cache.current().globalOn).toBe(false);
  });

  it("does not double-notify for an equal server version", () => {
    const { cache } = makeCache(settings({ globalOn: true, updatedAt: 10 }));
    const seen = vi.fn();
    cache.subscribe(seen);
    const envelope = {
      settings: settings({ globalOn: false, updatedAt: 1 }),
      version: 3,
      serverUpdatedAt: "2026-07-09T18:00:00.000Z",
      lastWriteId: null,
    };
    cache.applySyncedEnvelope(envelope);
    cache.applySyncedEnvelope(envelope);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  // ── two contexts over one store: the reconcile has to reach both ────────────────────────────────
  // The background worker and every extension page build their own SettingsCache over the same
  // storage area. `adoptSyncedEnvelope` is the one call that may lower the version, so it is the one
  // call the other contexts would otherwise read as a stale write and refuse.

  it("a reconcile that repoints the browser is accepted by the other contexts reading the store", () => {
    const adapter = new InMemoryStorageAdapter(null);
    const background = new SettingsCache(adapter, { now: () => 1 });
    const page = new SettingsCache(adapter, { now: () => 1 });
    page.watch();

    const previous = {
      settings: settings({ globalOn: false, updatedAt: 10 }),
      version: 99,
      serverUpdatedAt: "2026-07-09T18:00:00.000Z",
      lastWriteId: null,
    };
    background.applySyncedEnvelope(previous);
    expect(page.currentSyncMetadata()?.version).toBe(99);

    background.adoptSyncedEnvelope({
      settings: settings({ globalOn: true, updatedAt: 11 }),
      version: 3,
      serverUpdatedAt: "2026-07-09T18:01:00.000Z",
      lastWriteId: null,
    });

    expect(page.current().globalOn).toBe(true);
    expect(page.currentSyncMetadata()?.version).toBe(3);
    expect(page.currentRecord().syncEpoch).toBe(1);
  });

  it("a context that has not seen the reconcile cannot push the previous account's settings back", () => {
    const { adapter, cache } = makeCache();
    cache.watch();
    cache.adoptSyncedEnvelope({
      settings: settings({ globalOn: true, updatedAt: 11 }),
      version: 3,
      serverUpdatedAt: "2026-07-09T18:01:00.000Z",
      lastWriteId: null,
    });
    // A popup that committed an edit before the reconcile's write reached it: the previous person's
    // settings, on the previous person's version, stamped with the epoch it had at the time.
    adapter.emitExternal({
      settings: settings({ globalOn: false, updatedAt: 12 }),
      syncMetadata: { version: 99, serverUpdatedAt: "2026-07-09T18:00:00.000Z", lastWriteId: null },
      syncEpoch: 0,
    });
    expect(cache.current().globalOn).toBe(true);
    expect(cache.currentSyncMetadata()?.version).toBe(3);
  });

  it("a record with no epoch is judged the way it always was, so bridged settings still arrive", () => {
    // A record whose writer never carried the counter arrives with no epoch at all. Reading that as
    // this cache's own state would let a browser that has reconciled once refuse an edit whose
    // writer could not have stamped one.
    const { adapter, cache } = makeCache();
    cache.watch();
    cache.adoptSyncedEnvelope({
      settings: settings({ globalOn: true, updatedAt: 11 }),
      version: 3,
      serverUpdatedAt: "2026-07-09T18:01:00.000Z",
      lastWriteId: null,
    });
    adapter.emitExternal({
      settings: settings({ globalOn: false, updatedAt: 12 }),
      syncMetadata: { version: 3, serverUpdatedAt: "2026-07-09T18:01:00.000Z", lastWriteId: null },
    });
    expect(cache.current().globalOn).toBe(false);
  });

  it("a reconcile that changed nothing does not repoint anything", () => {
    const { cache } = makeCache();
    const envelope = {
      settings: settings({ globalOn: false, updatedAt: 10 }),
      version: 4,
      serverUpdatedAt: "2026-07-09T18:00:00.000Z",
      lastWriteId: null,
    };
    expect(cache.adoptSyncedEnvelope(envelope)).toBe(true);
    expect(cache.currentRecord().syncEpoch).toBe(1);
    // A background start that finds the account exactly where it left it must not cost every other
    // context a needless reset.
    expect(cache.adoptSyncedEnvelope(envelope)).toBe(false);
    expect(cache.currentRecord().syncEpoch).toBe(1);
  });

  it("device updatedAt skew does not beat a newer server version", () => {
    const { cache } = makeCache(settings({ globalOn: true, updatedAt: 10 }));
    cache.applySyncedEnvelope({
      settings: settings({ globalOn: false, updatedAt: 100 }),
      version: 5,
      serverUpdatedAt: "2026-07-09T18:00:00.000Z",
      lastWriteId: null,
    });
    cache.applySyncedEnvelope({
      settings: settings({ globalOn: true, updatedAt: 9_999_999_999_999 }),
      version: 4,
      serverUpdatedAt: "2026-07-09T18:00:01.000Z",
      lastWriteId: null,
    });
    expect(cache.current().globalOn).toBe(false);
  });
});


describe("cache authority recovery supersession", () => {
  it.each(["get", "initializeAtomic"] as const)("late successful %s hydration preserves a newer same-sequence ownership hold", async read => {
    const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
    const writer = new AtomicSettingsWriter(storage);
    const durable = await writer.initialize("never-linked");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { started = resolve; });
    async function heldRead(record: typeof durable) {
      started();
      await gate;
      return record;
    }
    const commitIntent = vi.fn(writer.commit.bind(writer));
    const cache = new SettingsCache({
      get: async () => heldRead((await storage.get())!),
      initializeAtomic: async ownership => heldRead(await writer.initialize(ownership)),
      set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage), commitIntent,
    }, read === "initializeAtomic" ? { atomicOwnership: "never-linked" } : {});
    const hydration = cache.hydrate();
    await reached;
    const stop = cache.watch();
    const writes = vi.spyOn(storage, "set");
    storage.emitExternal({ ...durable, atomic: { ...durable.atomic!, paused: "ownership-hold" } });
    const held = structuredClone(cache.currentRecord());
    const legacy = vi.fn(); cache.subscribe(legacy);
    const access = new EntitlementCache({ get: async () => false, set: async () => {}, subscribe: () => () => {} });
    const binding = createDesktopPopupBinding(cache, access);
    const seen: (string | null)[] = [];
    binding.subscribe(state => seen.push(state.reason));
    try {
      expect(binding.current().commandAvailability).toBe("unavailable");
      expect(held.atomic!.sequence).toBe(durable.atomic!.sequence);
      expect(held.settings).toEqual(durable.settings);
      release();
      await expect(hydration).resolves.toEqual(held.settings);
      await expect(cache.whenHydrated()).resolves.toBeUndefined();
      expect(seen).toEqual(["ownership-hold"]);
      expect(cache.currentRecord()).toEqual(held);
      expect(binding.current()).toMatchObject({ commandAvailability: "unavailable", reason: "ownership-hold" });
      expect(await binding.setGlobalOn(false)).toEqual({ status: "unavailable", reason: "ownership-hold" });
      expect(commitIntent).not.toHaveBeenCalled();
      expect(await storage.get()).toMatchObject({ settings: durable.settings, atomic: held.atomic });

      // A subsequent independent healthy authority reread may genuinely clear the hold.
      storage.emitExternal(durable);
      expect(binding.current()).toMatchObject({ commandAvailability: "ready", reason: null });
      expect(seen).toEqual(["ownership-hold", null]);
      expect(cache.currentRecord().atomic).toEqual(durable.atomic);
      expect(await storage.get()).toEqual(durable);
      expect(writes).not.toHaveBeenCalled();
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      release(); binding.stop(); stop();
    }
  });

  it.each([false, true])("late failed hydration cannot poison a later successful authority commit (retained=%s)", async retained => {
    const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
    const writer = new AtomicSettingsWriter(storage); const prior = await writer.initialize("unknown");
    let reject!: (error: Error) => void;
    const cache = new SettingsCache({ get: () => new Promise((_r, r) => { reject = r; }), set: storage.set.bind(storage),
      subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer) }, { now: () => 10 });
    const hydration = cache.hydrate(); const rejected = expect(hydration).rejects.toThrow("native-authority-unavailable");
    await cache.setGlobalOn(false); const healthy = cache.currentRecord();
    reject(new SettingsStorageRecovery("native-authority-unavailable", retained ? prior : null)); await rejected;
    expect(cache.currentRecord()).toEqual(healthy); expect(cache.current().globalOn).toBe(false);
    await expect(cache.whenHydrated()).resolves.toBeUndefined();
  });
  it("legacy native authority notification still clears recovery without a settings change", async () => {
    const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
    const durable = (await storage.get())!;
    const cache = new SettingsCache({ get: storage.get.bind(storage), set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage),
      commitIntent: async () => { throw new SettingsStorageRecovery("native-authority-unavailable"); } });
    await cache.hydrate(); const stop = cache.watch();
    await expect(cache.setGlobalOn(false)).rejects.toThrow("native-authority-unavailable");
    await expect(cache.whenHydrated()).rejects.toThrow("native-authority-unavailable");
    await storage.set(durable); await expect(cache.whenHydrated()).resolves.toBeUndefined(); stop();
  });
  it("an accepted same-sequence authority notification clears a current volatile recovery hold", async () => {
    const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
    const writer = new AtomicSettingsWriter(storage); const durable = await writer.initialize("unknown");
    const cache = new SettingsCache({ get: storage.get.bind(storage), set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage),
      commitIntent: async () => { throw new SettingsStorageRecovery("native-authority-unavailable"); } });
    await cache.hydrate(); const stop = cache.watch();
    await expect(cache.setGlobalOn(false)).rejects.toThrow("native-authority-unavailable");
    await expect(cache.whenHydrated()).rejects.toThrow("native-authority-unavailable");
    await storage.set(durable);
    expect(cache.currentRecord().atomic).toEqual(durable.atomic); await expect(cache.whenHydrated()).resolves.toBeUndefined(); stop();
  });
});

describe("explicit atomic command receipts", () => {
  async function atomicCache() {
    const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
    let id = 0;
    const writer = new AtomicSettingsWriter(storage, () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
    await writer.initialize("never-linked");
    const cache = new SettingsCache({
      get: storage.get.bind(storage), set: storage.set.bind(storage),
      subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer),
    }, { now: () => 100 });
    await cache.hydrate();
    return { storage, writer, cache };
  }

  it("refuses an atomic-looking record without invoking legacy persistence", async () => {
    const { storage } = await atomicCache();
    const set = vi.fn(storage.set.bind(storage));
    const cache = new SettingsCache({ get: storage.get.bind(storage), set, subscribe: storage.subscribe.bind(storage) });
    await cache.hydrate();
    const before = cache.currentRecord();
    expect(cache.supportsAtomicIntents()).toBe(false);
    await expect(cache.commitAtomicIntent("globalOn", false)).rejects.toThrow("atomic-command-unavailable");
    expect(set).not.toHaveBeenCalled();
    expect(cache.currentRecord()).toEqual(before);
  });

  it("requires accepted modern authority before even calling an available writer", async () => {
    const commitIntent = vi.fn();
    const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
    const cache = new SettingsCache({ get: storage.get.bind(storage), set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage), commitIntent });
    await cache.hydrate();
    expect(cache.supportsAtomicIntents()).toBe(true);
    await expect(cache.commitAtomicIntent("globalOn", false)).rejects.toThrow("atomic-command-unavailable");
    expect(commitIntent).not.toHaveBeenCalled();
    expect(await storage.get()).toEqual({ settings: DEFAULT_SETTINGS, syncMetadata: null });
  });

  it.each(["paused", "unknown", "legacy", "future"] as const)("denies %s authority without changing accepted choices", async kind => {
    const { storage } = await atomicCache();
    const record = (await storage.get())!;
    const settings = kind === "legacy" ? DEFAULT_SETTINGS : kind === "future" ? { ...record.settings, schemaVersion: 3 } : record.settings;
    await storage.set({ ...record, settings, atomic: { ...record.atomic!, paused: kind === "paused" ? "ownership-hold" : null, ownership: kind === "unknown" ? "unknown" : "never-linked", anchor: kind === "unknown" ? { version: 1 as const, lineage: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", revision: 0, mac: "A".repeat(43) } : record.atomic!.anchor } });
    const commitIntent = vi.fn();
    const cache = new SettingsCache({ get: storage.get.bind(storage), set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage), commitIntent });
    await cache.hydrate();
    const before = cache.currentRecord();
    await expect(cache.commitAtomicIntent("globalOn", false)).rejects.toThrow("atomic-command-unavailable");
    expect(commitIntent).not.toHaveBeenCalled();
    expect(cache.currentRecord()).toEqual(before);
  });

  it.each([["sites.not-real", true], ["globalOn", "false"]] as const)("rejects invalid input %s/%s before the authority", async (path, value) => {
    const { storage } = await atomicCache();
    const commitIntent = vi.fn();
    const cache = new SettingsCache({ get: storage.get.bind(storage), set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage), commitIntent });
    await cache.hydrate();
    await expect(cache.commitAtomicIntent(path as SettingsField, value as boolean)).rejects.toThrow("Invalid settings intent");
    expect(commitIntent).not.toHaveBeenCalled();
  });

  it("returns real committed and no-op receipts and retains legacy setter return types", async () => {
    const { cache, storage } = await atomicCache();
    expect(cache.supportsAtomicIntents()).toBe(true);
    const first = await cache.commitAtomicIntent("sites.youtube.shorts", false);
    expect(first.intentCommitted).toBe(true);
    expect(requireModernSettings(cache.currentRecord()).sites["youtube.shorts"]).toBe(false);
    const record = await storage.get();
    const second = await cache.commitAtomicIntent("sites.youtube.shorts", false);
    expect(second.intentCommitted).toBe(false);
    expect(await storage.get()).toEqual(record);
    const legacyResult = await cache.setGlobalOn(false);
    expect(legacyResult.globalOn).toBe(false);
    expect("intentCommitted" in legacyResult).toBe(false);
  });

  it("retains a false per-request receipt when a held request observes an external matching write", async () => {
    const { storage, writer } = await atomicCache();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { started = resolve; });
    const cache = new SettingsCache({ get: storage.get.bind(storage), set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage),
      commitIntent: async () => { started(); await gate; return { ...(await storage.get())!, intentCommitted: false }; },
    });
    await cache.hydrate();
    const stop = cache.watch();
    const pending = cache.commitAtomicIntent("globalOn", false);
    await reached;
    await writer.commit({ path: "globalOn", value: false, updatedAt: 100 });
    expect(cache.current().globalOn).toBe(false);
    release();
    const result = await pending;
    expect(result.intentCommitted).toBe(false);
    expect(result.settings.globalOn).toBe(false);
    stop();
  });

  it("returns true request receipt alongside a newer accepted external state", async () => {
    const { storage, writer } = await atomicCache();
    const cache = new SettingsCache({ get: storage.get.bind(storage), set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage),
      commitIntent: async intent => {
        const receipt = await writer.commit(intent);
        await writer.commit({ path: "globalOn", value: true, updatedAt: 101 });
        return receipt;
      },
    }, { now: () => 100 });
    await cache.hydrate();
    const stop = cache.watch();
    const result = await cache.commitAtomicIntent("globalOn", false);
    expect(result.intentCommitted).toBe(true);
    expect(result.settings.globalOn).toBe(true);
    expect(cache.current().globalOn).toBe(true);
    expect(cache.currentRecord().atomic!.sequence).toBe(2);
    stop();
  });
});
