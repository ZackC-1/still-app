import { describe, it, expect, vi } from "vitest";
import type { StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../cache.js";
import { InMemoryStorageAdapter } from "../adapter.js";

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
    // The Apple App Group is coded in Swift and drops fields it does not know, so records coming
    // back across that bridge carry no epoch at all. Reading that as zero would let a browser that
    // has reconciled once refuse every later edit made in the app.
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
