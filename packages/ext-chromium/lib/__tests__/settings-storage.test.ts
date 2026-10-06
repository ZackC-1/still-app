import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type StillSettings } from "@still/shared-types";
import {
  ChromeStorageAdapter,
  createSettingsIntentRouter,
  SettingsCache,
  type StoredSettingsRecord,
} from "@still/core/storage";

const STORAGE_KEY = "still:settings";

function settings(overrides: Partial<StillSettings> = {}): StillSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function record(
  settingsValue: StillSettings,
  version: number | null,
): StoredSettingsRecord {
  return {
    settings: settingsValue,
    syncMetadata: version === null
      ? null
      : {
          version,
          serverUpdatedAt: new Date(1_800_000_000_000 + version).toISOString(),
          lastWriteId: null,
        },
  };
}

function installChromeStorage(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  let gate: { began(): void; wait: Promise<void> } | null = null;
  let replies = 0;
  const listeners = new Set<(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void>();
  const chromeMock = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(store, key)).map(key => [key, store[key]]));
        },
        async set(values: Record<string, unknown>) {
          if (gate) { const held = gate; gate = null; held.began(); await held.wait; }
          for (const [key, newValue] of Object.entries(values)) {
            const oldValue = store[key];
            store[key] = newValue;
            const change = { oldValue, newValue };
            listeners.forEach((listener) => listener({ [key]: change }, "local"));
          }
        },
      },
      onChanged: {
        addListener(listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) {
          listeners.add(listener);
        },
        removeListener(listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) {
          listeners.delete(listener);
        },
      },
    },
  };
  const origin = "chrome-extension://synthetic/";
  Object.assign(chromeMock, { runtime: { id: "synthetic", getURL: () => origin,
    sendMessage: (message: unknown) => new Promise(resolve => router(message, { id: "synthetic", url: origin + "popup.html" }, reply => { replies += 1; resolve(reply); })),
  } });
  globalThis.chrome = chromeMock as unknown as typeof chrome;
  const authority = new ChromeStorageAdapter({ authority: true });
  const router = createSettingsIntentRouter(intent => authority.commitIntent(intent), "synthetic", origin, r => authority.set(r));
  return { store, authority, listeners, replies: () => replies, gate() {
    let began!: () => void; const started = new Promise<void>(r => { began = r; });
    let release!: () => void; let reject!: (error: Error) => void;
    gate = { began, wait: new Promise<void>((r, j) => { release = r; reject = j; }) };
    return { started, release, fail: () => reject(new Error("commit failed")) };
  } };
}

