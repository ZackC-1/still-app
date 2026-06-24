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
    expect((await adapter.get())!.services.youtube).toBe(false);
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

  it("adds and removes a per-site pause keyed by eTLD+1", async () => {
    const { cache } = makeCache();
    await cache.pauseHost("m.youtube.com");
    expect(cache.current().pauses).toEqual(["youtube.com"]);
    expect(cache.isPausedHost("www.youtube.com")).toBe(true);
    await cache.resumeHost("www.youtube.com");
    expect(cache.current().pauses).toEqual([]);
  });

  it("does not duplicate a pause for an already-paused host", async () => {
    const { cache } = makeCache();
    await cache.pauseHost("youtube.com");
    await cache.pauseHost("m.youtube.com");
    expect(cache.current().pauses).toEqual(["youtube.com"]);
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
});
