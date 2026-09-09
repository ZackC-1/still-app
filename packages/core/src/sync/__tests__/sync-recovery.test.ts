import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type StillSettings } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SyncService } from "../service.js";
import type {
  AuthPort,
  BackendPort,
  SyncedSettingsEnvelope,
} from "../ports.js";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const START = 1_800_000_000_000;

function envelope(
  settings: StillSettings,
  version = 1,
): SyncedSettingsEnvelope {
  return {
    settings,
    version,
    serverUpdatedAt: new Date(START + version).toISOString(),
    lastWriteId: `write-${version}`,
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

async function harness() {
  let cloud = envelope({
    ...DEFAULT_SETTINGS,
    services: { ...DEFAULT_SETTINGS.services, facebook: false },
    updatedAt: START - 1,
  });
  const cache = new SettingsCache(new InMemoryStorageAdapter());
  await cache.hydrate();
  const auth: AuthPort = {
    signInWithMagicLink: vi.fn(async () => ({})),
    signOut: vi.fn(async () => undefined),
    currentUserId: async () => USER,
  };
  let status: Parameters<BackendPort["subscribeToProfile"]>[2];
  const backend = {
    reconcileEntitlement: vi.fn(async () => undefined),
    readEntitlement: vi.fn(async () => "not-entitled" as const),
    readProfile: vi.fn(async () => cloud as SyncedSettingsEnvelope | null),
    writeProfile: vi.fn(async (settings: StillSettings) => {
      cloud = envelope(settings, cloud.version + 1);
      return cloud;
    }),
    subscribeToProfile: vi.fn(
      (
        _user: string,
        _listener: (value: SyncedSettingsEnvelope) => void,
        onStatus?: typeof status,
      ) => {
        status = onStatus;
        return () => undefined;
      },
    ),
    deleteAccount: vi.fn(async () => undefined),
  } satisfies BackendPort;
  let identity: string | null = null;
  const sync = new SyncService(cache, auth, backend, undefined, {
    get: async () => identity,
    set: async (value) => {
      identity = value;
    },
  });
  await sync.onSignedIn(USER);
  return {
    sync,
    cache,
    backend,
    auth,
    status: (value: "subscribed" | "disconnected" | "error") => status?.(value),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("settings upload recovery", () => {
  it("uploads a failed local edit without another edit or realtime reconnect", async () => {
    const { sync, cache, backend, status } = await harness();
    status("subscribed");
    backend.writeProfile.mockRejectedValueOnce(new Error("offline"));
    await cache.setService("facebook", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.getState().cloudReachable).toBe(false);
    expect((await backend.readProfile())?.settings.services.facebook).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(backend.writeProfile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await backend.readProfile())?.settings.services.facebook).toBe(
      true,
    );
    expect(sync.getState().cloudReachable).toBe(true);
  });

  it("adopts a newer account row before retrying and never republishes a rejected local edit", async () => {
    const { sync, cache, backend } = await harness();
    backend.writeProfile.mockRejectedValueOnce(new Error("offline"));
    await cache.setService("facebook", true);
    await vi.advanceTimersByTimeAsync(0);
    const account = envelope(
      { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: START + 100 },
      2,
    );
    backend.readProfile.mockResolvedValue(account);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cache.current()).toEqual(account.settings);
    expect(backend.writeProfile).toHaveBeenCalledTimes(1);
    expect(sync.getState().cloudReachable).toBe(true);
  });

  it("coalesces manual, timer and reconnect recovery while retaining the newest edit", async () => {
    const { sync, cache, backend, status } = await harness();
    backend.writeProfile.mockRejectedValueOnce(new Error("offline"));
    await cache.setService("facebook", true);
    await vi.advanceTimersByTimeAsync(0);
    const cloud = await backend.readProfile();
    const read = deferred<SyncedSettingsEnvelope | null>();
    backend.readProfile.mockReturnValueOnce(read.promise);
    const before = backend.readProfile.mock.calls.length;
    const retry = sync.retryNow();
    void sync.retryNow();
    status("disconnected");
    status("subscribed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backend.readProfile.mock.calls.length - before).toBe(1);
    await cache.setService("instagram", false);
    expect(backend.writeProfile).toHaveBeenCalledTimes(1);
    read.resolve(cloud);
    await retry;
    expect((await backend.readProfile())?.settings.services).toMatchObject({
      facebook: true,
      instagram: false,
    });
    expect(backend.reconcileEntitlement).toHaveBeenCalledTimes(1);
  });

  it("reports the last settings exchange separately from an unsent newer edit", async () => {
    const { sync, cache, backend } = await harness();
    expect(sync.getState()).toMatchObject({
      lastSyncedAt: START,
      pendingUpload: false,
    });
    vi.setSystemTime(START + 100);
    const first = deferred<SyncedSettingsEnvelope>();
    backend.writeProfile.mockReturnValueOnce(first.promise);
    const edit = await cache.setService("facebook", true);
    expect(sync.getState()).toMatchObject({
      lastSyncedAt: START,
      pendingUpload: true,
    });
    const latest = deferred<SyncedSettingsEnvelope>();
    backend.writeProfile.mockReturnValueOnce(latest.promise);
    await cache.setService("instagram", false);
    first.resolve(envelope(edit, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.getState()).toMatchObject({
      lastSyncedAt: START + 100,
      pendingUpload: true,
    });
    latest.reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.getState()).toMatchObject({
      lastSyncedAt: START + 100,
      pendingUpload: true,
      cloudReachable: false,
    });
    await sync.signOut();
    expect(sync.getState()).toMatchObject({
      lastSyncedAt: null,
      pendingUpload: false,
    });
  });

  it("keeps the newest local settings when an older write succeeds and the queued write fails", async () => {
    const { sync, cache, backend } = await harness();
    const first = deferred<SyncedSettingsEnvelope>();
    backend.writeProfile
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error("offline"));
    const edit = await cache.setService("facebook", true);
    await cache.setService("instagram", false);
    first.resolve(envelope(edit, 2));
    backend.readProfile.mockResolvedValueOnce(envelope(edit, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.current().services.instagram).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await backend.readProfile())?.settings.services).toMatchObject({
      facebook: true,
      instagram: false,
    });
    expect(sync.getState()).toMatchObject({
      pendingUpload: false,
      cloudReachable: true,
    });
  });

  it("backs off repeated failures to a 30 second cap and resets after recovery", async () => {
    const { sync, cache, backend } = await harness();
    const upload = backend.writeProfile.getMockImplementation()!;
    backend.writeProfile.mockRejectedValue(new Error("offline"));
    await cache.setService("facebook", true);
    await vi.advanceTimersByTimeAsync(0);
    let attempts = 1;
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(backend.writeProfile).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(backend.writeProfile).toHaveBeenCalledTimes(++attempts);
      expect(sync.getState()).toMatchObject({
        pendingUpload: true,
        cloudReachable: false,
        lastSyncedAt: START,
      });
    }
    backend.writeProfile.mockImplementation(upload);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sync.getState()).toMatchObject({
      pendingUpload: false,
      cloudReachable: true,
    });
    backend.writeProfile.mockRejectedValueOnce(new Error("offline again"));
    await cache.setService("facebook", false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await backend.readProfile())?.settings.services.facebook).toBe(
      false,
    );
  });

  it("cancels delayed retries and manual recovery as soon as sign-out begins", async () => {
    const { sync, cache, backend, auth } = await harness();
    backend.writeProfile.mockRejectedValueOnce(new Error("offline"));
    await cache.setService("facebook", true);
    await vi.advanceTimersByTimeAsync(0);
    const leaving = deferred<void>();
    auth.signOut = () => leaving.promise;
    const signOut = sync.signOut();
    const reads = backend.readProfile.mock.calls.length;
    await sync.retryNow();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(backend.readProfile).toHaveBeenCalledTimes(reads);
    expect(backend.writeProfile).toHaveBeenCalledTimes(1);
    expect(sync.getState()).toMatchObject({
      lastSyncedAt: null,
      pendingUpload: false,
    });
    leaving.resolve();
    await signOut;
    await sync.retryNow();
    expect(sync.getState().userId).toBeNull();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores an old retry read that %s after an account switch",
    async (settlement) => {
      const { sync, cache, backend } = await harness();
      const old = deferred<SyncedSettingsEnvelope | null>();
      backend.readProfile.mockReturnValueOnce(old.promise);
      const retry = sync.retryNow();
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(START + 50);
      const account = envelope(
        { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: START + 40 },
        3,
      );
      backend.readProfile.mockResolvedValueOnce(account);
      await sync.onSignedIn(OTHER);
      const state = sync.getState();
      if (settlement === "resolve") old.resolve(envelope(DEFAULT_SETTINGS, 90));
      else old.reject(new Error("old account offline"));
      await retry;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(cache.current()).toEqual(account.settings);
      expect(sync.getState()).toEqual(state);
      expect(backend.writeProfile).not.toHaveBeenCalled();
    },
  );

  it("joins an upload already in progress instead of starting a parallel recovery read", async () => {
    const { sync, cache, backend } = await harness();
    const write = deferred<SyncedSettingsEnvelope>();
    backend.writeProfile.mockReturnValueOnce(write.promise);
    const edit = await cache.setService("facebook", true);
    const retry = sync.retryNow();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.readProfile).toHaveBeenCalledTimes(1);
    write.resolve(envelope(edit, 2));
    await retry;
    expect(sync.getState()).toMatchObject({
      pendingUpload: false,
      lastSyncedAt: START + 30_000,
    });
  });

  it("retains an edit made during a retry upload even when its following upload also fails", async () => {
    const { sync, cache, backend } = await harness();
    backend.writeProfile.mockRejectedValueOnce(new Error("offline"));
    await cache.setService("facebook", true);
    await vi.advanceTimersByTimeAsync(0);
    const write = deferred<SyncedSettingsEnvelope>();
    backend.writeProfile
      .mockReturnValueOnce(write.promise)
      .mockRejectedValueOnce(new Error("offline again"));
    const retry = sync.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    const sent = backend.writeProfile.mock.calls.at(-1)![0];
    await cache.setService("instagram", false);
    write.resolve(envelope(sent, 2));
    backend.readProfile.mockResolvedValueOnce(envelope(sent, 2));
    await retry;
    expect(cache.current().services.instagram).toBe(false);
    expect(sync.getState()).toMatchObject({
      pendingUpload: true,
      cloudReachable: false,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await backend.readProfile())?.settings.services).toMatchObject({
      facebook: true,
      instagram: false,
    });
    expect(sync.getState()).toMatchObject({
      pendingUpload: false,
      cloudReachable: true,
    });
  });

  it("recovers a failed startup read and keeps entitlement confirmation from changing settings health", async () => {
    const { sync, backend } = await harness();
    await sync.signOut();
    backend.readProfile.mockRejectedValueOnce(new Error("offline at launch"));
    await sync.onSignedIn(USER);
    expect(sync.getState()).toMatchObject({
      cloudReachable: false,
      lastSyncedAt: null,
      pendingUpload: false,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync.getState()).toMatchObject({
      cloudReachable: true,
      lastSyncedAt: START + 1_000,
      pendingUpload: false,
    });
    vi.setSystemTime(START + 2_000);
    await sync.onEntitlementConfirmed(USER, false);
    expect(sync.getState().lastSyncedAt).toBe(START + 1_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(backend.readProfile).toHaveBeenCalledTimes(3);
  });
});
