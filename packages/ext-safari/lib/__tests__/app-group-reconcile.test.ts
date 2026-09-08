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

/** One person's synced settings as they sit in a store: `writeId` names whose they are, `repoints`
 * is how many times the device that wrote them has been pointed at a different account, and
 * `globalOn` is the visible difference between two people's choices. Omitting `repoints` models a
 * record left behind by a build from before that counter existed. */
function personRecord(opts: {
  writeId: string;
  version: number;
  updatedAt: number;
  globalOn: boolean;
  repoints?: number;
  serverUpdatedAt?: string;
}): StoredSettingsRecord {
  const base: StoredSettingsRecord = {
    settings: { ...settings(opts.updatedAt), globalOn: opts.globalOn },
    syncMetadata: {
      version: opts.version,
      // Derived from the version by default, so the two agree and the version alone decides.
      // Override it to pin the tiebreak underneath, which nothing can reach while they agree.
      serverUpdatedAt: opts.serverUpdatedAt ?? new Date(1_800_000_000_000 + opts.version).toISOString(),
      lastWriteId: opts.writeId,
    },
  };
  return opts.repoints === undefined ? base : { ...base, syncEpoch: opts.repoints };
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

  // A shared iPhone or Mac. Alice used it, signed in, and her account had saved settings many
  // times; the app has since been repointed at Bob's brand-new account, which is on a much lower
  // version. This extension holds its own copy of the settings, so it is the second place that has
  // to understand what a repoint means. Teaching only the app's shared container is not enough:
  // this reconcile would push Alice's record straight back into it and undo the repair.
  it("the app has been repointed at a second person's account → adopt it, never push the first person's back", async () => {
    const alice = personRecord({ writeId: "alice", version: 99, updatedAt: 9_000, globalOn: false, repoints: 1 });
    const bob = personRecord({ writeId: "bob", version: 3, updatedAt: 12, globalOn: true, repoints: 2 });
    const local = fakeLocal(alice);
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(bob), pushToApp, local: local.store });

    await r.reconcile();

    expect(local.value?.syncMetadata?.lastWriteId).toBe("bob");
    expect(local.value?.settings.globalOn).toBe(true);
    expect(local.value?.syncEpoch).toBe(2);
    expect(pushToApp).not.toHaveBeenCalled();
    r.stop();
  });

  // The same shared device, on an install that was updated from a build with no repoint counter at
  // all. The record this extension is holding cannot say how many times it has been repointed, and
  // the honest answer is none, so it must not outrank one that has been.
  it("a local record with no repoint counter does not outrank an app record that has been repointed", async () => {
    const alice = personRecord({ writeId: "alice", version: 99, updatedAt: 9_000, globalOn: false });
    const bob = personRecord({ writeId: "bob", version: 3, updatedAt: 12, globalOn: true, repoints: 1 });
    const local = fakeLocal(alice);
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(bob), pushToApp, local: local.store });

    await r.reconcile();

    expect(local.value?.syncMetadata?.lastWriteId).toBe("bob");
    expect(pushToApp).not.toHaveBeenCalled();
    r.stop();
  });

  // The counter only ever answers "is this the same account". Two records on the same account carry
  // the same one, and everything below it must keep deciding exactly as it did before.
  it("equal repoint counters → the server version still decides", async () => {
    const older = personRecord({ writeId: "w1", version: 4, updatedAt: 9_000, globalOn: false, repoints: 2 });
    const newer = personRecord({ writeId: "w2", version: 5, updatedAt: 12, globalOn: true, repoints: 2 });
    const local = fakeLocal(older);
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(newer), pushToApp, local: local.store });

    await r.reconcile();

    expect(local.value?.syncMetadata?.version).toBe(5);
    expect(pushToApp).not.toHaveBeenCalled();
    r.stop();
  });

  // The tiebreak below the version, which nothing used to reach: every other record here derives
  // its server timestamp from its version, so the two can never disagree and the version always
  // answers first. Here they disagree deliberately, and the settings timestamp points the other way
  // as well, so the server timestamp is the only thing that can decide this.
  it("equal server versions → the later server timestamp decides", async () => {
    const held = personRecord({
      writeId: "w1", version: 7, updatedAt: 9_000, globalOn: false,
      serverUpdatedAt: "2026-09-01T10:00:00.000Z",
    });
    const arriving = personRecord({
      writeId: "w2", version: 7, updatedAt: 12, globalOn: true,
      serverUpdatedAt: "2026-09-01T11:00:00.000Z",
    });
    const local = fakeLocal(held);
    const pushToApp = vi.fn((_record: StoredSettingsRecord) => Promise.resolve());
    const r = createAppGroupReconciler({ pullFromApp: () => Promise.resolve(arriving), pushToApp, local: local.store });

    await r.reconcile();

    expect(local.value?.syncMetadata?.lastWriteId).toBe("w2");
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
