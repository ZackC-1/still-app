import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../cache.js";
import { ChromeStorageAdapter } from "../chrome-adapter.js";
import { createSettingsIntentRouter } from "../settings-messages.js";
import { AtomicSettingsWriter } from "../atomic-settings.js";
import {
  InMemoryStorageAdapter,
  type StoredSettingsRecord,
} from "../adapter.js";

const KEY = "still:settings";
const ORIGIN = "chrome-extension://still/";
function saved(on = false, updatedAt = 100) {
  return {
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      schemaVersion: 1,
      globalOn: on,
      services: { ...DEFAULT_SETTINGS.services, youtube: false, tiktok: false },
      updatedAt,
      opaqueChoice: { retained: false },
    },
    syncMetadata: null,
    syncEpoch: 0,
    opaqueRoot: { retained: true },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Synthetic Chrome storage/transport, maintained production consumer, authority and intent router.
function browser(initial: unknown, present = true) {
  let raw: unknown = structuredClone(initial);
  let exists = present;
  const listeners = new Set<
    (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => void
  >();
  const local = {
    get: vi.fn(async (): Promise<Record<string, unknown>> =>
      exists ? { [KEY]: structuredClone(raw) } : {},
    ),
    set: vi.fn(async (values: Record<string, unknown>) => {
      raw = structuredClone(values[KEY]);
      exists = true;
    }),
  };
  const sendMessage = vi.fn<(message: unknown) => Promise<unknown>>();
  vi.stubGlobal("chrome", {
    storage: {
      local,
      onChanged: {
        addListener: (listener: Parameters<typeof listeners.add>[0]) =>
          listeners.add(listener),
        removeListener: (listener: Parameters<typeof listeners.add>[0]) =>
          listeners.delete(listener),
      },
    },
    runtime: { getURL: () => ORIGIN, sendMessage },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  const route = createSettingsIntentRouter(
    authority.commitIntent.bind(authority),
    "still",
    ORIGIN,
  );
  sendMessage.mockImplementation(
    (message) =>
      new Promise((resolve, reject) => {
        if (
          !route(
            structuredClone(message),
            { id: "still", url: `${ORIGIN}popup.html` },
            (reply) => resolve(structuredClone(reply)),
          )
        )
          reject(new Error("Synthetic sender was not admitted"));
      }),
  );
  const consumer = new ChromeStorageAdapter();
  const cache = new SettingsCache(consumer, { now: () => 200 });
  return {
    cache,
    consumer,
    authority,
    local,
    sendMessage,
    raw: () => structuredClone(raw),
    put(value: unknown, keyPresent = true) {
      raw = structuredClone(value);
      exists = keyPresent;
    },
    emit(record: StoredSettingsRecord) {
      raw = structuredClone(record);
      exists = true;
      for (const listener of [...listeners])
        listener({ [KEY]: { newValue: structuredClone(record) } }, "local");
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("explicit legacy saved-read receipts", () => {
  it("keeps defaults distinct from an initial and in-flight saved read", async () => {
    const h = browser(saved());
    const gate = deferred<Record<string, unknown>>();
    h.local.get.mockImplementationOnce(() => gate.promise);
    expect(h.cache.current()).toEqual(DEFAULT_SETTINGS);
    expect(h.cache.legacyReadState()).toEqual({
      status: "loading",
      settings: null,
    });
    const load = h.cache.hydrate();
    expect(h.cache.legacyReadState()).toEqual({
      status: "loading",
      settings: null,
    });
    await expect(h.cache.commitLegacyIntent("globalOn", false)).rejects.toThrow(
      "legacy-command-unavailable",
    );
    expect(h.sendMessage).not.toHaveBeenCalled();
    gate.resolve({ [KEY]: saved() });
    await load;
    expect(h.cache.legacyReadState()).toEqual({
      status: "ready",
      settings: saved().settings,
    });
    expect(h.local.set).not.toHaveBeenCalled();
  });

  it.each([
    null,
    undefined,
    "malformed",
    { settings: { globalOn: false } },
    { ...saved(), settings: { ...saved().settings, schemaVersion: 3 } },
  ])(
    "holds retained unreadable keyed storage %j without manufacturing saved defaults",
    async (raw) => {
      const h = browser(raw);
      const before = h.raw();
      await expect(h.cache.hydrate()).rejects.toThrow("unreadable");
      expect(h.cache.legacyReadState()).toEqual({
        status: "unavailable",
        settings: null,
        reason: "unreadable",
      });
      await expect(
        h.cache.commitLegacyIntent("globalOn", false),
      ).rejects.toThrow("legacy-command-unavailable");
      expect(h.local.set).not.toHaveBeenCalled();
      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.raw()).toEqual(before);
    },
  );

  it("exposes generic read failure separately from actual absence", async () => {
    const h = browser(saved());
    h.local.get.mockRejectedValueOnce(new Error("Synthetic read failure"));
    await expect(h.cache.hydrate()).rejects.toThrow("Synthetic read failure");
    expect(h.cache.legacyReadState()).toEqual({
      status: "unavailable",
      settings: null,
      reason: "read-failed",
    });
    await expect(
      h.cache.commitLegacyIntent("services.youtube", true),
    ).rejects.toThrow("legacy-command-unavailable");
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.raw()).toEqual(saved());
  });

  it("labels an actual absent read without writes, preserving the deliberate-edit contract", async () => {
    const h = browser(undefined, false);
    const initialize = vi.spyOn(h.consumer, "initializeAtomic");
    await h.cache.hydrate();
    expect(h.cache.legacyReadState()).toEqual({
      status: "absent",
      settings: null,
    });
    expect(h.local.set).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(await h.cache.commitLegacyIntent("globalOn", false)).toMatchObject({
      intentCommitted: true,
      settings: { globalOn: false },
    });
    expect(h.local.set).toHaveBeenCalledTimes(1);
    expect(h.cache.legacyReadState()).toMatchObject({
      status: "ready",
      settings: { globalOn: false },
    });
  });

  it("does not call an explicit schema2-without-provenance record legacy-ready", async () => {
    const storage = new InMemoryStorageAdapter(saved());
    const modern = await new AtomicSettingsWriter(storage).initialize(
      "never-linked",
    );
    const { atomic: _atomic, ...withoutProvenance } = modern;
    const h = browser(withoutProvenance);
    await h.cache.hydrate();
    expect(h.cache.legacyReadState()).toMatchObject({
      status: "unavailable",
      settings: null,
    });
    await expect(h.cache.commitLegacyIntent("globalOn", true)).rejects.toThrow(
      "legacy-command-unavailable",
    );
    await expect(h.cache.commitAtomicIntent("globalOn", true)).rejects.toThrow(
      "atomic-command-unavailable",
    );
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.raw()).toEqual(withoutProvenance);
  });

  it("records actual zero-clock Off choices without relabeling the startup snapshot as saved", async () => {
    const h = browser(saved(false, 0));
    await h.cache.hydrate();
    expect(h.cache.legacyReadState()).toEqual({
      status: "ready",
      settings: saved(false, 0).settings,
    });
    const edits = vi.fn();
    h.cache.subscribe(edits);
    expect(
      (await h.cache.commitLegacyIntent("globalOn", false)).intentCommitted,
    ).toBe(false);
    expect(h.cache.current().globalOn).toBe(false);
    expect(h.local.set).not.toHaveBeenCalled();
    expect(edits.mock.calls.every(([, source]) => source !== "local")).toBe(
      true,
    );
  });
});

describe("pure current legacy rereads", () => {
  it("a current saved reread fences an older initial reply even when its captured epoch is higher", async () => {
    const h = browser(saved());
    const gate = deferred<Record<string, unknown>>();
    h.local.get.mockImplementationOnce(() => gate.promise);
    const initial = h.cache.hydrate();
    expect(await h.cache.rereadLegacyAuthority()).toEqual({ status: "ready" });
    gate.resolve({ [KEY]: { ...saved(true), syncEpoch: 5 } });
    await initial;
    expect(h.cache.currentRecord()).toMatchObject({
      settings: { globalOn: false },
      syncEpoch: 0,
    });
    expect(h.cache.legacyReadState()).toEqual({
      status: "ready",
      settings: saved().settings,
    });
    expect(h.local.set).not.toHaveBeenCalled();
  });

  it.each(["read-failed", "unreadable"] as const)(
    "a newer %s read failure fences an older successful initial hydration",
    async (reason) => {
      const h = browser(saved());
      const gate = deferred<Record<string, unknown>>();
      h.local.get.mockImplementationOnce(() => gate.promise);
      const initial = h.cache.hydrate();
      if (reason === "read-failed")
        h.local.get.mockRejectedValueOnce(new Error("Current read failed"));
      else
        h.put({
          ...saved(),
          settings: { ...saved().settings, schemaVersion: 3 },
        });
      expect(await h.cache.rereadLegacyAuthority()).toEqual({
        status: "unavailable",
        reason,
      });
      gate.resolve({ [KEY]: saved() });
      await initial;
      expect(h.cache.legacyReadState()).toEqual({
        status: "unavailable",
        settings: null,
        reason,
      });
      expect(h.cache.current()).toEqual(DEFAULT_SETTINGS);
      expect(h.local.set).not.toHaveBeenCalled();
    },
  );

  it("a newer readable unsupported-schema read also fences an older initial legacy reply", async () => {
    const h = browser(saved());
    const gate = deferred<Record<string, unknown>>();
    h.local.get.mockImplementationOnce(() => gate.promise);
    const initial = h.cache.hydrate();
    const modern = await new AtomicSettingsWriter(
      new InMemoryStorageAdapter(saved()),
    ).initialize("never-linked");
    const { atomic: _atomic, ...withoutProvenance } = modern;
    h.put(withoutProvenance);
    expect(await h.cache.rereadLegacyAuthority()).toEqual({
      status: "unavailable",
      reason: "legacy-command-unavailable",
    });
    gate.resolve({ [KEY]: saved() });
    await initial;
    expect(h.cache.legacyReadState()).toEqual({
      status: "unavailable",
      settings: null,
      reason: "legacy-command-unavailable",
    });
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.raw()).toEqual(withoutProvenance);
  });

  it("adopts same-version metadata during a pure read without using the persisting import path", async () => {
    const before = {
      ...saved(),
      syncMetadata: {
        version: 7,
        serverUpdatedAt: "2026-10-02T00:00:00Z",
        lastWriteId: null,
      },
    };
    const h = browser(before);
    await h.cache.hydrate();
    const edits = vi.fn();
    h.cache.subscribe(edits);
    const changed = {
      ...before,
      syncMetadata: {
        ...before.syncMetadata,
        serverUpdatedAt: "2026-10-04T00:00:00Z",
      },
    };
    h.put(changed);
    expect(await h.cache.rereadLegacyAuthority()).toEqual({ status: "ready" });
    expect(h.cache.currentSyncMetadata()).toEqual(changed.syncMetadata);
    expect(h.raw()).toEqual(changed);
    expect(h.local.set).not.toHaveBeenCalled();
    expect(edits).not.toHaveBeenCalled();
  });
  it("recovers same-choice readiness with one shared get, zero writes/replays and no local edit", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const edit = vi.fn();
    const states = vi.fn();
    h.cache.subscribe(edit);
    h.cache.subscribeLegacyRead(states);
    h.local.get.mockRejectedValueOnce(new Error("Synthetic unavailable read"));
    expect(await h.cache.rereadLegacyAuthority()).toEqual({
      status: "unavailable",
      reason: "read-failed",
    });
    expect(h.cache.legacyReadState()).toEqual({
      status: "unavailable",
      reason: "read-failed",
      settings: saved().settings,
    });
    const before = h.local.get.mock.calls.length;
    const first = h.cache.rereadLegacyAuthority();
    const sibling = h.cache.rereadLegacyAuthority();
    expect(sibling).toBe(first);
    expect(await first).toEqual({ status: "ready" });
    expect(h.local.get.mock.calls.length - before).toBe(1);
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(states).toHaveBeenCalledTimes(4);
    expect(h.cache.legacyReadState()).toEqual({
      status: "ready",
      settings: saved().settings,
    });
  });

  it("recovers a rejected hydration with a pure reread rather than rehydrating", async () => {
    const h = browser(null);
    const initial = h.cache.hydrate();
    await expect(initial).rejects.toThrow("unreadable");
    const initialize = vi.spyOn(h.consumer, "initializeAtomic");
    h.put(saved());
    expect(await h.cache.rereadLegacyAuthority()).toEqual({ status: "ready" });
    expect(h.cache.hydrate()).toBe(initial);
    await expect(h.cache.whenHydrated()).resolves.toBeUndefined();
    expect(h.local.get).toHaveBeenCalledTimes(2);
    expect(h.local.set).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("does not replay a failed write when a current read restores readiness", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    h.local.set.mockRejectedValueOnce(new Error("Synthetic refused write"));
    await expect(h.cache.commitLegacyIntent("globalOn", true)).rejects.toThrow(
      "authority-unavailable",
    );
    expect(h.cache.legacyReadState()).toEqual({
      status: "unavailable",
      reason: "authority-unavailable",
      settings: saved().settings,
    });
    const writes = h.local.set.mock.calls.length;
    const messages = h.sendMessage.mock.calls.length;
    expect(await h.cache.rereadLegacyAuthority()).toEqual({ status: "ready" });
    expect(h.local.set).toHaveBeenCalledTimes(writes);
    expect(h.sendMessage).toHaveBeenCalledTimes(messages);
    expect(h.cache.current().globalOn).toBe(false);
    expect(h.raw()).toEqual(saved());
  });

  it("shares its flight before a synchronous loading observer requests another read", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const before = h.local.get.mock.calls.length;
    let sibling: ReturnType<SettingsCache["rereadLegacyAuthority"]> | undefined;
    h.cache.subscribeLegacyRead(() => {
      if (h.cache.legacyReadState().status === "loading")
        sibling = h.cache.rereadLegacyAuthority();
    });
    const first = h.cache.rereadLegacyAuthority();
    await expect(first).resolves.toEqual({ status: "ready" });
    expect(sibling).toBe(first);
    expect(h.local.get.mock.calls.length - before).toBe(1);
  });

  it.each(["epoch", "metadata"] as const)(
    "external %s authority supersedes an older captured read",
    async (kind) => {
      const h = browser(saved());
      await h.cache.hydrate();
      const stop = h.cache.watch();
      const gate = deferred<Record<string, unknown>>();
      h.local.get.mockImplementationOnce(() => gate.promise);
      const pending = h.cache.rereadLegacyAuthority();
      await vi.waitFor(() =>
        expect(h.cache.legacyReadState().status).toBe("loading"),
      );
      const newer = {
        ...saved(true, 1),
        syncEpoch: kind === "epoch" ? 2 : 0,
        syncMetadata: {
          version: 8,
          serverUpdatedAt: "2026-10-04T00:00:00Z",
          lastWriteId: null,
        },
      };
      try {
        h.emit(newer);
        const current = h.cache.currentRecord();
        gate.resolve({ [KEY]: saved() });
        expect(await pending).toEqual({ status: "superseded" });
        expect(h.cache.currentRecord()).toEqual(current);
        expect(h.cache.legacyReadState()).toMatchObject({
          status: "ready",
          settings: { globalOn: true, updatedAt: 1 },
        });
        expect(h.local.set).not.toHaveBeenCalled();
      } finally {
        gate.resolve({ [KEY]: saved() });
        stop();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "a newer committed edit supersedes stale read %s",
    async (completion) => {
      const h = browser(saved());
      await h.cache.hydrate();
      const gate = deferred<Record<string, unknown>>();
      h.local.get.mockImplementationOnce(() => gate.promise);
      const pending = h.cache.rereadLegacyAuthority();
      await vi.waitFor(() =>
        expect(h.cache.legacyReadState().status).toBe("loading"),
      );
      // Existing legacy setter behavior stays available; the explicit new UI port holds while reading.
      await h.cache.setGlobalOn(true);
      const current = h.cache.currentRecord();
      if (completion === "success") gate.resolve({ [KEY]: saved() });
      else gate.reject(new Error("Late stale read failure"));
      expect(await pending).toEqual({ status: "superseded" });
      expect(h.cache.currentRecord()).toEqual(current);
      expect(h.cache.legacyReadState()).toMatchObject({
        status: "ready",
        settings: { globalOn: true, updatedAt: 200 },
      });
      expect(h.local.set).toHaveBeenCalledTimes(1);
    },
  );

  it("cannot clear a newer atomic ownership/pause hold with a captured legacy read", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const stop = h.cache.watch();
    const gate = deferred<Record<string, unknown>>();
    h.local.get.mockImplementationOnce(() => gate.promise);
    const pending = h.cache.rereadLegacyAuthority();
    await vi.waitFor(() =>
      expect(h.cache.legacyReadState().status).toBe("loading"),
    );
    const modern = await new AtomicSettingsWriter(
      new InMemoryStorageAdapter(saved()),
    ).initialize("unknown");
    const held = {
      ...modern,
      atomic: { ...modern.atomic!, paused: "ownership-hold" },
    };
    try {
      h.emit(held);
      const current = h.cache.currentRecord();
      gate.resolve({ [KEY]: saved() });
      expect(await pending).toEqual({ status: "superseded" });
      expect(h.cache.currentRecord()).toEqual(current);
      expect(current.atomic?.paused).toBe("ownership-hold");
      expect(h.cache.legacyReadState()).toEqual({
        status: "unavailable",
        settings: null,
        reason: "legacy-command-unavailable",
      });
      const reads = h.local.get.mock.calls.length;
      expect(await h.cache.rereadLegacyAuthority()).toEqual({
        status: "unavailable",
        reason: "legacy-command-unavailable",
      });
      expect(h.local.get).toHaveBeenCalledTimes(reads);
      expect(h.local.set).not.toHaveBeenCalled();
      await expect(
        h.cache.commitAtomicIntent("globalOn", true),
      ).rejects.toThrow("atomic-command-unavailable");
    } finally {
      gate.resolve({ [KEY]: saved() });
      stop();
    }
  });

  it("labels a later actual absent read without adopting defaults or writing", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const before = h.cache.current();
    h.put(undefined, false);
    expect(await h.cache.rereadLegacyAuthority()).toEqual({ status: "absent" });
    expect(h.cache.legacyReadState()).toEqual({
      status: "absent",
      settings: null,
    });
    expect(h.cache.current()).toBe(before);
    expect(h.local.set).not.toHaveBeenCalled();
  });

  it("a current absent receipt fences an older initial saved reply", async () => {
    const h = browser(saved());
    const gate = deferred<Record<string, unknown>>();
    h.local.get.mockImplementationOnce(() => gate.promise);
    const initial = h.cache.hydrate();
    h.put(undefined, false);
    expect(await h.cache.rereadLegacyAuthority()).toEqual({ status: "absent" });
    gate.resolve({ [KEY]: saved() });
    await initial;
    expect(h.cache.legacyReadState()).toEqual({
      status: "absent",
      settings: null,
    });
    expect(h.cache.current()).toEqual(DEFAULT_SETTINGS);
    expect(h.local.set).not.toHaveBeenCalled();
  });

  it("a synchronous ready observer can install a newer hold before the reread returns", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const stop = h.cache.watch();
    const modern = await new AtomicSettingsWriter(
      new InMemoryStorageAdapter(saved()),
    ).initialize("unknown");
    const held = {
      ...modern,
      atomic: { ...modern.atomic!, paused: "ownership-hold" },
    };
    const detach = h.cache.subscribeLegacyRead(() => {
      if (h.cache.legacyReadState().status === "ready") h.emit(held);
    });
    try {
      expect(await h.cache.rereadLegacyAuthority()).toEqual({
        status: "unavailable",
        reason: "legacy-command-unavailable",
      });
      expect(h.cache.currentRecord().atomic?.paused).toBe("ownership-hold");
      expect(h.local.set).not.toHaveBeenCalled();
    } finally {
      detach();
      stop();
    }
  });
});

describe("request-specific legacy commit outcomes", () => {
  it.each(["globalOn", "services.youtube"] as const)(
    "returns the durable true then no-op false receipt for %s",
    async (path) => {
      const h = browser(saved());
      await h.cache.hydrate();
      expect(
        (await h.cache.commitLegacyIntent(path, true)).intentCommitted,
      ).toBe(true);
      const after = h.raw();
      expect(
        (await h.cache.commitLegacyIntent(path, true)).intentCommitted,
      ).toBe(false);
      expect(h.local.set).toHaveBeenCalledTimes(1);
      expect(h.raw()).toEqual(after);
    },
  );

  it("preserves true/false receipts for overlapping same-target actions admitted before persistence", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const gate = deferred<void>();
    const persist = h.local.set.getMockImplementation()!;
    h.local.set.mockImplementationOnce(async (values) => {
      await gate.promise;
      await persist(values);
    });
    const pending = Promise.all([
      h.cache.commitLegacyIntent("globalOn", true),
      h.cache.commitLegacyIntent("globalOn", true),
    ]);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(h.local.set).toHaveBeenCalledTimes(1));
      expect(h.cache.current().globalOn).toBe(false);
    } finally {
      gate.resolve();
    }
    expect((await pending).map((r) => r.intentCommitted)).toEqual([
      true,
      false,
    ]);
    expect(h.local.set).toHaveBeenCalledTimes(1);
    expect(h.raw()).toMatchObject({
      settings: { globalOn: true, updatedAt: 200 },
    });
  });

  it("keeps an earlier true receipt truthful when a later commit has superseded its projection", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const gate = deferred<void>();
    const send = h.sendMessage.getMockImplementation()!;
    h.sendMessage.mockImplementationOnce(async (message) => {
      const reply = await send(message);
      await gate.promise;
      return reply;
    });
    const first = h.cache.commitLegacyIntent("globalOn", true);
    await vi.waitFor(() => expect(h.local.set).toHaveBeenCalledTimes(1));
    const second = await h.cache.commitLegacyIntent("globalOn", false);
    expect(second.intentCommitted).toBe(true);
    expect(h.cache.current().updatedAt).toBe(201);
    gate.resolve();
    const earlier = await first;
    expect(earlier.intentCommitted).toBe(true);
    expect(earlier.settings.globalOn).toBe(false);
    expect(earlier.settings.updatedAt).toBe(201);
    expect(h.cache.legacyReadState()).toMatchObject({
      status: "ready",
      settings: { globalOn: false, updatedAt: 201 },
    });
    expect(h.local.set).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed/feature actions before sending and never provides an optimistic fallback", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const commit = h.cache.commitLegacyIntent.bind(h.cache) as (
      path: string,
      value: unknown,
    ) => Promise<unknown>;
    for (const [path, value] of [
      ["sites.youtube.shorts", false],
      ["services.unknown", true],
      ["globalOn", 1],
    ] as const)
      await expect(commit(path, value)).rejects.toThrow(
        "Invalid legacy settings intent",
      );
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.local.set).not.toHaveBeenCalled();
    const adapter = new InMemoryStorageAdapter(saved());
    const cache = new SettingsCache(adapter);
    await cache.hydrate();
    const write = vi.spyOn(adapter, "set");
    await expect(cache.commitLegacyIntent("globalOn", true)).rejects.toThrow(
      "legacy-command-unavailable",
    );
    expect(write).not.toHaveBeenCalled();
    await cache.setGlobalOn(true);
    expect(write).toHaveBeenCalledTimes(1); // unchanged old setter contract
  });
});

