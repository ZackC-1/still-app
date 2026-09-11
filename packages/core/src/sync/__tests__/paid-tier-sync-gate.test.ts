// The sync gate, exercised with the paid tier switched ON.
//
// Settings sync is free while `PAID_TIER_ENABLED` is false, so the cases that prove the gate still
// exists would otherwise go dark exactly where a future reader is most likely to assume the gate
// was deleted. Replacing that one shared export before SyncService is imported keeps them running
// on every build, in the same run as the shipped free behaviour.
//
// The shape mirrors the entitlement suite's reversal test: one `vi.mock` of the constant, then the
// real service over in-memory fakes.
import { describe, it, expect, vi } from "vitest";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import type { StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SyncService } from "../service.js";
import type { AuthPort, BackendPort, SyncedSettingsEnvelope } from "../ports.js";

const USER = "11111111-1111-1111-1111-111111111111";
const SERVER_MS = 1_700_000_000_000;

function settings(over: Partial<StillSettings> = {}): StillSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}

function cloudEnvelope(value: StillSettings): SyncedSettingsEnvelope {
  return {
    settings: value,
    version: 1,
    serverUpdatedAt: new Date(SERVER_MS).toISOString(),
    lastWriteId: null,
  };
}

const auth: AuthPort = {
  signInWithMagicLink: () => Promise.resolve({}),
  signOut: () => Promise.resolve(),
  currentUserId: () => Promise.resolve(null),
};

function backendFor(entitled: boolean, cloud: SyncedSettingsEnvelope | null = null) {
  const writes: StillSettings[] = [];
  const calls: string[] = [];
  let version = cloud?.version ?? 0;
  const backend: BackendPort = {
    reconcileEntitlement: () => {
      calls.push("reconcile");
      return Promise.resolve();
    },
    readEntitlement: () => {
      calls.push("readEntitlement");
      return Promise.resolve(entitled ? "entitled" : "not-entitled");
    },
    readProfile: () => {
      calls.push("readProfile");
      return Promise.resolve(cloud);
    },
    writeProfile: (value) => {
      calls.push("writeProfile");
      writes.push(value);
      return Promise.resolve({
        settings: value,
        version: ++version,
        serverUpdatedAt: new Date(SERVER_MS + version).toISOString(),
        lastWriteId: null,
      });
    },
    subscribeToProfile: () => () => {},
    deleteAccount: () => Promise.resolve(),
  };
  return { backend, writes, calls };
}

function cache(initial?: StillSettings) {
  let t = 1000;
  return new SettingsCache(new InMemoryStorageAdapter(initial ?? null), { now: () => ++t });
}

describe("SyncService: the sync gate with the paid tier on", () => {
  it("the switch this file flips is really on", () => {
    expect(PAID_TIER_ENABLED).toBe(true);
  });

  it("an account without the entitlement does not sync", async () => {
    const local = cache();
    const { backend, writes } = backendFor(false);
    const service = new SyncService(local, auth, backend);
    await service.onSignedIn(USER);
    expect(service.getState().syncing).toBe(false);
    await local.setService("tiktok", false);
    expect(writes.length).toBe(0);
  });

  it("an account with the entitlement syncs", async () => {
    const local = cache();
    const { backend, writes } = backendFor(true);
    const service = new SyncService(local, auth, backend);
    await service.onSignedIn(USER);
    expect(service.getState().syncing).toBe(true);
    await local.setService("tiktok", false);
    expect(writes.at(-1)!.services.tiktok).toBe(false);
  });

  it("sync waits for the entitlement answer, and a failed check aborts it", async () => {
    const { backend, calls } = backendFor(true);
    backend.reconcileEntitlement = () => {
      calls.push("reconcile");
      return Promise.reject(new Error("offline"));
    };
    const service = new SyncService(cache(), auth, backend);
    await service.onSignedIn(USER);
    expect(calls).not.toContain("readProfile"); // the mirror never started
    expect(service.getState()).toMatchObject({ syncing: false, cloudReachable: false });
  });

  it("losing the entitlement stops sync", async () => {
    const local = cache();
    const { backend, writes } = backendFor(true);
    const service = new SyncService(local, auth, backend);
    await service.onSignedIn(USER);
    await service.onEntitlementConfirmed(USER, false);
    expect(service.getState()).toMatchObject({ entitled: false, syncing: false, confirmed: true });
    writes.length = 0;
    await local.setService("tiktok", false);
    expect(writes.length).toBe(0);
  });

  it("a cached entitlement of false resumes without write-through", async () => {
    const local = cache();
    const { backend, writes } = backendFor(true);
    const service = new SyncService(local, auth, backend);
    service.resume(USER, false);
    expect(service.getState().syncing).toBe(false);
    await local.setService("tiktok", false);
    expect(writes.length).toBe(0);
  });

  it("the first-sign-in merge rule is unchanged by the tier: the newer side still wins", async () => {
    const cloud = cloudEnvelope(settings({ globalOn: false, updatedAt: 7 }));
    const local = cache(settings({ globalOn: true, updatedAt: SERVER_MS + 1_000 }));
    await local.hydrate();
    const { backend, writes } = backendFor(true, cloud);
    const service = new SyncService(
      local,
      auth,
      backend,
      undefined,
      undefined,
      () => SERVER_MS + 60_000,
    );
    await service.onSignedIn(USER);
    expect(local.current().globalOn).toBe(true);
    expect(writes.length).toBe(1);
  });
});