describe("Chromium/Firefox settings storage metadata propagation", () => {
  beforeEach(() => {
    installChromeStorage();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: typeof chrome }).chrome;
  });

  it("storage change with a higher version updates the cache", async () => {
    const { store } = installChromeStorage({
      [STORAGE_KEY]: record(settings({ globalOn: true, updatedAt: 1 }), 1),
    });
    const cache = new SettingsCache(new ChromeStorageAdapter());
    await cache.hydrate();
    cache.watch();

    await chrome.storage.local.set({
      [STORAGE_KEY]: record(settings({ globalOn: false, updatedAt: 2 }), 2),
    });

    expect(cache.current().globalOn).toBe(false);
    expect(cache.currentSyncMetadata()?.version).toBe(2);
    expect(store[STORAGE_KEY]).toBeTruthy();
  });

  it("storage change with a lower version is ignored", async () => {
    installChromeStorage({
      [STORAGE_KEY]: record(settings({ globalOn: true, updatedAt: 1 }), 3),
    });
    const cache = new SettingsCache(new ChromeStorageAdapter());
    await cache.hydrate();
    cache.watch();

    await chrome.storage.local.set({
      [STORAGE_KEY]: record(settings({ globalOn: false, updatedAt: 9999 }), 2),
    });

    expect(cache.current().globalOn).toBe(true);
    expect(cache.currentSyncMetadata()?.version).toBe(3);
  });

  it("a popup/options write reaches an already-open content cache through storage.onChanged", async () => {
    installChromeStorage({
      [STORAGE_KEY]: record(settings({ globalOn: true, updatedAt: 1 }), 1),
    });
    const popup = new SettingsCache(new ChromeStorageAdapter(), { now: () => 10 });
    const content = new SettingsCache(new ChromeStorageAdapter());
    await Promise.all([popup.hydrate(), content.hydrate()]);
    content.watch();

    await popup.setGlobalOn(false);

    expect(content.current().globalOn).toBe(false);
    expect(content.currentSyncMetadata()?.version).toBe(1);
  });
  it("concurrent default adapters serialize same-key and independent-key broker edits behind durable persistence", async () => {
    const h = installChromeStorage({ [STORAGE_KEY]: record(settings({ updatedAt: 1 }), null) });
    await h.authority.initializeAtomic("never-linked");
    const left = new SettingsCache(new ChromeStorageAdapter(), { now: () => 10 });
    const right = new SettingsCache(new ChromeStorageAdapter(), { now: () => 11 });
    const content = new SettingsCache(new ChromeStorageAdapter());
    await Promise.all([left.hydrate(), right.hydrate(), content.hydrate()]);
    const stop = content.watch(); const notify = vi.fn(); content.subscribe(notify);
    const before = structuredClone(h.store[STORAGE_KEY]); const held = h.gate();
    const first = left.setGlobalOn(false); await held.started;
    const second = right.setGlobalOn(true); const independent = right.setService("youtube", false);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.store[STORAGE_KEY]).toEqual(before); expect(h.replies()).toBe(0); expect(notify).not.toHaveBeenCalled();
    held.release(); await Promise.all([first, second, independent]);
    const saved = h.store[STORAGE_KEY] as StoredSettingsRecord;
    expect(saved.settings).toMatchObject({ globalOn: true, services: { youtube: false } });
    expect(saved.atomic!.pending).toHaveLength(3); expect(saved.atomic!.sequence).toBe(3);
    expect(saved.atomic!.pending.map(p => p.operations[0]!.localStep)).toEqual([1, 2, 1]);
    expect(new Set(saved.atomic!.pending.map(p => p.writeId)).size).toBe(3);
    expect(content.current()).toMatchObject({ globalOn: true, services: { youtube: false } });
    expect(h.replies()).toBe(3); expect(notify).toHaveBeenCalledTimes(3);
    stop(); expect(h.listeners.size).toBe(0);
  });
  it("a rejected broker commit retains bytes and sends no change signal, then a later intent recovers", async () => {
    const h = installChromeStorage({ [STORAGE_KEY]: record(settings({ updatedAt: 1 }), null) });
    await h.authority.initializeAtomic("never-linked");
    const popup = new SettingsCache(new ChromeStorageAdapter(), { now: () => 10 }); await popup.hydrate();
    const content = new SettingsCache(new ChromeStorageAdapter()); await content.hydrate();
    const stop = content.watch(); const notify = vi.fn(); content.subscribe(notify);
    const before = structuredClone(h.store[STORAGE_KEY]); const held = h.gate();
    const first = popup.setGlobalOn(false); const failed = expect(first).rejects.toThrow("authority-unavailable");
    await held.started; held.fail(); await failed;
    expect(h.store[STORAGE_KEY]).toEqual(before); expect(notify).not.toHaveBeenCalled(); expect(content.current().globalOn).toBe(true);
    await popup.setService("youtube", false);
    const saved = h.store[STORAGE_KEY] as StoredSettingsRecord;
    expect(saved.atomic!.pending).toHaveLength(1); expect(saved.atomic!.sequence).toBe(1);
    expect(saved.settings).toMatchObject({ globalOn: true, services: { youtube: false } });
    expect(notify).toHaveBeenCalledTimes(1); stop(); expect(h.listeners.size).toBe(0);
  });
  it("only the Chromium/Firefox local authority can admit a fresh record", async () => {
    const h = installChromeStorage();
    await expect(new ChromeStorageAdapter().initializeFreshAtomic()).rejects.toThrow("authority-unavailable");
    await expect(new ChromeStorageAdapter({ authority: true, nativeMirror: true }).initializeFreshAtomic()).rejects.toThrow("authority-unavailable");
    expect(Object.hasOwn(h.store, STORAGE_KEY)).toBe(false);
    await h.authority.initializeFreshAtomic();
    expect(h.store[STORAGE_KEY]).toMatchObject({ atomic: { ownership: "never-linked" } });
  });
  it("only the Chromium/Firefox local authority can save the untouched-upgrade record", async () => {
    const h = installChromeStorage();
    await expect(new ChromeStorageAdapter().initializeUntouchedUpgradeAtomic()).rejects.toThrow("authority-unavailable");
    await expect(new ChromeStorageAdapter({ authority: true, nativeMirror: true }).initializeUntouchedUpgradeAtomic()).rejects.toThrow("authority-unavailable");
    expect(Object.hasOwn(h.store, STORAGE_KEY)).toBe(false);
    await h.authority.initializeUntouchedUpgradeAtomic();
    expect(h.store[STORAGE_KEY]).toMatchObject({ settings: { schemaVersion: 2, globalOn: true }, atomic: { ownership: "unknown", sequence: 0 } });
  });
  it("a settings peer queued before the untouched-upgrade record keeps its Off choice", async () => {
    const h = installChromeStorage(); const held = h.gate();
    const peer = h.authority.commitIntent({ path: "globalOn", value: false, updatedAt: 42 }); await held.started;
    const upgrade = h.authority.initializeUntouchedUpgradeAtomic();
    expect(Object.hasOwn(h.store, STORAGE_KEY)).toBe(false); held.release(); await peer;
    expect(await upgrade).toMatchObject({ settings: { globalOn: false, updatedAt: 42 } });
    expect(h.store[STORAGE_KEY]).toMatchObject({ settings: { globalOn: false, updatedAt: 42 } });
    expect((h.store[STORAGE_KEY] as StoredSettingsRecord).atomic).toBeUndefined();
  });
  it("a settings peer queued before fresh admission preserves its Off choice", async () => {
    const h = installChromeStorage(); const held = h.gate();
    const peer = h.authority.commitIntent({ path: "globalOn", value: false, updatedAt: 42 }); await held.started;
    const fresh = h.authority.initializeFreshAtomic(); const denied = expect(fresh).rejects.toThrow("fresh-provenance-conflict");
    expect(Object.hasOwn(h.store, STORAGE_KEY)).toBe(false); held.release(); await peer; await denied;
    expect(h.store[STORAGE_KEY]).toMatchObject({ settings: { globalOn: false, updatedAt: 42 } });
    expect((h.store[STORAGE_KEY] as StoredSettingsRecord).atomic).toBeUndefined();
  });
  it("auth/history mutation and install publication share one admission order", async () => {
    const h = installChromeStorage(); const held = h.gate();
    const history = h.authority.serializeLocalMutation(() => chrome.storage.local.set({ "still:last-identity": "retained" })); await held.started;
    const fresh = h.authority.initializeFreshAtomic(); const denied = expect(fresh).rejects.toThrow("fresh-provenance-conflict");
    expect(Object.hasOwn(h.store, STORAGE_KEY)).toBe(false); held.release(); await history; await denied;
    expect(h.store["still:last-identity"]).toBe("retained"); expect(Object.hasOwn(h.store, STORAGE_KEY)).toBe(false);
  });
  it("a later account mutation cannot interleave inside an admitted settings publication", async () => {
    const h = installChromeStorage(); const held = h.gate();
    const fresh = h.authority.initializeFreshAtomic(); await held.started;
    const history = h.authority.serializeLocalMutation(() => chrome.storage.local.set({ "still:last-identity": "later" }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(Object.hasOwn(h.store, STORAGE_KEY)).toBe(false); expect(Object.hasOwn(h.store, "still:last-identity")).toBe(false);
    held.release(); await fresh; await history;
    expect(h.store[STORAGE_KEY]).toMatchObject({ atomic: { ownership: "never-linked" } }); expect(h.store["still:last-identity"]).toBe("later");
  });
  it.each(["unknown", "previous-account", "never-linked"] as const)("existing %s modern bytes have no initialization write", async ownership => {
    const h = installChromeStorage({ [STORAGE_KEY]: record(settings({ globalOn: false, updatedAt: 42 }), null) });
    const saved = await h.authority.initializeAtomic(ownership);
    const enhanced = { ...saved, opaque: { retained: true }, atomic: { ...saved.atomic!, futureState: 3, paused: "retained-hold" } };
    h.store[STORAGE_KEY] = enhanced; const before = JSON.stringify(enhanced); const write = vi.spyOn(chrome.storage.local, "set");
    await h.authority.initializeAtomic("unknown");
    await expect(h.authority.initializeFreshAtomic()).rejects.toThrow("fresh-provenance-conflict");
    expect(JSON.stringify(h.store[STORAGE_KEY])).toBe(before); expect(write).not.toHaveBeenCalled(); write.mockRestore();
  });

});