describe("reviewed legacy receipt boundaries", () => {
  it.each(["globalOn", "services.youtube"] as const)(
    "an actual absent matching-default %s no-op remains unsaved",
    async (path) => {
      const h = browser(undefined, false);
      await h.cache.hydrate();
      const outcome = await h.cache.commitLegacyIntent(path, true);
      expect(outcome.intentCommitted).toBe(false);
      expect(h.cache.legacyReadState()).toEqual({
        status: "absent",
        settings: null,
      });
      expect(h.local.set).not.toHaveBeenCalled();
      expect(h.raw()).toBeUndefined();
    },
  );

  it("a no-op on an existing saved default-valued record remains saved ready", async () => {
    const record = {
      settings: structuredClone(DEFAULT_SETTINGS),
      syncMetadata: null,
      syncEpoch: 0,
    };
    const h = browser(record);
    await h.cache.hydrate();
    expect(
      (await h.cache.commitLegacyIntent("globalOn", true)).intentCommitted,
    ).toBe(false);
    expect(h.cache.legacyReadState()).toEqual({
      status: "ready",
      settings: record.settings,
    });
    expect(h.cache.current()).toEqual(record.settings);
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.raw()).toEqual(record);
  });

  it.each(["timestamp", "epoch", "server-version"] as const)(
    "adopts a current post-absence recreation after a vanished greater %s record",
    async (kind) => {
      const previous = {
        ...saved(false, 9000),
        syncEpoch: kind === "epoch" ? 7 : 0,
        syncMetadata:
          kind === "server-version"
            ? {
                version: 99,
                serverUpdatedAt: "2026-10-04T00:00:00Z",
                lastWriteId: null,
              }
            : null,
      };
      const h = browser(previous);
      await h.cache.hydrate();
      h.put(undefined, false);
      expect(await h.cache.rereadLegacyAuthority()).toEqual({
        status: "absent",
      });
      expect(h.cache.current().updatedAt).toBe(9000);
      expect(h.local.set).not.toHaveBeenCalled();
      const outcome = await h.cache.commitLegacyIntent("globalOn", false);
      expect(outcome.intentCommitted).toBe(true);
      expect(outcome.settings.globalOn).toBe(false);
      expect(outcome.settings.updatedAt).toBe(200);
      const persisted = await h.consumer.get();
      expect(persisted).not.toBeNull();
      expect(h.cache.current()).toEqual(persisted!.settings);
      expect(h.cache.currentSyncMetadata()).toEqual(persisted!.syncMetadata);
      expect(h.cache.legacyReadState()).toEqual({
        status: "ready",
        settings: persisted!.settings,
      });
      expect(h.local.set).toHaveBeenCalledTimes(1);
    },
  );

  it("later accepted authority supersedes a delayed post-absence recreation receipt", async () => {
    const h = browser(saved(false, 9000));
    await h.cache.hydrate();
    const stop = h.cache.watch();
    h.put(undefined, false);
    expect(await h.cache.rereadLegacyAuthority()).toEqual({ status: "absent" });
    const gate = deferred<void>();
    const send = h.sendMessage.getMockImplementation()!;
    h.sendMessage.mockImplementationOnce(async (message) => {
      const reply = await send(message);
      await gate.promise;
      return reply;
    });
    const pending = h.cache.commitLegacyIntent("globalOn", false);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(h.local.set).toHaveBeenCalledTimes(1));
      const newer = {
        ...saved(true, 20000),
        syncEpoch: 8,
        syncMetadata: {
          version: 100,
          serverUpdatedAt: "2026-10-04T01:00:00Z",
          lastWriteId: null,
        },
      };
      h.emit(newer);
      const accepted = h.cache.currentRecord();
      gate.resolve();
      const outcome = await pending;
      expect(outcome.intentCommitted).toBe(true);
      expect(outcome.settings).toEqual(accepted.settings);
      expect(h.cache.currentRecord()).toEqual(accepted);
      expect(h.cache.legacyReadState()).toEqual({
        status: "ready",
        settings: accepted.settings,
      });
      expect(h.local.set).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      await pending.catch(() => undefined);
      stop();
    }
  });

  it.each(["timestamp", "server-version"] as const)(
    "rejected stale %s notification does not strand a current pure read loading",
    async (kind) => {
      const record = {
        ...saved(),
        syncMetadata:
          kind === "server-version"
            ? {
                version: 8,
                serverUpdatedAt: "2026-10-04T00:00:00Z",
                lastWriteId: null,
              }
            : null,
      };
      const h = browser(record);
      await h.cache.hydrate();
      const stop = h.cache.watch();
      const gate = deferred<Record<string, unknown>>();
      h.local.get.mockImplementationOnce(() => gate.promise);
      const pending = h.cache.rereadLegacyAuthority();
      await vi.waitFor(() =>
        expect(h.cache.legacyReadState().status).toBe("loading"),
      );
      try {
        const stale = {
          ...saved(true, 50),
          syncMetadata: record.syncMetadata
            ? { ...record.syncMetadata, version: 7 }
            : null,
        };
        h.emit(stale);
        gate.resolve({ [KEY]: record });
        expect(await pending).toEqual({ status: "ready" });
        expect(h.cache.current()).toEqual(record.settings);
        expect(h.cache.legacyReadState()).toEqual({
          status: "ready",
          settings: record.settings,
        });
        expect(h.local.set).not.toHaveBeenCalled();
      } finally {
        gate.resolve({ [KEY]: record });
        await pending;
        stop();
      }
    },
  );

  it("a rejected stale notification cannot clear a current unavailable hold", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const stop = h.cache.watch();
    try {
      h.local.get.mockRejectedValueOnce(
        new Error("Current storage unavailable"),
      );
      expect(await h.cache.rereadLegacyAuthority()).toEqual({
        status: "unavailable",
        reason: "read-failed",
      });
      h.emit(saved(true, 50));
      expect(h.cache.legacyReadState()).toEqual({
        status: "unavailable",
        reason: "read-failed",
        settings: saved().settings,
      });
      await expect(h.cache.whenHydrated()).rejects.toThrow("read-failed");
      expect(h.local.set).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("initial saved zero-clock Off choices are accepted before ready is published", async () => {
    const h = browser(saved(false, 0));
    const ready = vi.fn();
    h.cache.subscribeLegacyRead(() => {
      if (h.cache.legacyReadState().status === "ready")
        ready(h.cache.currentRecord());
    });
    await h.cache.hydrate();
    expect(h.cache.current()).toEqual(saved(false, 0).settings);
    expect(h.cache.currentRecord().settings).toEqual(saved(false, 0).settings);
    expect(h.cache.legacyReadState()).toEqual({
      status: "ready",
      settings: saved(false, 0).settings,
    });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0]?.[0]?.settings).toEqual(
      saved(false, 0).settings,
    );
    expect(h.local.set).not.toHaveBeenCalled();
  });

  it("an initial saved zero-clock reply cannot replace a newer accepted command", async () => {
    const h = browser(saved(false, 0));
    const gate = deferred<Record<string, unknown>>();
    h.local.get.mockImplementationOnce(() => gate.promise);
    const initial = h.cache.hydrate();
    await h.cache.setGlobalOn(true);
    gate.resolve({ [KEY]: saved(false, 0) });
    await initial;
    expect(h.cache.current().globalOn).toBe(true);
    expect(h.cache.current().updatedAt).toBe(200);
    expect(h.cache.legacyReadState()).toMatchObject({
      status: "ready",
      settings: { globalOn: true, updatedAt: 200 },
    });
    expect(h.local.set).toHaveBeenCalledTimes(1);
  });
});

