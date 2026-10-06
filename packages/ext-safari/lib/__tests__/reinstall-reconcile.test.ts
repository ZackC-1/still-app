import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import type { StoredSettingsRecord } from "@still/core/storage";
import type { LocalSettingsStore } from "../app-group-reconcile.js";
import { INSTALL_GENERATION_KEY } from "../entitlement-pull.js";
import {
  BrowserProjectionInstallStore,
  PROJECTION_INSTALL_KEY,
  SeedingInstallGenerationStore,
  adoptIntoApp,
  createReinstallAwareReconciler,
  isUntouchedFirstRecord,
  parseAdoptionReply,
  type LeftoverAdoption,
  type ProjectionInstallStore,
} from "../reinstall-reconcile.js";

// Owner decisions 28 and 30, with the coordinator's ruling on divergence: while the reinstalled
// app's record is its untouched first record, Safari's retained copy wins; once that record has
// changed, the app wins and Safari follows. Records are shaped as the Apple app's native writer
// saves them (byte parity is pinned in packages/core's compiled StillKit tests).

const OLD = "OLD-INSTALL", NEW = "NEW-INSTALL";
const ACCOUNT = "11111111-1111-1111-1111-111111111111";

function firstRecord(ownership: "never-linked" | "unknown" = "never-linked"): StoredSettingsRecord {
  return {
    settings: { ...DEFAULT_SETTINGS, updatedAt: 0 },
    syncMetadata: null,
    syncEpoch: 0,
    atomic: { format: 1, sequence: 0, ownership, scope: { accountId: null, generation: 0 }, anchor: null, pending: [], held: {}, paused: null },
  };
}
/** The reinstalled app's first record after one choice made in the app. */
function afterAppChoice(): StoredSettingsRecord {
  const base = firstRecord();
  return { ...base, settings: { ...base.settings, services: { ...base.settings.services, tiktok: false }, updatedAt: 500 },
    atomic: { ...base.atomic!, sequence: 1 } };
}
/** The reinstalled app's first record after a sign-in (scope change). */
function afterSignIn(): StoredSettingsRecord {
  const base = firstRecord();
  return { ...base, syncEpoch: 1, atomic: { ...base.atomic!, sequence: 1, ownership: "previous-account", paused: "ownership-unconfirmed",
    scope: { accountId: ACCOUNT, generation: 1 } } };
}
/** The previous install's modern projection: Off choices, signed in and out (generation 2). */
const retainedModern: StoredSettingsRecord = {
  settings: { ...DEFAULT_SETTINGS, globalOn: false, services: { ...DEFAULT_SETTINGS.services, instagram: false }, updatedAt: 42 },
  syncMetadata: null,
  syncEpoch: 2,
  atomic: { format: 1, sequence: 9, ownership: "previous-account", scope: { accountId: null, generation: 2 }, anchor: null, pending: [], held: {}, paused: null },
};
/** The previous install's 2.x projection: Off choices. */
const retainedLegacy: StoredSettingsRecord = {
  settings: { ...DEFAULT_SETTINGS, globalOn: false, services: { ...DEFAULT_SETTINGS.services, instagram: false }, updatedAt: 42 },
  syncMetadata: { version: 4, serverUpdatedAt: "2026-09-01T00:00:00.000Z", lastWriteId: null },
  syncEpoch: 2,
};
function adoptedFrom(copy: StoredSettingsRecord): StoredSettingsRecord {
  return { ...copy, atomic: { ...firstRecord("unknown").atomic!, sequence: 1 } };
}

function fakeLocal(initial: StoredSettingsRecord | null) {
  let value = initial;
  const store: LocalSettingsStore = {
    get: () => Promise.resolve(value),
    set: (record) => { value = record; return Promise.resolve(); },
    subscribe: () => () => {},
  };
  return { store, write(record: StoredSettingsRecord) { value = record; }, replace: vi.fn(async (record: StoredSettingsRecord) => { value = record; }), get value() { return value; } };
}
function fakeInstall(initial: string | null): ProjectionInstallStore & { value: string | null } {
  const store = { value: initial,
    get: async () => store.value, set: async (id: string) => { store.value = id; }, seed: async () => {} };
  return store;
}

