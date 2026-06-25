import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import type { StillSettings } from "@still/shared-types";
import { createAppGroupReconciler, type LocalSettingsStore } from "../app-group-reconcile.js";

function settings(updatedAt: number): StillSettings {
  return { ...DEFAULT_SETTINGS, updatedAt };
}

/** A local store whose set() does NOT notify synchronously — the test fires emit() to model chrome's
 * async storage.onChanged delivery, exercising the value-based echo guard against real timing. */
function fakeLocal(initial: StillSettings | null) {
  let value = initial;
  const listeners = new Set<(s: StillSettings) => void>();
  const store: LocalSettingsStore = {
    get: () => Promise.resolve(value),
    set: (s) => {
      value = s;
      return Promise.resolve();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    store,
    emit: (s: StillSettings) => listeners.forEach((l) => l(s)),
    get value() {
      return value;
    },
  };
}

describe("createAppGroupReconciler", () => {
  it("app newer → applies down to local; the resulting echo is NOT pushed back", async () => {
    const local = fakeLocal(settings(100));
    const pushToApp = vi.fn((_settings: StillSettings) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(settings(200)), pushToApp, local: local.store });
    await r.reconcile();
    expect(local.value?.updatedAt).toBe(200); // applied
    local.emit(local.value!); // the async onChanged echo of our own write
    expect(pushToApp).not.toHaveBeenCalled(); // suppressed by value
    r.stop();
  });

  it("local newer → pushes up to app; local unchanged", async () => {
    const local = fakeLocal(settings(300));
    const pushToApp = vi.fn((_settings: StillSettings) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(settings(100)), pushToApp, local: local.store });
    await r.reconcile();
    expect(pushToApp).toHaveBeenCalledTimes(1);
    expect(pushToApp.mock.calls[0]![0].updatedAt).toBe(300);
    expect(local.value?.updatedAt).toBe(300);
    r.stop();
  });

  it("guard is by value: the applied value's echo is suppressed, a later real edit IS pushed", async () => {
    const local = fakeLocal(settings(100));
    const pushToApp = vi.fn((_settings: StillSettings) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(settings(200)), pushToApp, local: local.store });
    await r.reconcile(); // applies 200
    local.emit(settings(200)); // echo → suppressed
    expect(pushToApp).not.toHaveBeenCalled();
    local.emit(settings(201)); // a real, newer local edit → pushed
    expect(pushToApp).toHaveBeenCalledTimes(1);
    expect(pushToApp.mock.calls[0]![0].updatedAt).toBe(201);
    r.stop();
  });

  it("overlapping reconciles do not push the just-applied app value back", async () => {
    const local = fakeLocal(settings(100));
    const pushToApp = vi.fn((_settings: StillSettings) => Promise.resolve());
    let appAt = 200;
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(settings(appAt)), pushToApp, local: local.store });
    await Promise.all([
      r.reconcile(),
      (async () => {
        appAt = 300;
        await r.reconcile();
      })(),
    ]);
    local.emit(local.value!); // echo of the latest applied value
    const pushedApplied = pushToApp.mock.calls.some((c) => c[0].updatedAt === local.value!.updatedAt);
    expect(pushedApplied).toBe(false);
    r.stop();
  });

  it("equal updatedAt → no set, no push (idempotent)", async () => {
    const local = fakeLocal(settings(100));
    const pushToApp = vi.fn((_settings: StillSettings) => Promise.resolve());
    const setSpy = vi.spyOn(local.store, "set");
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(settings(100)), pushToApp, local: local.store });
    await r.reconcile();
    expect(pushToApp).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
    r.stop();
  });

  it("app null + local present → seeds the app (push), no local set", async () => {
    const local = fakeLocal(settings(100));
    const pushToApp = vi.fn((_settings: StillSettings) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(null), pushToApp, local: local.store });
    await r.reconcile();
    expect(pushToApp).toHaveBeenCalledTimes(1);
    r.stop();
  });
});