describe("reviewed legacy-to-atomic transition replies", () => {
  it.each([false, true])(
    "adopts an admitted legacy command's atomic reply with stale watch=%s",
    async (withWatch) => {
      const h = browser(saved());
      await h.cache.hydrate();
      const stop = withWatch ? h.cache.watch() : () => {};
      const send = h.sendMessage.getMockImplementation()!;
      h.sendMessage.mockImplementationOnce(async (message) => {
        await h.authority.initializeAtomic("never-linked");
        return send(message);
      });
      try {
        const outcome = await h.cache.commitLegacyIntent("globalOn", true);
        const durable = await h.consumer.get();
        expect(durable?.atomic).toBeDefined();
        expect(outcome.intentCommitted).toBe(true);
        expect(outcome.settings.globalOn).toBe(true);
        const projection = {
          settings: durable!.settings,
          syncMetadata: durable!.syncMetadata,
          syncEpoch: durable!.syncEpoch ?? 0,
          atomic: durable!.atomic,
        };
        expect(h.cache.currentRecord()).toEqual(projection);
        expect(h.cache.legacyReadState()).toEqual({
          status: "unavailable",
          settings: null,
          reason: "legacy-command-unavailable",
        });
        if (withWatch) {
          h.emit(saved(false, 50));
          expect(h.cache.currentRecord()).toEqual(projection);
        }
        await expect(
          h.cache.commitLegacyIntent("globalOn", false),
        ).rejects.toThrow("legacy-command-unavailable");
      } finally {
        stop();
      }
    },
  );

  it("a delayed older atomic reply cannot replace a newer accepted sequence", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const stop = h.cache.watch();
    const gate = deferred<void>();
    const send = h.sendMessage.getMockImplementation()!;
    h.sendMessage.mockImplementationOnce(async (message) => {
      await h.authority.initializeAtomic("never-linked");
      const reply = await send(message);
      await gate.promise;
      return reply;
    });
    const pending = h.cache.commitLegacyIntent("globalOn", true);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(h.local.set).toHaveBeenCalledTimes(2));
      const newer = await h.authority.commitIntent({
        path: "globalOn",
        value: false,
        updatedAt: 300,
      });
      h.emit(newer);
      const current = h.cache.currentRecord();
      gate.resolve();
      const outcome = await pending;
      expect(outcome.intentCommitted).toBe(true);
      expect(outcome.settings.globalOn).toBe(false);
      expect(h.cache.currentRecord()).toEqual(current);
      expect(current.atomic?.sequence).toBe(2);
      expect(h.cache.legacyReadState()).toMatchObject({
        status: "unavailable",
        settings: null,
      });
    } finally {
      gate.resolve();
      await pending.catch(() => undefined);
      stop();
    }
  });

  it("an ignored equal-clock conflicting watch never becomes the saved projection", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const stop = h.cache.watch();
    const before = h.cache.current();
    try {
      h.emit(saved(true));
      expect(h.cache.current()).toBe(before);
      expect(h.cache.legacyReadState()).toEqual({
        status: "ready",
        settings: before,
      });
      expect(h.local.set).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

describe("current presence after an absent legacy no-op", () => {
  it.each(["globalOn", "services.youtube"] as const)(
    "adopts a peer's saved Off for matching %s without a local toggle",
    async (path) => {
      const h = browser(undefined, false);
      await h.cache.hydrate();
      const edits = vi.fn();
      h.cache.subscribe(edits);
      // A real writer saves Off after the consumer's absent read, with no watch delivery.
      const peer = new ChromeStorageAdapter({ authority: true });
      expect(
        (await peer.commitIntent({ path, value: false, updatedAt: 100 }))
          .intentCommitted,
      ).toBe(true);
      const durable = h.raw();
      const reads = h.local.get.mock.calls.length;
      const outcome = await h.cache.commitLegacyIntent(path, false);
      expect(outcome.intentCommitted).toBe(false);
      expect(outcome.settings).toEqual((await h.consumer.get())!.settings);
      expect(
        path === "globalOn"
          ? h.cache.current().globalOn
          : h.cache.current().services.youtube,
      ).toBe(false);
      expect(h.cache.legacyReadState()).toEqual({
        status: "ready",
        settings: h.cache.current(),
      });
      // One writer read and one pure presence read; the last get above is our observation.
      expect(h.local.get.mock.calls.length - reads).toBe(3);
      expect(h.local.set).toHaveBeenCalledTimes(1);
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expect(edits.mock.calls.map(([, source]) => source)).toEqual([
        "external",
      ]);
      expect(h.raw()).toEqual(durable);
    },
  );

  it("adopts saved Off with delayed watch delivery after absence of a higher-clock record", async () => {
    const h = browser(saved(true, 9000));
    await h.cache.hydrate();
    const stop = h.cache.watch();
    const initialize = vi.spyOn(h.consumer, "initializeAtomic");
    try {
      h.put(undefined, false);
      expect(await h.cache.rereadLegacyAuthority()).toEqual({
        status: "absent",
      });
      const peer = new ChromeStorageAdapter({ authority: true });
      await peer.commitIntent({ path: "globalOn", value: false, updatedAt: 1 });
      const durable = h.raw();
      const outcome = await h.cache.commitLegacyIntent("globalOn", false);
      expect(outcome.intentCommitted).toBe(false);
      expect(outcome.settings.globalOn).toBe(false);
      expect(outcome.settings.updatedAt).toBe(1);
      expect(h.cache.legacyReadState()).toEqual({
        status: "ready",
        settings: outcome.settings,
      });
      h.emit(durable as StoredSettingsRecord);
      expect(h.cache.legacyReadState()).toEqual({
        status: "ready",
        settings: outcome.settings,
      });
      expect(h.raw()).toEqual(durable);
      expect(h.local.set).toHaveBeenCalledTimes(1);
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it.each(["read-failed", "unreadable"] as const)(
    "holds %s in the followup instead of treating a no-op reply as saved",
    async (reason) => {
      const h = browser(undefined, false);
      await h.cache.hydrate();
      const peer = new ChromeStorageAdapter({ authority: true });
      await peer.commitIntent({
        path: "globalOn",
        value: false,
        updatedAt: 100,
      });
      const send = h.sendMessage.getMockImplementation()!;
      h.sendMessage.mockImplementationOnce(async (message) => {
        const reply = await send(message);
        if (reason === "read-failed")
          h.local.get.mockRejectedValueOnce(new Error("Presence read failed"));
        else h.put({ settings: { globalOn: false } });
        return reply;
      });
      const outcome = await h.cache.commitLegacyIntent("globalOn", false);
      expect(outcome.intentCommitted).toBe(false);
      expect(h.cache.legacyReadState()).toEqual({
        status: "unavailable",
        settings: null,
        reason,
      });
      expect(h.cache.current()).toEqual(DEFAULT_SETTINGS);
      await expect(
        h.cache.commitLegacyIntent("globalOn", false),
      ).rejects.toThrow("legacy-command-unavailable");
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.local.set).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["read", "absence", "watch", "command", "atomic"] as const)(
    "a newer accepted %s supersedes a delayed no-op presence read",
    async (kind) => {
      const h = browser(undefined, false);
      await h.cache.hydrate();
      const peer = new ChromeStorageAdapter({ authority: true });
      await peer.commitIntent({
        path: "globalOn",
        value: false,
        updatedAt: 100,
      });
      const captured = h.raw();
      const stop = h.cache.watch();
      const gate = deferred<Record<string, unknown>>();
      const send = h.sendMessage.getMockImplementation()!;
      h.sendMessage.mockImplementationOnce(async (message) => {
        const reply = await send(message);
        h.local.get.mockImplementationOnce(() => gate.promise);
        return reply;
      });
      const pending = h.cache.commitLegacyIntent("globalOn", false);
      void pending.catch(() => undefined);
      try {
        await vi.waitFor(() =>
          expect(h.cache.legacyReadState().status).toBe("loading"),
        );
        if (kind === "read") {
          h.put(saved(true, 300));
          expect(await h.cache.rereadLegacyAuthority()).toEqual({
            status: "ready",
          });
        } else if (kind === "absence") {
          h.put(undefined, false);
          expect(await h.cache.rereadLegacyAuthority()).toEqual({
            status: "absent",
          });
        } else if (kind === "watch") h.emit(saved(true, 300));
        else if (kind === "command") await h.cache.setGlobalOn(true);
        else {
          const modern = await peer.initializeAtomic("never-linked");
          const newer = await peer.commitIntent({
            path: "globalOn",
            value: true,
            updatedAt: 300,
          });
          expect(newer.atomic!.sequence).toBeGreaterThan(
            modern.atomic!.sequence,
          );
          h.emit(newer);
        }
        const current = h.cache.currentRecord();
        const state = h.cache.legacyReadState();
        gate.resolve({ [KEY]: captured });
        expect(await pending).toEqual({
          intentCommitted: false,
          settings: current.settings,
        });
        expect(h.cache.currentRecord()).toEqual(current);
        expect(h.cache.legacyReadState()).toEqual(state);
        expect(h.sendMessage).toHaveBeenCalledTimes(kind === "command" ? 2 : 1);
      } finally {
        gate.resolve({ [KEY]: captured });
        await pending.catch(() => undefined);
        stop();
      }
    },
  );
});

describe("normalized legacy watch recovery", () => {
  it("an unchanged validated known projection clears failure while retaining opaque saved members", async () => {
    const h = browser(saved());
    await h.cache.hydrate();
    const stop = h.cache.watch();
    const before = h.cache.current();
    const edits = vi.fn();
    h.cache.subscribe(edits);
    try {
      h.local.get.mockRejectedValueOnce(
        new Error("Current storage unavailable"),
      );
      expect(await h.cache.rereadLegacyAuthority()).toEqual({
        status: "unavailable",
        reason: "read-failed",
      });
      h.emit(saved()); // Actual Chrome subscribe strips opaque members from its projection.
      expect(h.cache.legacyReadState()).toEqual({
        status: "ready",
        settings: before,
      });
      expect(h.cache.current()).toBe(before);
      expect(h.cache.current()).toEqual(saved().settings);
      expect(h.raw()).toEqual(saved());
      await expect(h.cache.whenHydrated()).resolves.toBeUndefined();
      expect(h.local.set).not.toHaveBeenCalled();
      expect(edits).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it.each(["choice", "epoch", "version", "timestamp"] as const)(
    "a conflicting or stale known %s watch retains the current failure hold",
    async (kind) => {
      const record = {
        ...saved(),
        syncEpoch: 3,
        syncMetadata: {
          version: 8,
          serverUpdatedAt: "2026-10-04T00:00:00Z",
          lastWriteId: null,
        },
      };
      const h = browser(record);
      await h.cache.hydrate();
      const stop = h.cache.watch();
      const before = h.cache.currentRecord();
      try {
        h.local.get.mockRejectedValueOnce(
          new Error("Current storage unavailable"),
        );
        expect(await h.cache.rereadLegacyAuthority()).toEqual({
          status: "unavailable",
          reason: "read-failed",
        });
        const rejected = {
          ...record,
          syncEpoch: kind === "epoch" ? 2 : 3,
          syncMetadata: {
            ...record.syncMetadata,
            version: kind === "version" ? 7 : 8,
          },
          settings: {
            ...record.settings,
            globalOn: kind === "choice" ? true : false,
            updatedAt: kind === "timestamp" ? 50 : 100,
          },
        };
        h.emit(rejected);
        expect(h.cache.currentRecord()).toEqual(before);
        expect(h.cache.legacyReadState()).toEqual({
          status: "unavailable",
          reason: "read-failed",
          settings: before.settings,
        });
        await expect(h.cache.whenHydrated()).rejects.toThrow("read-failed");
        expect(h.local.set).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    },
  );
});

// Delay only transport delivery: both commands still execute through the same real router/writer.
function queuedLegacyReplies(h: ReturnType<typeof browser>) {
  const send = h.sendMessage.getMockImplementation()!;
  const releases: ReturnType<typeof deferred<void>>[] = [];
  const replies: unknown[] = [];
  h.sendMessage.mockImplementation(async (message) => {
    const index = releases.length;
    if (index >= 2) return send(message);
    const release = deferred<void>();
    releases.push(release);
    const reply = await send(message);
    replies[index] = reply;
    await release.promise;
    return reply;
  });
  return {
    replies,
    release: (index: number) => releases[index]!.resolve(),
    releaseAll: () => releases.forEach((release) => release.resolve()),
  };
}

describe("absence-bound legacy replies across pure presence reads", () => {
  it.each([
    ["globalOn", "pending"],
    ["globalOn", "settled"],
    ["services.youtube", "pending"],
    ["services.youtube", "settled"],
  ] as const)(
    "keeps two matching-default %s no-ops unsaved with presence read %s",
    async (path, timing) => {
      const h = browser(undefined, false);
      await h.cache.hydrate();
      const initialize = vi.spyOn(h.consumer, "initializeAtomic");
      const edits = vi.fn();
      h.cache.subscribe(edits);
      const transport = queuedLegacyReplies(h);
      const pending = new Set<Promise<unknown>>();
      const submit = () => {
        const command = h.cache.commitLegacyIntent(path, true);
        pending.add(command);
        void command.finally(() => pending.delete(command));
        return command;
      };
      const first = submit();
      const second = submit();
      const presence = deferred<Record<string, unknown>>();
      try {
        await vi.waitFor(() => expect(transport.replies).toHaveLength(2));
        expect(transport.replies).toEqual([
          expect.objectContaining({
            record: expect.objectContaining({ intentCommitted: false }),
          }),
          expect.objectContaining({
            record: expect.objectContaining({ intentCommitted: false }),
          }),
        ]);
        h.local.get.mockImplementationOnce(() => presence.promise);
        transport.release(0);
        await vi.waitFor(() =>
          expect(h.cache.legacyReadState().status).toBe("loading"),
        );
        await expect(h.cache.commitLegacyIntent(path, false)).rejects.toThrow(
          "legacy-command-unavailable",
        );
        expect(h.sendMessage).toHaveBeenCalledTimes(2);
        if (timing === "settled") {
          presence.resolve({});
          await first;
          expect(h.cache.legacyReadState()).toEqual({
            status: "absent",
            settings: null,
          });
        }
        transport.release(1);
        const later = await second;
        expect(later.intentCommitted).toBe(false);
        expect(h.cache.legacyReadState().status).not.toBe("ready");
        presence.resolve({});
        expect(
          (await Promise.all([first, second])).map(
            (outcome) => outcome.intentCommitted,
          ),
        ).toEqual([false, false]);
        expect([...pending]).toEqual([]);
        expect(h.cache.legacyReadState()).toEqual({
          status: "absent",
          settings: null,
        });
        expect(h.cache.current()).toEqual(DEFAULT_SETTINGS);
        expect(h.raw()).toBeUndefined();
        expect(h.local.set).not.toHaveBeenCalled();
        expect(initialize).not.toHaveBeenCalled();
        expect(edits).not.toHaveBeenCalled();
      } finally {
        presence.resolve({});
        transport.releaseAll();
        await Promise.allSettled([first, second]);
      }
    },
  );

  it("accepts a lower-clock real Off recreation while an earlier no-op's captured null read is pending", async () => {
    const h = browser(saved(true, 9000));
    await h.cache.hydrate();
    expect(await h.cache.rereadLegacyAuthority()).toEqual({ status: "ready" });
    h.put(undefined, false);
    expect(await h.cache.rereadLegacyAuthority()).toEqual({ status: "absent" });
    const initialize = vi.spyOn(h.consumer, "initializeAtomic");
    const edits = vi.fn();
    h.cache.subscribe(edits);
    const transport = queuedLegacyReplies(h);
    const first = h.cache.commitLegacyIntent("globalOn", true);
    const second = h.cache.commitLegacyIntent("globalOn", false);
    const presence = deferred<Record<string, unknown>>();
    try {
      await vi.waitFor(() => expect(transport.replies).toHaveLength(2));
      expect(transport.replies).toEqual([
        expect.objectContaining({
          record: expect.objectContaining({ intentCommitted: false }),
        }),
        expect.objectContaining({
          record: expect.objectContaining({ intentCommitted: true }),
        }),
      ]);
      const durable = h.raw();
      expect(durable).toMatchObject({
        settings: { globalOn: false, updatedAt: 200 },
      });
      h.local.get.mockImplementationOnce(() => presence.promise);
      transport.release(0);
      await vi.waitFor(() =>
        expect(h.cache.legacyReadState().status).toBe("loading"),
      );
      expect(h.cache.current().globalOn).toBe(true);
      expect(h.cache.current().updatedAt).toBe(9000);
      transport.release(1);
      const recreation = await second;
      expect(recreation.intentCommitted).toBe(true);
      expect(recreation.settings).toMatchObject({
        globalOn: false,
        updatedAt: 200,
      });
      expect(h.cache.legacyReadState()).toEqual({
        status: "ready",
        settings: recreation.settings,
      });
      presence.resolve({});
      const noop = await first;
      expect(noop.intentCommitted).toBe(false);
      expect(noop.settings).toEqual(recreation.settings);
      expect(h.cache.current()).toEqual(recreation.settings);
      expect(h.cache.legacyReadState()).toEqual({
        status: "ready",
        settings: recreation.settings,
      });
      expect(h.raw()).toEqual(durable);
      expect(h.local.set).toHaveBeenCalledTimes(1);
      expect(h.sendMessage).toHaveBeenCalledTimes(2);
      expect(initialize).not.toHaveBeenCalled();
      expect(
        edits.mock.calls.filter(([, source]) => source === "local"),
      ).toHaveLength(1);
      expect(
        edits.mock.calls.every(([settings]) => settings.globalOn === false),
      ).toBe(true);
    } finally {
      presence.resolve({});
      transport.releaseAll();
      await Promise.allSettled([first, second]);
    }
  });

  it.each(
    (
      [
        "read-loading",
        "read-failed",
        "unreadable",
        "watch",
        "command",
        "atomic",
      ] as const
    ).flatMap((kind) =>
      ([false, true] as const).map((committed) => [kind, committed] as const),
    ),
  )(
    "an older absence-bound reply cannot clear newer %s authority with committed=%s",
    async (kind, committed) => {
      const h = browser(undefined, false);
      await h.cache.hydrate();
      const stop = h.cache.watch();
      const transport = queuedLegacyReplies(h);
      const first = h.cache.commitLegacyIntent("globalOn", true);
      const second = h.cache.commitLegacyIntent("globalOn", !committed);
      const presence = deferred<Record<string, unknown>>();
      const newerRead = deferred<Record<string, unknown>>();
      let reread:
        ReturnType<SettingsCache["rereadLegacyAuthority"]> | undefined;
      try {
        await vi.waitFor(() => expect(transport.replies).toHaveLength(2));
        h.local.get.mockImplementationOnce(() => presence.promise);
        transport.release(0);
        await vi.waitFor(() =>
          expect(h.cache.legacyReadState().status).toBe("loading"),
        );
        if (kind === "read-loading") {
          h.local.get.mockImplementationOnce(() => newerRead.promise);
          reread = h.cache.rereadLegacyAuthority();
          await vi.waitFor(() => expect(h.local.get).toHaveBeenCalledTimes(5));
        } else if (kind === "read-failed" || kind === "unreadable") {
          if (kind === "read-failed")
            h.local.get.mockRejectedValueOnce(new Error("Newer read failed"));
          else h.put({ settings: { globalOn: false } });
          expect(await h.cache.rereadLegacyAuthority()).toEqual({
            status: "unavailable",
            reason: kind,
          });
        } else if (kind === "watch") h.emit(saved(false, 300));
        else if (kind === "command") await h.cache.setGlobalOn(false);
        else {
          h.put(saved());
          await h.authority.initializeAtomic("never-linked");
          h.emit(
            await h.authority.commitIntent({
              path: "globalOn",
              value: false,
              updatedAt: 300,
            }),
          );
        }
        const state = h.cache.legacyReadState();
        const current = h.cache.currentRecord();
        transport.release(1);
        expect((await second).intentCommitted).toBe(committed);
        expect(h.cache.legacyReadState()).toEqual(state);
        expect(h.cache.currentRecord()).toEqual(current);
        presence.resolve({});
        expect((await first).intentCommitted).toBe(false);
        expect(h.cache.legacyReadState()).toEqual(state);
        expect(h.cache.currentRecord()).toEqual(current);
        if (kind === "read-failed" || kind === "unreadable")
          await expect(h.cache.whenHydrated()).rejects.toThrow(kind);
      } finally {
        newerRead.resolve({});
        presence.resolve({});
        transport.releaseAll();
        await Promise.allSettled([first, second, ...(reread ? [reread] : [])]);
        stop();
      }
    },
  );
});