function harness(opts: {
  app: StoredSettingsRecord | null;
  local: StoredSettingsRecord | null;
  appId?: string | null;
  recorded?: string | null;
  adopt?: (record: StoredSettingsRecord) => Promise<LeftoverAdoption | null>;
  /** Runs right before the one-time replacement writes (a racing page mirror, for example). */
  beforeReplace?: (local: ReturnType<typeof fakeLocal>) => void;
}) {
  let app = opts.app;
  const local = fakeLocal(opts.local);
  const install = fakeInstall(opts.recorded === undefined ? OLD : opts.recorded);
  const pushToApp = vi.fn(async (_record: StoredSettingsRecord) => {});
  const adoptIntoApp = vi.fn(opts.adopt ?? (async (record: StoredSettingsRecord): Promise<LeftoverAdoption | null> => {
    app = adoptedFrom(record);
    return { status: "adopted", record: app };
  }));
  const appInstallId = vi.fn(async () => (opts.appId === undefined ? NEW : opts.appId));
  let raced = false;
  let reads = 0;
  const get = local.store.get;
  local.store.get = () => {
    // The reconciler reads the projection twice per replacement: to decide, then right before
    // writing. The racing write lands between the two.
    if (opts.beforeReplace && !raced && reads > 0) { raced = true; opts.beforeReplace(local); }
    reads += 1;
    return get();
  };
  const reconciler = createReinstallAwareReconciler({
    pullFromApp: async () => app, pushToApp, local: local.store, adoptIntoApp, replaceLocal: local.replace,
    appInstallId, projectionInstall: install,
  });
  return { reconciler, local, install, pushToApp, adoptIntoApp, appInstallId, setApp(next: StoredSettingsRecord) { app = next; }, app: () => app };
}

describe("reinstall: Safari's retained copy wins over the untouched first record", () => {
  it.each([["legacy", retainedLegacy], ["modern", retainedModern]] as const)("offers the %s copy and mirrors what the app adopted", async (_kind, copy) => {
    const h = harness({ app: firstRecord(), local: copy });
    await h.reconciler.reconcile();
    expect(h.adoptIntoApp).toHaveBeenCalledWith(copy);
    expect(h.local.value).toEqual(adoptedFrom(copy));
    expect(h.local.value?.settings.globalOn).toBe(false);
    expect(h.install.value).toBe(NEW);
    expect(h.pushToApp).not.toHaveBeenCalled();
    // Settled: a later reconcile asks nothing more.
    await h.reconciler.reconcile();
    expect(h.adoptIntoApp).toHaveBeenCalledOnce();
  });

  it.each(["never-linked", "unknown"] as const)("never lets a %s first record overwrite the copy when the app cannot take it", async (ownership) => {
    for (const answer of [null, { status: "refused" as const, record: firstRecord(ownership) }]) {
      for (const appId of [NEW, null]) {
        // An unreadable copy after a confirmed reinstall is the one exception (below).
        if (answer && appId === NEW) continue;
        const h = harness({ app: firstRecord(ownership), local: retainedLegacy, appId, adopt: async () => answer });
        await h.reconciler.reconcile();
        expect(h.local.value).toBe(retainedLegacy);
        expect(h.install.value).toBe(OLD);
      }
    }
  });

  it("a genuine new install (nothing retained) or an already mirrored first record needs no offer", async () => {
    for (const initial of [null, firstRecord(), { ...firstRecord(), intentCommitted: true } as StoredSettingsRecord]) {
      const h = harness({ app: firstRecord(), local: initial, recorded: null });
      await h.reconciler.reconcile();
      expect(h.adoptIntoApp).not.toHaveBeenCalled();
      expect(h.local.value).toEqual(initial ?? firstRecord());
      expect(h.install.value).toBe(NEW);
    }
  });

  it("a retained copy that is itself an untouched first record converges without asking, once", async () => {
    // The app saved a never-linked first record; Safari kept an unknown-owner one. Nothing to keep.
    const h = harness({ app: firstRecord("never-linked"), local: firstRecord("unknown"), appId: NEW, recorded: NEW });
    await h.reconciler.reconcile();
    await h.reconciler.reconcile();
    expect(h.adoptIntoApp).not.toHaveBeenCalled();
    expect(h.local.replace).toHaveBeenCalledOnce();
    expect(h.local.value).toEqual(firstRecord("never-linked"));
  });

  it("a converted 2.x copy at commit order zero that kept an Off choice is offered and kept, never replaced", async () => {
    // A signed-out 2.x user with Instagram Off opened the V3 app once: its unknown conversion sits at
    // sequence 0 / generation 0 and Safari mirrored it. After a reinstall the new first record is
    // all On. Structurally both look untouched; only the values tell them apart.
    const converted: StoredSettingsRecord = { ...firstRecord("unknown"),
      settings: { ...firstRecord("unknown").settings, services: { ...DEFAULT_SETTINGS.services, instagram: false }, updatedAt: 42 } };
    expect(isUntouchedFirstRecord(converted)).toBe(true);
    const h = harness({ app: firstRecord("never-linked"), local: converted });
    await h.reconciler.reconcile();
    expect(h.adoptIntoApp).toHaveBeenCalledWith(converted);
    expect(h.local.value).toEqual(adoptedFrom(converted));
    expect(h.local.value?.settings.services.instagram).toBe(false);
  });

  it("asks the app for its install id once per lifetime after the projection is recorded against it", async () => {
    const h = harness({ app: afterAppChoice(), local: afterAppChoice(), recorded: NEW });
    await h.reconciler.reconcile();
    await h.reconciler.reconcile();
    await h.reconciler.reconcile();
    expect(h.appInstallId).toHaveBeenCalledOnce();
    // A recorded id that does not match keeps asking (unknown is never assumed).
    const other = harness({ app: afterAppChoice(), local: afterAppChoice(), recorded: OLD, appId: null });
    await other.reconciler.reconcile();
    await other.reconciler.reconcile();
    expect(other.appInstallId).toHaveBeenCalledTimes(2);
  });

  it("recognizes only an untouched first record", () => {
    expect(isUntouchedFirstRecord(firstRecord())).toBe(true);
    expect(isUntouchedFirstRecord(firstRecord("unknown"))).toBe(true);
    const base = firstRecord();
    const state = base.atomic!;
    for (const changed of [retainedLegacy, retainedModern, afterAppChoice(), afterSignIn(),
      { ...base, atomic: { ...state, ownership: "previous-account" as const } },
      { ...base, atomic: { ...state, held: { globalOn: false } } },
      { ...base, atomic: { ...state, paused: "ordering-hold" } },
      { ...base, syncMetadata: retainedLegacy.syncMetadata }]) expect(isUntouchedFirstRecord(changed as StoredSettingsRecord)).toBe(false);
  });
});

