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
        updatedAt: 101,
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

// The actual SDK's HTTP requests terminate here; no socket or global fetch can leave this test.
class CompatibilitySocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly protocol = "";
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  constructor(address: string | URL) {
    super();
    this.url = String(address);
  }
  close() {
    this.readyState = 3;
  }
  send() {
    throw new Error("Unexpected socket send");
  }
}

let cloudClientCount = 0;
async function legacyCloud(now: () => number) {
  const initial: StoredSettingsRecord = {
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      globalOn: false,
      updatedAt: 1,
    },
    syncMetadata: {
      version: 5,
      serverUpdatedAt: "2026-10-04T00:00:00.005Z",
      lastWriteId: "initial",
    },
    syncEpoch: 2,
  };
  const h = browser({ [KEY]: initial });
  const consumer = new SettingsCache(new ChromeStorageAdapter(), { now });
  const background = new SettingsCache(h.authority);
  stops.push(consumer.watch(), background.watch());
  await consumer.hydrate();
  await background.hydrate();
  let cloud = {
    settings: structuredClone(initial.settings),
    settings_version: initial.syncMetadata!.version,
    settings_server_updated_at: initial.syncMetadata!.serverUpdatedAt,
    settings_last_write_id: initial.syncMetadata!.lastWriteId,
  };
  const uploaded: StoredSettingsRecord["settings"][] = [];
  const outbound = vi.fn(() => {
    throw new Error("Outbound network denied");
  });
  vi.stubGlobal("fetch", outbound);
  vi.stubGlobal("WebSocket", CompatibilitySocket);
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://core-compatibility.invalid")
        throw new Error("Unexpected SDK origin");
      if (
        url.pathname === "/rest/v1/rpc/write_profile_settings" &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body)) as {
          p_settings: StoredSettingsRecord["settings"];
          p_write_id: string;
        };
        uploaded.push(structuredClone(body.p_settings));
        cloud = {
          settings: structuredClone(body.p_settings),
          settings_version: cloud.settings_version + 1,
          settings_server_updated_at: new Date(
            1_791_072_000_000 + cloud.settings_version + 1,
          ).toISOString(),
          settings_last_write_id: body.p_write_id,
        };
      } else if (
        url.pathname !== "/rest/v1/profiles" ||
        init?.method !== "GET"
      ) {
        throw new Error(
          `Unexpected SDK request: ${init?.method} ${url.pathname}`,
        );
      }
      return new Response(JSON.stringify(cloud), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  const client = createClient(
    "https://core-compatibility.invalid",
    "synthetic-public-key",
    {
      global: { fetch: transport },
      realtime: { transport: CompatibilitySocket },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        storageKey: `legacy-cloud-${cloudClientCount++}`,
      },
    },
  );
  clients.push(client);
  const sync = new SyncService(
    background,
    {
      currentUserId: async () => USER,
      signInWithMagicLink: async () => ({}),
      signOut: async () => {},
    },
    new SupabaseBackendPort(client),
  );
  const settle = async () => {
    await h.authority.serializeLocalMutation(async () => {});
    await vi.waitFor(() => expect(sync.getState().pendingUpload).toBe(false));
    await h.authority.serializeLocalMutation(async () => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  await sync.resume(USER, false);
  await settle();
  expect(uploaded).toEqual([]);
  return {
    ...h,
    consumer,
    background,
    sync,
    uploaded,
    outbound,
    settle,
    cloud: () => cloud,
  };
}

describe("legacy deliberate intent ordering through watched background and actual SDK cloud", () => {
  it.each([
    { label: "same millisecond", second: 100, expected: 101 },
    { label: "backward clock", second: 50, expected: 101 },
    { label: "newer clock control", second: 200, expected: 200 },
  ])(
    "$label publishes the second durable choice exactly once",
    async ({ second, expected }) => {
      let now = 100;
      const h = await legacyCloud(() => now);
      try {
        await h.consumer.setGlobalOn(true);
        await h.settle();
        expect(h.cloud().settings.globalOn).toBe(true);
        expect(h.uploaded).toHaveLength(1);
        now = second;
        await h.consumer.setService("facebook", false);
        await h.settle();
        // The durable/consumer result alone missed the inherited bug: assert the real SDK row first.
        expect(
          (h.store[KEY] as StoredSettingsRecord).settings.services.facebook,
        ).toBe(false);
        expect(h.consumer.current().services.facebook).toBe(false);
        expect(h.cloud().settings.services.facebook).toBe(false);
        expect(h.background.current().services.facebook).toBe(false);
        expect(h.uploaded).toHaveLength(2);
        expect(h.uploaded[1]).toMatchObject({
          globalOn: true,
          services: { facebook: false },
          updatedAt: expected,
        });
        const saved = structuredClone(h.store[KEY]) as StoredSettingsRecord;
        expect(saved.atomic).toBeUndefined();
        expect(saved.syncEpoch).toBe(2);
        expect(saved.syncMetadata?.version).toBe(7);
        const reopened = new SettingsCache(new ChromeStorageAdapter());
        await reopened.hydrate();
        expect(reopened.currentRecord()).toEqual(h.background.currentRecord());
        expect(reopened.current().services.facebook).toBe(false);
        const writes = h.writes.length;
        await h.consumer.setService("facebook", false);
        await h.settle();
        expect(h.store[KEY]).toEqual(saved);
        expect(h.writes).toHaveLength(writes);
        expect(h.uploaded).toHaveLength(2);
        expect(h.outbound).not.toHaveBeenCalled();
      } finally {
        await h.sync.signOut();
      }
    },
  );

  it("stale/equal watched records and older account/row authority cannot flip the saved choice", async () => {
    const h = await legacyCloud(() => 100);
    try {
      await h.consumer.setGlobalOn(true);
      await h.settle();
      await h.consumer.setService("facebook", false);
      await h.settle();
      const saved = structuredClone(h.store[KEY]) as StoredSettingsRecord;
      const alternate = {
        ...saved.settings,
        services: { ...saved.settings.services, facebook: true },
      };
      for (const stale of [
        { ...saved, settings: alternate },
        {
          ...saved,
          settings: { ...alternate, updatedAt: saved.settings.updatedAt - 1 },
        },
        { ...saved, settings: { ...alternate, updatedAt: 999 }, syncEpoch: 1 },
        {
          ...saved,
          settings: { ...alternate, updatedAt: 999 },
          syncMetadata: {
            ...saved.syncMetadata!,
            version: saved.syncMetadata!.version - 1,
          },
        },
      ]) {
        await h.local.set({ [KEY]: stale });
        await h.settle();
        expect(h.consumer.currentRecord()).toEqual(saved);
        expect(h.background.currentRecord()).toEqual(saved);
        expect(h.cloud().settings.services.facebook).toBe(false);
        expect(h.uploaded).toHaveLength(2);
        await h.local.set({ [KEY]: saved });
      }
      // Authoritative snapshot import still refuses genuinely older epoch/version records on disk.
      for (const stale of [
        { ...saved, settings: { ...alternate, updatedAt: 999 }, syncEpoch: 1 },
        {
          ...saved,
          settings: { ...alternate, updatedAt: 999 },
          syncMetadata: { ...saved.syncMetadata!, version: 6 },
        },
      ]) {
        await h.authority.set(stale);
        expect(await h.authority.get()).toEqual(saved);
      }
      expect(h.outbound).not.toHaveBeenCalled();
    } finally {
      await h.sync.signOut();
    }
  });
});

describe("legacy timestamp bounds and same-writer serialization", () => {
  it("queued changed intents read the latest durable stamp and preserve opaque members and authority", async () => {
    const initial = {
      ...legacy(),
      syncEpoch: 3,
      syncMetadata: {
        version: 8,
        serverUpdatedAt: "2026-10-04T00:00:00Z",
        lastWriteId: "retained",
      },
      futureRoot: { retained: [false, "opaque"] },
      settings: {
        ...legacy().settings,
        futureSetting: { retained: true },
        services: { ...legacy().settings.services, futureService: false },
      },
    };
    const h = browser({ [KEY]: initial });
    const results = await Promise.all([
      h.authority.commitIntent({
        path: "globalOn",
        value: false,
        updatedAt: 100,
      }),
      h.authority.commitIntent({
        path: "services.facebook",
        value: false,
        updatedAt: 100,
      }),
      h.authority.commitIntent({
        path: "services.instagram",
        value: false,
        updatedAt: 50,
      }),
    ]);
    expect(results.map((record) => record.settings.updatedAt)).toEqual([
      100, 101, 102,
    ]);
    expect(results.every((record) => record.intentCommitted === true)).toBe(
      true,
    );
    const saved = await h.authority.get();
    expect(saved).toEqual({
      ...initial,
      settings: {
        ...initial.settings,
        globalOn: false,
        services: {
          ...initial.settings.services,
          facebook: false,
          instagram: false,
        },
        updatedAt: 102,
      },
    });
    expect(saved?.atomic).toBeUndefined();
    expect(h.writes).toHaveLength(3);
    const noop = await h.authority.commitIntent({
      path: "services.facebook",
      value: false,
      updatedAt: 200,
    });
    expect(noop).toEqual({ ...saved, intentCommitted: false });
    expect(await h.authority.get()).toEqual(saved);
    expect(h.writes).toHaveLength(3);
    const reopened = new ChromeStorageAdapter({ authority: true });
    expect(await reopened.get()).toEqual(saved);
  });

  it("uses a valid next integer after a readable fractional legacy stamp", async () => {
    const h = browser({
      [KEY]: {
        ...legacy(),
        settings: { ...legacy().settings, updatedAt: 100.5 },
      },
    });
    const saved = await h.authority.commitIntent({
      path: "globalOn",
      value: false,
      updatedAt: 100,
    });
    expect(saved.settings.updatedAt).toBe(101);
    expect(saved.intentCommitted).toBe(true);
    expect((await h.authority.get())?.settings.updatedAt).toBe(101);
  });

  it.each([
    Number.MAX_SAFE_INTEGER - 1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "refuses before write when the strictly next safe timestamp is unavailable from %s, with no-op intact",
    async (updatedAt) => {
      const initial = {
        ...legacy(),
        settings: { ...legacy().settings, updatedAt },
      };
      const h = browser({ [KEY]: initial });
      const noop = await h.authority.commitIntent({
        path: "globalOn",
        value: true,
        updatedAt: 100,
      });
      expect(noop).toEqual({ ...initial, intentCommitted: false });
      expect(h.writes).toEqual([]);
      if (updatedAt === Number.MAX_SAFE_INTEGER - 1) {
        const last = await h.authority.commitIntent({
          path: "globalOn",
          value: false,
          updatedAt: 100,
        });
        expect(last.settings.updatedAt).toBe(Number.MAX_SAFE_INTEGER);
        expect(last.intentCommitted).toBe(true);
      }
      const before = JSON.stringify(h.store[KEY]);
      const writes = h.writes.length;
      await expect(
        h.authority.commitIntent({
          path: "services.facebook",
          value: false,
          updatedAt: 100,
        }),
      ).rejects.toMatchObject({ reason: "ordering-hold" });
      expect(JSON.stringify(h.store[KEY])).toBe(before);
      expect(h.writes).toHaveLength(writes);
      const retained = await h.authority.commitIntent({
        path: "services.facebook",
        value: true,
        updatedAt: 100,
      });
      expect(retained.intentCommitted).toBe(false);
      expect(JSON.stringify(h.store[KEY])).toBe(before);
      expect(h.writes).toHaveLength(writes);
    },
  );
});
