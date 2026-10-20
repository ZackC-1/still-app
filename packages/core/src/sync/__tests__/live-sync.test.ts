import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT, OTHER, canonicalServer, client, settle } from "./support/live-sync-harness.js";
import { SETTINGS_FALLBACK_REFRESH_MS } from "../service.js";

afterEach(() => vi.useRealTimers());

describe("active canonical settings acquisition", () => {
  it.each(["shared-hosted-sandbox", "production"] as const)("%s peers converge without notifications, reopening or local nudges", async profile => {
    vi.useFakeTimers();
    const server = canonicalServer();
    const a = await client(server, profile), b = await client(server, profile);
    try {
      const acceptedAt = Date.now();
      await a.cache.setService("youtube", false); await settle();
      expect(server.snapshot().settings.services.youtube).toBe(false);
      expect(b.cache.current().services.youtube).toBe(true);
      await vi.advanceTimersByTimeAsync(SETTINGS_FALLBACK_REFRESH_MS); await settle();
      expect(b.cache.current().services.youtube).toBe(false);
      expect((await b.storage.get())!.atomic!.anchor!.revision).toBe(server.snapshot().settingsVersion);
      expect(b.events.some(e => e.version === server.snapshot().settingsVersion && e.at - acceptedAt <= SETTINGS_FALLBACK_REFRESH_MS)).toBe(true);
      expect(b.binding.current().settings!.services.youtube).toBe(false);
      await b.cache.setService("youtube", true); await settle();
      await vi.advanceTimersByTimeAsync(SETTINGS_FALLBACK_REFRESH_MS); await settle();
      expect(a.cache.current().services.youtube).toBe(true);
      await Promise.all([a.cache.setService("instagram", false), b.cache.setService("facebook", false)]); await settle();
      await vi.advanceTimersByTimeAsync(SETTINGS_FALLBACK_REFRESH_MS); await settle();
      for (const peer of [a, b]) {
        expect(peer.cache.current().services).toMatchObject({ youtube: true, instagram: false, facebook: false, tiktok: true });
        expect(peer.service.getState()).toMatchObject({ cloudReachable: true, pendingUpload: false });
        if (profile === "shared-hosted-sandbox") expect(peer.channel).toHaveBeenCalledWith(`qa-settings-v1:${ACCOUNT}`, { config: { private: true } });
      }
    } finally { await a.close(); await b.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps offline intent durable, backs off, then uploads and reaches an idle peer", async () => {
    vi.useFakeTimers();
    const server = canonicalServer(), a = await client(server), b = await client(server);
    try {
      a.setOnline(false);
      const lastSuccess = a.service.getState().lastSyncedAt;
      await a.cache.setService("tiktok", false); await settle();
      expect((await a.storage.get())!.atomic!.pending.length).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(60_000); await settle();
      expect(a.service.getState()).toMatchObject({ cloudReachable: false, pendingUpload: true, lastSyncedAt: lastSuccess });
      expect(a.cache.current().services.tiktok).toBe(false);
      const readsBefore = a.reads.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(a.reads.length - readsBefore).toBeLessThanOrEqual(1);
      a.setOnline(true);
      // The sender's backoff retry (at most 30 s) uploads; the idle peer reads on its fallback.
      await vi.advanceTimersByTimeAsync(SETTINGS_FALLBACK_REFRESH_MS); await settle();
      expect(server.snapshot().settings.services.tiktok).toBe(false);
      expect(b.cache.current().services.tiktok).toBe(false);
      expect(a.service.getState()).toMatchObject({ cloudReachable: true, pendingUpload: false });
      expect((await a.storage.get())!.atomic!.pending).toEqual([]);
      expect(server.claims.size).toBe(1);
    } finally { await a.close(); await b.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overlap delayed reads or let a retired completion restart acquisition", async () => {
    vi.useFakeTimers();
    const server = canonicalServer(), a = await client(server), b = await client(server);
    try {
      await a.cache.setService("youtube", false); await settle();
      const held = b.holdRead();
      await vi.advanceTimersByTimeAsync(SETTINGS_FALLBACK_REFRESH_MS); await held.began;
      const reads = b.reads.length;
      await vi.advanceTimersByTimeAsync(4 * SETTINGS_FALLBACK_REFRESH_MS);
      expect(b.reads).toHaveLength(reads);
      await b.service.signOut();
      b.setAccount(OTHER, canonicalServer()); await b.service.onSignedIn(OTHER);
      expect(b.cache.current().services.youtube).toBe(true);
      held.release(); await settle();
      expect(b.cache.current().services.youtube).toBe(true);
      const currentReads = b.reads.length;
      await vi.advanceTimersByTimeAsync(SETTINGS_FALLBACK_REFRESH_MS);
      expect(b.reads).toHaveLength(currentReads + 1);
      await b.service.signOut(); b.setAccount(ACCOUNT); await b.service.onSignedIn(ACCOUNT);
      expect(b.cache.current().services.youtube).toBe(false);
      await a.cache.setService("youtube", true); await settle();
      await vi.advanceTimersByTimeAsync(SETTINGS_FALLBACK_REFRESH_MS);
      expect(b.cache.current().services.youtube).toBe(true);
    } finally { await a.close(); await b.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recreates a worker from persisted settings and keeps acquiring later peer changes", async () => {
    vi.useFakeTimers();
    const server = canonicalServer(), a = await client(server), before = await client(server);
    before.terminate();
    await a.cache.setService("instagram", false); await settle();
    const resumed = await client(server, "shared-hosted-sandbox", before.storage);
    try {
      expect(resumed.cache.current().services.instagram).toBe(false);
      await a.cache.setService("facebook", false); await settle();
      await vi.advanceTimersByTimeAsync(SETTINGS_FALLBACK_REFRESH_MS);
      expect(resumed.cache.current().services.facebook).toBe(false);
      expect(resumed.channel).toHaveBeenCalledWith(`qa-settings-v1:${ACCOUNT}`, { config: { private: true } });
    } finally { await a.close(); await resumed.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("idle signed-in cadence (ISS-0079)", () => {
  it.each(["shared-hosted-sandbox", "production"] as const)("%s: an idle client sends no settings calls between launch and the fallback interval", async profile => {
    vi.useFakeTimers();
    const server = canonicalServer();
    // The Mac report: signed in, idle on the main screen, each hosted call taking about 800 ms.
    const launching = client(server, profile, undefined, { latencyMs: 800 });
    await vi.advanceTimersByTimeAsync(1_000);
    const idle = await launching;
    try {
      const launchReads = idle.reads.length;
      expect(launchReads).toBeGreaterThan(0); // launch still reads the account once
      // Two and a half minutes idle produced 26 posts on the Mac. It must produce none.
      await vi.advanceTimersByTimeAsync(150_000); await settle();
      expect(idle.reads).toHaveLength(launchReads);
      expect(idle.writes).toHaveLength(0);
      // The documented fallback still reads once per interval, never more.
      await vi.advanceTimersByTimeAsync(SETTINGS_FALLBACK_REFRESH_MS); await settle();
      expect(idle.reads).toHaveLength(launchReads + 1);
      expect(idle.writes).toHaveLength(0);
    } finally { await idle.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });
});