describe("reinstall: once the reinstalled app's record has changed, the app wins and Safari follows", () => {
  it.each([["a choice in the app", afterAppChoice], ["a sign-in in the app", afterSignIn]] as const)(
    "%s before Safari's first reconcile replaces the old install's higher-order modern copy", async (_why, app) => {
      const h = harness({ app: app(), local: retainedModern });
      await h.reconciler.reconcile();
      expect(h.adoptIntoApp).not.toHaveBeenCalled();
      expect(h.local.value).toEqual(app());
      expect(h.install.value).toBe(NEW);
      // A one-time decision: afterwards the ordinary order applies, and the stores already agree.
      await h.reconciler.reconcile();
      expect(h.local.replace).toHaveBeenCalledOnce();
      expect(h.pushToApp).not.toHaveBeenCalled();
    });

  it("without reinstall evidence the ordinary order stands (unknown is never a change)", async () => {
    for (const [appId, recorded] of [[null, OLD], [NEW, NEW]] as const) {
      const h = harness({ app: afterAppChoice(), local: retainedModern, appId, recorded });
      await h.reconciler.reconcile();
      expect(h.local.replace).not.toHaveBeenCalled();
      expect(h.local.value).toBe(retainedModern);
    }
  });

  it("a legacy copy plus a Safari popup choice made before the first reconcile converges to the app's record", async () => {
    // The reconcile reads the untouched first record and offers the copy, but the popup's choice
    // (a native intent) reaches the app first: the app answers "kept" with its changed record.
    const h = harness({ app: firstRecord(), local: retainedLegacy, adopt: async () => {
      h.setApp(afterAppChoice());
      return { status: "kept", record: afterAppChoice() };
    } });
    await h.reconciler.reconcile();
    expect(h.local.value).toEqual(afterAppChoice());
    expect(h.install.value).toBe(NEW);
    await h.reconciler.reconcile();
    expect(h.adoptIntoApp).toHaveBeenCalledOnce();
    expect(h.pushToApp).not.toHaveBeenCalled();
    expect(h.local.value).toEqual(afterAppChoice());
  });

  it("the one-time replacement is compare-and-set: a newer projection written meanwhile is never overwritten", async () => {
    const newer = { ...afterAppChoice(), atomic: { ...afterAppChoice().atomic!, sequence: 2 } };
    const h = harness({ app: afterAppChoice(), local: retainedModern, beforeReplace: (local) => local.write(newer) });
    await h.reconciler.reconcile();
    expect(h.local.replace).not.toHaveBeenCalled();
    expect(h.local.value).toBe(newer);
    // The decision stays open: the install id is not recorded until a reconcile completes it.
    expect(h.install.value).toBe(OLD);
    // A racing write of the very record being installed counts as done.
    const same = harness({ app: afterAppChoice(), local: retainedModern, beforeReplace: (local) => local.write(afterAppChoice()) });
    await same.reconciler.reconcile();
    expect(same.local.replace).not.toHaveBeenCalled();
    expect(same.install.value).toBe(NEW);
  });

  it("an unreadable copy after a confirmed reinstall gives way to the app's record", async () => {
    const h = harness({ app: firstRecord(), local: retainedLegacy, adopt: async () => ({ status: "refused", record: firstRecord() }) });
    await h.reconciler.reconcile();
    expect(h.local.value).toEqual(firstRecord());
    expect(h.install.value).toBe(NEW);
  });
});

