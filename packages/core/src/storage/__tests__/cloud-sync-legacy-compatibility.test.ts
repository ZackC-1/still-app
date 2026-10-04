import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../cache.js";
import { ChromeStorageAdapter } from "../chrome-adapter.js";
import {
  SettingsStorageRecovery,
  requireModernSettings,
} from "../atomic-settings.js";
import { createSettingsIntentRouter } from "../settings-messages.js";
import type { StoredSettingsRecord } from "../adapter.js";
import { SupabaseBackendPort } from "../../sync/profile.js";
import { SyncService } from "../../sync/service.js";

const KEY = "still:settings",
  USER = "11111111-1111-4111-8111-111111111111";
const clients: SupabaseClient[] = [];
const stops: (() => void)[] = [];
const legacy = (): StoredSettingsRecord => ({
  settings: { ...structuredClone(DEFAULT_SETTINGS), updatedAt: 1 },
  syncMetadata: null,
});
function browser(initial: Record<string, unknown> = { [KEY]: legacy() }) {
  const store = structuredClone(initial),
    writes: StoredSettingsRecord[] = [];
  const changes = new Set<
    Parameters<typeof chrome.storage.onChanged.addListener>[0]
  >();
  const origin = "chrome-extension://compatibility/";
  const local = {
    async get(key: string) {
      return Object.hasOwn(store, key)
        ? { [key]: structuredClone(store[key]) }
        : {};
    },
    async set(values: Record<string, unknown>) {
      for (const [key, value] of Object.entries(values)) {
        const oldValue = store[key];
        store[key] = structuredClone(value);
        if (key === KEY)
          writes.push(structuredClone(value) as StoredSettingsRecord);
        for (const listener of changes)
          listener({ [key]: { oldValue, newValue: value } }, "local");
      }
    },
  };
  vi.stubGlobal("chrome", {
    storage: {
      local,
      onChanged: {
        addListener: (fn: Parameters<typeof changes.add>[0]) => changes.add(fn),
        removeListener: (fn: Parameters<typeof changes.add>[0]) =>
          changes.delete(fn),
      },
    },
    runtime: {
      id: "compatibility",
      getURL: () => origin,
      sendMessage: (message: unknown) =>
        new Promise((resolve) => {
          if (
            !router(
              message,
              { id: "compatibility", url: origin + "popup.html" },
              resolve,
            )
          )
            resolve(undefined);
        }),
    },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  const intent = vi.spyOn(authority, "commitIntent"),
    replacement = vi.spyOn(authority, "set");
  const router = createSettingsIntentRouter(
    (value) => authority.commitIntent(value),
    "compatibility",
    origin,
    (value) => authority.set(value),
  );
  const cache = new SettingsCache(new ChromeStorageAdapter(), {
    now: () => 100,
  });
  stops.push(cache.watch());
  return { store, writes, local, authority, cache, intent, replacement };
}

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const client of clients.splice(0)) {
    await client.removeAllChannels();
    await client.auth.dispose();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("maintained legacy cache and raw authority compatibility", () => {
  it("validated legacy global and service edits use the same record authority and publish real local notifications", async () => {
    const h = browser();
    await h.cache.hydrate();
    const events: string[] = [];
    h.cache.subscribe((_settings, source) => events.push(source));
    await h.cache.setGlobalOn(false);
    await h.cache.setService("instagram", false);
    expect(h.intent).toHaveBeenCalledTimes(2);
    expect(h.replacement).not.toHaveBeenCalled();
    expect(events.filter((source) => source === "local")).toHaveLength(2);
    expect(h.store[KEY]).toMatchObject({
      settings: {
        globalOn: false,
        services: { instagram: false },
        updatedAt: 100,
      },
      syncMetadata: null,
    });
    expect((h.store[KEY] as StoredSettingsRecord).atomic).toBeUndefined();
  });
  it("proven key absence reads null and allows a deliberate legacy core edit", async () => {
    const h = browser({});
    expect(await h.authority.get()).toBeNull();
    await h.cache.hydrate();
    await h.cache.setGlobalOn(false);
    expect(h.store[KEY]).toMatchObject({
      settings: { globalOn: false },
      syncMetadata: null,
    });
    expect(h.intent).toHaveBeenCalledOnce();
  });
  it.each([
    null,
    undefined,
    "corrupt",
    {},
    { settings: { schemaVersion: 99 } },
  ])(
    "present unparsable %j is unreadable and cannot become a legacy write",
    async (raw) => {
      const h = browser({ [KEY]: raw });
      await expect(h.authority.get()).rejects.toMatchObject({
        reason: "unreadable",
      });
      await expect(h.cache.hydrate()).rejects.toBeInstanceOf(
        SettingsStorageRecovery,
      );
      await expect(h.cache.setGlobalOn(false)).rejects.toBeInstanceOf(
        SettingsStorageRecovery,
      );
      await expect(h.cache.setService("youtube", false)).rejects.toBeInstanceOf(
        SettingsStorageRecovery,
      );
      expect(h.store[KEY]).toEqual(raw);
      expect(h.writes).toEqual([]);
      expect(h.intent).not.toHaveBeenCalled();
      expect(h.replacement).not.toHaveBeenCalled();
    },
  );
  it("retained raw null is not empty history for actual SyncService and SDK legacy account adoption", async () => {
    const h = browser({ [KEY]: null });
    await h.cache.hydrate().catch(() => undefined);
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            settings: { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 2 },
            settings_version: 1,
            settings_server_updated_at: "2026-10-04T00:00:00Z",
            settings_last_write_id: null,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const client = createClient(
      "https://core-compatibility.invalid",
      "synthetic-public-key",
      {
        global: { fetch: transport },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    clients.push(client);
    const backend = new SupabaseBackendPort(client);
    const sync = new SyncService(
      h.cache,
      {
        currentUserId: async () => USER,
        signInWithMagicLink: async () => ({}),
        signOut: async () => {},
      },
      backend,
    );
    await sync.resume(USER, false);
    await h.authority.serializeLocalMutation(async () => {});
    expect(transport).not.toHaveBeenCalled();
    expect(h.store[KEY]).toBeNull();
    expect(h.writes).toEqual([]);
    expect(sync.getState().cloudReachable).toBe(false);
    await sync.signOut();
  });
  it("current atomic core edits stay intents and legacy snapshot imports cannot downgrade", async () => {
    const h = browser();
    await h.authority.initializeAtomic("never-linked");
    await h.cache.hydrate();
    await h.cache.setGlobalOn(false);
    await h.cache.setService("facebook", false);
    expect(h.intent).toHaveBeenCalledTimes(2);
    expect(h.replacement).not.toHaveBeenCalled();
    const current = await h.authority.get();
    expect(requireModernSettings(current!).globalOn).toBe(false);
    expect(requireModernSettings(current!).services.facebook).toBe(false);
    await h.authority.set(legacy());
    expect(await h.authority.get()).toEqual(current);
  });
  it.each(["unknown", "never-linked"] as const)(
    "atomic %s ownership and pause never enable a legacy fallback",
    async (ownership) => {
      const h = browser();
      const migrated = await h.authority.initializeAtomic(ownership);
      await h.local.set({
        [KEY]: {
          ...migrated,
          atomic: { ...migrated.atomic!, paused: "ownership-hold" },
        },
      });
      await h.cache.hydrate();
      const raw = structuredClone(h.store[KEY]);
      if (ownership === "unknown") {
        await expect(h.cache.setGlobalOn(false)).rejects.toBeInstanceOf(
          SettingsStorageRecovery,
        );
        await expect(
          h.cache.setService("youtube", false),
        ).rejects.toBeInstanceOf(SettingsStorageRecovery);
        expect(h.store[KEY]).toEqual(raw);
      } else {
        await h.cache.setGlobalOn(false);
        await h.cache.setService("youtube", false);
        expect((h.store[KEY] as StoredSettingsRecord).atomic).toBeDefined();
      }
      expect(h.replacement).not.toHaveBeenCalled();
    },
  );
  it("V3 core/feature command entry denies legacy state without migrating or creating history", async () => {
    const h = browser();
    await h.cache.hydrate();
    const raw = structuredClone(h.store[KEY]);
    await expect(
      h.cache.commitAtomicIntent("globalOn", false),
    ).rejects.toMatchObject({ reason: "atomic-command-unavailable" });
    await expect(
      h.cache.setFeature("youtube.related", true),
    ).rejects.toBeInstanceOf(SettingsStorageRecovery);
    expect(h.store[KEY]).toEqual(raw);
    expect(h.writes).toEqual([]);
    expect(h.replacement).not.toHaveBeenCalled();
  });
});
