import { describe, it, expect, vi } from "vitest";
import type { StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../cache.js";
import { AtomicSettingsWriter, SettingsStorageRecovery } from "../atomic-settings.js";
import { InMemoryStorageAdapter } from "../adapter.js";
import type { StoredSettingsRecord } from "../adapter.js";

describe("bounded explicit authority recovery", () => {
  async function fixture() {
    const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
    const writer = new AtomicSettingsWriter(storage);
    const durable = await writer.initialize("never-linked");
    const get = vi.fn(storage.get.bind(storage));
    const initialize = vi.fn(writer.initialize.bind(writer));
    const cache = new SettingsCache({ get, set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage),
      initializeAtomic: initialize, commitIntent: writer.commit.bind(writer), enterScope: writer.enterScope.bind(writer) },
      { atomicOwnership: "never-linked", now: () => 100 });
    await cache.hydrate();
    const writes = vi.spyOn(storage, "set");
    const legacy = vi.fn(); cache.subscribe(legacy);
    const authority = vi.fn(); cache.subscribeAuthority(authority);
    get.mockClear(); initialize.mockClear();
    return { storage, writer, durable, cache, get, initialize, writes, legacy, authority };
  }

  it.each(["read-failure", "null", "corrupt", "future", "legacy", "paused", "unknown"] as const)(
    "keeps %s reads held without defaults, initialization or writes", async kind => {
      const f = await fixture();
      const failure = vi.spyOn(f.storage, "set").mockRejectedValueOnce(new SettingsStorageRecovery("authority-unavailable"));
      await expect(f.cache.commitAtomicIntent("globalOn", false)).rejects.toThrow("authority-unavailable");
      failure.mockClear(); f.authority.mockClear();
      if (kind === "read-failure") f.get.mockRejectedValueOnce(new Error("read unavailable"));
      else f.get.mockResolvedValueOnce(kind === "null" ? null : kind === "corrupt"
        ? { ...f.durable, atomic: { ...f.durable.atomic!, sequence: -1 } }
        : kind === "future" ? { ...f.durable, settings: { ...f.durable.settings, schemaVersion: 3 } as StillSettings }
        : kind === "legacy" ? { settings: DEFAULT_SETTINGS, syncMetadata: null }
        : { ...f.durable, atomic: { ...f.durable.atomic!,
          paused: kind === "paused" ? "ordering-hold" : null,
          ownership: kind === "unknown" ? "unknown" : "never-linked", anchor: kind === "unknown" ? { version: 1 as const, lineage: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", revision: 0, mac: "A".repeat(43) } : f.durable.atomic!.anchor } });
      expect((await f.cache.rereadAuthority()).status).toBe("unavailable");
      expect(f.cache.current().globalOn).toBe(true);
      expect(f.cache.currentRecord().atomic!.paused).not.toBeNull();
      await expect(f.cache.commitAtomicIntent("globalOn", false)).rejects.toThrow("atomic-command-unavailable");
      expect(f.get).toHaveBeenCalledOnce(); expect(f.initialize).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
      expect(await f.storage.get()).toEqual(f.durable);
    });

  it.each(["commit", "account", "session", "ownership", "failure"] as const)(
    "fences a captured read after newer accepted %s", async kind => {
      const f = await fixture(); const stop = f.cache.watch();
      if (kind === "session") await f.cache.enterAtomicScope("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002");
      const captured = structuredClone(f.cache.currentRecord());
      let release!: (record: StoredSettingsRecord) => void;
      f.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const pending = f.cache.rereadAuthority();
      try {
        if (kind === "commit") await f.cache.commitAtomicIntent("globalOn", false);
        else if (kind === "account") await f.cache.enterAtomicScope("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002");
        else if (kind === "session") await f.cache.enterAtomicScope("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000008");
        else if (kind === "ownership") f.storage.emitExternal({ ...f.durable, atomic: { ...f.durable.atomic!, paused: "ownership-hold" } });
        else {
          f.writes.mockRejectedValueOnce(new SettingsStorageRecovery("authority-unavailable"));
          await expect(f.cache.commitAtomicIntent("globalOn", false)).rejects.toThrow("authority-unavailable");
        }
        const current = structuredClone(f.cache.currentRecord());
        f.legacy.mockClear(); f.authority.mockClear();
        release(captured);
        expect(await pending).toEqual({ status: "superseded" });
        expect(f.cache.currentRecord()).toEqual(current);
        expect(f.legacy).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled();
      } finally { release(captured); stop(); }
    });

  it.each(["sequence", "generation", "session", "account", "ownership"] as const)(
    "refuses a stale or mismatched durable %s without replacing accepted authority", async kind => {
      const f = await fixture();
      await f.cache.commitAtomicIntent("globalOn", false);
      if (kind === "session") await f.cache.enterAtomicScope("00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000008");
      const current = structuredClone(f.cache.currentRecord());
      const atomic = current.atomic!;
      // Give the accepted cache a real newer scope before presenting a retired generation.
      if (kind === "generation") await f.cache.enterAtomicScope("00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004");
      const before = structuredClone(f.cache.currentRecord());
      f.get.mockResolvedValueOnce({ ...current, atomic: { ...atomic,
        sequence: kind === "sequence" ? 0 : atomic.sequence,
        scope: kind === "session" ? { ...atomic.scope, sessionId: "00000000-0000-4000-8000-000000000006" }
          : kind === "account" ? { accountId: "00000000-0000-4000-8000-000000000007", generation: atomic.scope.generation } : atomic.scope,
        ownership: kind === "ownership" ? "previous-account" : atomic.ownership,
      } });
      f.writes.mockClear(); f.legacy.mockClear(); f.authority.mockClear();
      expect((await f.cache.rereadAuthority()).status).toBe("superseded");
      expect(f.cache.currentRecord()).toEqual(before);
      expect(f.writes).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled();
    });

  it("coalesces concurrent recovery reads and permits another bounded explicit lifecycle", async () => {
    const f = await fixture();
    let release!: (record: StoredSettingsRecord) => void;
    f.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.cache.rereadAuthority(); const second = f.cache.rereadAuthority();
    expect(f.get).toHaveBeenCalledOnce();
    release(f.durable);
    expect(await first).toEqual({ status: "ready" }); expect(await second).toEqual({ status: "ready" });
    expect(await f.cache.rereadAuthority()).toEqual({ status: "ready" });
    expect(f.get).toHaveBeenCalledTimes(2); expect(f.initialize).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled();
  });

  it("keeps a newer committed command ready when an older reread rejects", async () => {
    const f = await fixture();
    let reject!: (error: Error) => void;
    f.get.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = f.cache.rereadAuthority();
    await f.cache.commitAtomicIntent("globalOn", false);
    const current = structuredClone(f.cache.currentRecord());
    f.authority.mockClear(); f.legacy.mockClear();
    reject(new SettingsStorageRecovery("native-authority-unavailable", f.durable));
    expect(await pending).toEqual({ status: "superseded" });
    expect(f.cache.currentRecord()).toEqual(current);
    expect(f.cache.currentRecord().atomic!.paused).toBeNull();
    expect(f.authority).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
  });

  it("accepts a current newer account generation without a notification or local write", async () => {
    const f = await fixture();
    const changed = await f.writer.enterScope("00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012");
    expect(f.cache.currentRecord().atomic!.scope.generation).toBe(0);
    f.writes.mockClear();
    expect(await f.cache.rereadAuthority()).toEqual({ status: "ready" });
    expect(f.cache.currentRecord()).toEqual(changed);
    expect(f.get).toHaveBeenCalledOnce(); expect(f.initialize).not.toHaveBeenCalled();
    expect(f.authority).toHaveBeenCalledOnce(); expect(f.legacy).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled();
  });

});
describe("retained unknown local-only cache recovery", () => {
  it("recovers a refused write by one pure read and saves only a later deliberate edit", async () => {
    const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 21 });
    const uuid = vi.fn(() => "dddddddd-dddd-dddd-dddd-dddddddddddd");
    const writer = new AtomicSettingsWriter(storage, uuid); await writer.initialize("unknown");
    const get = vi.fn(storage.get.bind(storage)); const set = vi.spyOn(storage, "set");
    const commit = vi.fn(writer.commit.bind(writer));
    const cache = new SettingsCache({ get, set, subscribe: storage.subscribe.bind(storage), commitIntent: commit }, { now: () => 500 });
    await cache.hydrate(); const before = await storage.get(); get.mockClear(); set.mockClear();
    set.mockRejectedValueOnce(new SettingsStorageRecovery("authority-unavailable"));
    await expect(cache.commitAtomicIntent("globalOn", true)).rejects.toThrow("authority-unavailable");
    expect(cache.current().globalOn).toBe(false); expect(await storage.get()).toEqual(before);
    commit.mockClear(); set.mockClear();
    expect(await cache.rereadAuthority()).toEqual({ status: "ready" });
    expect(get).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    expect(await cache.commitAtomicIntent("globalOn", true)).toMatchObject({ intentCommitted: true });
    expect(cache.currentRecord().atomic).toMatchObject({ ownership: "unknown", pending: [], paused: null });
    expect(uuid).not.toHaveBeenCalled();
  });
});