describe("Safari background dependencies", () => {
  afterEach(() => vi.unstubAllGlobals());
  function storage(initial: Record<string, unknown>) {
    const data = { ...initial };
    const writes: string[] = [];
    vi.stubGlobal("browser", { storage: { local: {
      get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
      set: async (values: Record<string, unknown>) => { for (const [k, v] of Object.entries(values)) { writes.push(k); data[k] = v; } },
    } }, runtime: { sendNativeMessage: vi.fn() } });
    return { data, writes };
  }

  it("the entitlement lane seeds the projection's install id with the id it is about to replace", async () => {
    const s = storage({ [INSTALL_GENERATION_KEY]: OLD });
    await new SeedingInstallGenerationStore().set(NEW);
    expect(s.data[PROJECTION_INSTALL_KEY]).toBe(OLD);
    expect(s.data[INSTALL_GENERATION_KEY]).toBe(NEW);
    expect(s.writes).toEqual([PROJECTION_INSTALL_KEY, INSTALL_GENERATION_KEY]);
    // Seeding is first-run only: a recorded id is never replaced by it.
    await new SeedingInstallGenerationStore().set("THIRD");
    expect(s.data[PROJECTION_INSTALL_KEY]).toBe(OLD);
    // Nothing known: nothing seeded.
    const empty = storage({});
    await new BrowserProjectionInstallStore().seed();
    expect(empty.data[PROJECTION_INSTALL_KEY]).toBeUndefined();
  });

  it("concurrent seeders share one seeding, so the entitlement lane cannot move the id first", async () => {
    // Storage that yields between every call, as browser storage does; the reconciler's first read
    // answers (as of the moment it was asked) only after the entitlement lane has had time to run.
    const data: Record<string, unknown> = { [INSTALL_GENERATION_KEY]: OLD };
    const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
    let first = true;
    vi.stubGlobal("browser", { storage: { local: {
      get: async (key: string) => {
        const answer = key in data ? { [key]: data[key] } : {};
        const slow = first && key === PROJECTION_INSTALL_KEY;
        first = false;
        await tick(slow ? 30 : 0);
        return answer;
      },
      set: async (values: Record<string, unknown>) => { await tick(); Object.assign(data, values); },
    } } });
    // The reconciler starts seeding; the entitlement lane records the new App Group id meanwhile.
    await Promise.all([new BrowserProjectionInstallStore().seed(), new SeedingInstallGenerationStore().set(NEW)]);
    expect(data[PROJECTION_INSTALL_KEY]).toBe(OLD);
    expect(data[INSTALL_GENERATION_KEY]).toBe(NEW);
  });

  it("adoptIntoApp sends one settingsAdopt with the stored record, never the per-reply flag", async () => {
    const record = retainedLegacy;
    const sendNativeMessage = vi.fn(async (_app: string, _message: { kind: string; settings: string }) => ({ settings: JSON.stringify({ status: "adopted", record }) }));
    vi.stubGlobal("browser", { runtime: { sendNativeMessage } });
    await expect(adoptIntoApp({ ...record, intentCommitted: true })).resolves.toEqual({ status: "adopted", record });
    const [, message] = sendNativeMessage.mock.calls[0]!;
    expect(Object.keys(message).sort()).toEqual(["kind", "settings"]);
    expect(message.kind).toBe("settingsAdopt");
    expect(JSON.parse(message.settings)).toEqual(record);
  });

  it("an unreachable app or unreadable reply is no answer", async () => {
    vi.stubGlobal("browser", { runtime: { sendNativeMessage: () => Promise.reject(new Error("no host")) } });
    await expect(adoptIntoApp(retainedLegacy)).resolves.toBeNull();
    for (const reply of [null, {}, { settings: "" }, { settings: "{" }, { settings: '{"status":"unavailable"}' },
      { settings: JSON.stringify({ status: "adopted", record: { settings: { globalOn: 1 } } }) }])
      expect(parseAdoptionReply(reply)).toBeNull();
    expect(parseAdoptionReply({ settings: JSON.stringify({ status: "kept", record: null }) })).toEqual({ status: "kept", record: null });
  });
});
