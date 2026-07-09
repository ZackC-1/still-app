import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type StillSettings } from "@still/shared-types";
import {
  ChromeStorageAdapter,
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
  const listeners = new Set<(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void>();
  const chromeMock = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: store[key] };
        },
        async set(values: Record<string, unknown>) {
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
  globalThis.chrome = chromeMock as unknown as typeof chrome;
  return { store };
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
});
