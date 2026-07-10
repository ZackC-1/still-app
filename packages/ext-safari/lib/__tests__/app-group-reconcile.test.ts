import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import type { StillSettings } from "@still/shared-types";
import type { StoredSettingsRecord } from "@still/core/storage";
import { createAppGroupReconciler, type LocalSettingsStore } from "../app-group-reconcile.js";

function settings(updatedAt: number): StillSettings {
  return { ...DEFAULT_SETTINGS, updatedAt };
}

function record(updatedAt: number, version: number | null = null): StoredSettingsRecord {
  return {
    settings: settings(updatedAt),
    syncMetadata: version === null
      ? null
      : {
          version,
          serverUpdatedAt: new Date(1_800_000_000_000 + version).toISOString(),
          lastWriteId: null,
        },
  };
}

function recordWithMetadata(updatedAt: number, version: number, serverUpdatedAt: string): StoredSettingsRecord {
  return {
    settings: settings(updatedAt),
    syncMetadata: {
      version,
      serverUpdatedAt,
      lastWriteId: null,
    },
  };
}

/** A local store whose set() does NOT notify synchronously — the test fires emit() to model chrome's
 * async storage.onChanged delivery, exercising the value-based echo guard against real timing. */
function fakeLocal(initial: StoredSettingsRecord | null) {
  let value = initial;
  const listeners = new Set<(s: StoredSettingsRecord) => void>();
  const store: LocalSettingsStore = {
    get: () => Promise.resolve(value),
    set: (r) => {
      value = r;
      return Promise.resolve();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    store,
    emit: (s: StoredSettingsRecord) => listeners.forEach((l) => l(s)),
    get value() {
      return value;
    },
  };
}

describe("createAppGroupReconciler", () => {
  it("app newer → applies down to local; the resulting echo is NOT pushed back", async () => {
    const local = fakeLocal(record(100));
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(record(200)), pushToApp, local: local.store });
    await r.reconcile();
    expect(local.value?.settings.updatedAt).toBe(200); // applied
    local.emit(local.value!); // the async onChanged echo of our own write
    expect(pushToApp).not.toHaveBeenCalled(); // suppressed by value
    r.stop();
  });

  it("local newer → pushes up to app; local unchanged", async () => {
    const local = fakeLocal(record(300));
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(record(100)), pushToApp, local: local.store });
    await r.reconcile();
    expect(pushToApp).toHaveBeenCalledTimes(1);
    expect(pushToApp.mock.calls[0]![0].settings.updatedAt).toBe(300);
    expect(local.value?.settings.updatedAt).toBe(300);
    r.stop();
  });

  it("guard is by value: the applied value's echo is suppressed, a later real edit IS pushed", async () => {
    const local = fakeLocal(record(100));
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(record(200)), pushToApp, local: local.store });
    await r.reconcile(); // applies 200
    local.emit(record(200)); // echo → suppressed
    expect(pushToApp).not.toHaveBeenCalled();
    local.emit(record(201)); // a real, newer local edit → pushed
    expect(pushToApp).toHaveBeenCalledTimes(1);
    expect(pushToApp.mock.calls[0]![0].settings.updatedAt).toBe(201);
    r.stop();
  });

  it("overlapping reconciles do not push the just-applied app value back", async () => {
    const local = fakeLocal(record(100));
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    let appAt = 200;
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(record(appAt)), pushToApp, local: local.store });
    await Promise.all([
      r.reconcile(),
      (async () => {
        appAt = 300;
        await r.reconcile();
      })(),
    ]);
    local.emit(local.value!); // echo of the latest applied value
    const pushedApplied = pushToApp.mock.calls.some((c) => c[0].settings.updatedAt === local.value!.settings.updatedAt);
    expect(pushedApplied).toBe(false);
    r.stop();
  });

  it("equal updatedAt → no set, no push (idempotent)", async () => {
    const local = fakeLocal(record(100));
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const setSpy = vi.spyOn(local.store, "set");
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(record(100)), pushToApp, local: local.store });
    await r.reconcile();
    expect(pushToApp).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
    r.stop();
  });

  it("app null + local present → seeds the app (push), no local set", async () => {
    const local = fakeLocal(record(100));
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(null), pushToApp, local: local.store });
    await r.reconcile();
    expect(pushToApp).toHaveBeenCalledTimes(1);
    r.stop();
  });

  it("metadata version beats old updatedAt ordering", async () => {
    const local = fakeLocal(record(9_999, 3));
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(record(10_000, 2)), pushToApp, local: local.store });
    await r.reconcile();
    expect(local.value?.syncMetadata?.version).toBe(3);
    expect(pushToApp).toHaveBeenCalledTimes(1);
    expect(pushToApp.mock.calls[0]![0].syncMetadata?.version).toBe(3);
    r.stop();
  });

  it("same synced base + newer app updatedAt → applies down to local", async () => {
    const baseServerTime = "2026-07-10T19:10:57.532Z";
    const local = fakeLocal(recordWithMetadata(100, 22, baseServerTime));
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({
      pullFromApp: () => Promise.resolve(recordWithMetadata(200, 22, baseServerTime)),
      pushToApp,
      local: local.store,
    });
    await r.reconcile();
    expect(local.value?.settings.updatedAt).toBe(200);
    expect(pushToApp).not.toHaveBeenCalled();
    r.stop();
  });

  it("same synced base + newer local updatedAt → pushes up to app", async () => {
    const baseServerTime = "2026-07-10T19:10:57.532Z";
    const local = fakeLocal(recordWithMetadata(300, 22, baseServerTime));
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({
      pullFromApp: () => Promise.resolve(recordWithMetadata(200, 22, baseServerTime)),
      pushToApp,
      local: local.store,
    });
    await r.reconcile();
    expect(pushToApp).toHaveBeenCalledTimes(1);
    expect(pushToApp.mock.calls[0]![0].settings.updatedAt).toBe(300);
    expect(local.value?.settings.updatedAt).toBe(300);
    r.stop();
  });
});
