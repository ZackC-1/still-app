import { parseStoredSettingsRecord, type StoredSettingsRecord } from "@still/core/storage";
import { createAppGroupReconciler, type AppGroupReconciler, type AppGroupReconcilerDeps } from "./app-group-reconcile.js";
import { BrowserInstallGenerationStore, INSTALL_GENERATION_KEY, parseNativeEntitlement } from "./entitlement-pull.js";
import { NATIVE_APP } from "./native-settings.js";

// Reinstall-aware App Group reconcile (owner decisions 28 and 30, U3-W4 P2). Used only by builds
// in which the Apple app saves committed (atomic) settings; the background selects it at build time,
// so default builds keep the ordinary reconciler byte-for-byte.
//
// iOS wipes the App Group when Still is deleted, but Safari keeps this extension's browser storage.
// The reinstalled app then saves an untouched first record. Two things must hold whatever order the
// app, the popup and this background run in:
//
//   1. While the app's record is still that untouched first record, Safari's retained copy wins:
//      it is offered to the app (native `settingsAdopt`, decided under the App Group lock) and never
//      overwritten by the first record.
//   2. Once the reinstalled app's record has changed (a choice, a sign-in), the app wins and this
//      projection follows it, even though the old install's copy may carry a higher commit order
//      that ordinary ordering would keep forever.
//
// The trigger for (2) is the App Group install id: this projection records the id it belongs to
// (`still:settingsInstallGeneration`), and a different id is a one-time decision. The first time
// this code runs, that record is seeded from the entitlement lane's last-seen id
// (`still:installGeneration`, issue #63) before any entitlement pull can move it on.

export const PROJECTION_INSTALL_KEY = "still:settingsInstallGeneration";
const SETTINGS_KEY = "still:settings";

/** What the app's native handler did with the offered copy, with the record it now holds. */
export interface LeftoverAdoption {
  readonly status: "adopted" | "kept" | "refused";
  readonly record: StoredSettingsRecord | null;
}

/** The install id this projection belongs to. */
export interface ProjectionInstallStore {
  get(): Promise<string | null>;
  set(id: string): Promise<void>;
  /**
   * First run only: take the entitlement lane's last-seen id as the id the retained projection
   * belongs to. Runs before that lane can move its id on (see SeedingInstallGenerationStore).
   */
  seed(): Promise<void>;
}

export interface ReinstallReconcilerDeps extends AppGroupReconcilerDeps {
  /** Offer the retained copy to replace the app's untouched first record. Null: app unreachable. */
  adoptIntoApp(record: StoredSettingsRecord): Promise<LeftoverAdoption | null>;
  /** Replace the projection outright (the one-time install decision), whatever its order. */
  replaceLocal(record: StoredSettingsRecord): Promise<void>;
  /** The App Group install id, or null when the app has not published one or is unreachable. */
  appInstallId(): Promise<string | null>;
  readonly projectionInstall: ProjectionInstallStore;
}

/**
 * The app's first record (owner decision 28), still untouched: commit order zero, never linked or
 * repointed, nothing held, queued or paused. The native handler makes the exact check.
 */
export function isUntouchedFirstRecord(record: StoredSettingsRecord): boolean {
  const state = record.atomic;
  return Boolean(state) && state!.sequence === 0 && state!.scope.generation === 0 && state!.scope.accountId === null &&
    state!.scope.sessionId === undefined && state!.anchor === null && state!.pending.length === 0 &&
    Object.keys(state!.held).length === 0 && state!.paused === null && (record.syncEpoch ?? 0) === 0 &&
    record.syncMetadata === null && (state!.ownership === "never-linked" || state!.ownership === "unknown");
}

function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).filter(k => k !== "intentCommitted").sort()
      .map(k => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sorted(value));
}

export function createReinstallAwareReconciler(deps: ReinstallReconcilerDeps): AppGroupReconciler {
  const ordinary = createAppGroupReconciler(deps);

  /** Settle the install decision first. Returns whether the ordinary reconcile should then run. */
  async function settle(): Promise<boolean> {
    await deps.projectionInstall.seed();
    const app = await deps.pullFromApp();
    const local = await deps.local.get();
    let installId: string | null = null;
    try { installId = await deps.appInstallId(); } catch { /* no signal */ }
    let recorded: string | null = null;
    let recordKnown = true;
    try { recorded = await deps.projectionInstall.get(); } catch { recordKnown = false; }
    // Affirmative evidence only: both ids known and different. Unknown is never a change.
    const changed = recordKnown && installId !== null && recorded !== null && recorded !== installId;
    const settled = async (): Promise<void> => {
      if (recordKnown && installId !== null && recorded !== installId) await deps.projectionInstall.set(installId);
    };
    // Before the app holds a committed record there is nothing to decide; legacy records keep the
    // ordinary order (the existing behaviour, in which Safari's retained copy wins).
    if (!app) return true;
    if (!app.atomic) {
      await settled();
      return true;
    }
    const same = local !== null && canonical(local) === canonical(app);
    if (isUntouchedFirstRecord(app) && local && !same) {
      // Safari's copy is itself an untouched first record (only ownership can differ): nothing
      // deliberate to keep, so take the app's record and stop asking.
      if (isUntouchedFirstRecord(local)) {
        await deps.replaceLocal(app);
        await settled();
        return false;
      }
      const adoption = await deps.adoptIntoApp(local);
      if (!adoption) return false; // app unreachable: keep the copy, a later reconcile retries
      if (adoption.status === "adopted" && adoption.record) {
        await deps.replaceLocal(adoption.record);
        await settled();
        return false;
      }
      if (adoption.status === "refused" && !changed) return false; // unreadable there: hold the copy
      // Kept (the app's record moved on meanwhile) or refused after a reinstall: the app wins.
      const current = adoption.record ?? app;
      if (changed || adoption.status === "refused") {
        await deps.replaceLocal(current);
        await settled();
        return false;
      }
      await settled();
      return true;
    }
    if (changed && local && !same) {
      // The reinstalled app's record has changed since its first launch: the app wins, once.
      await deps.replaceLocal(app);
      await settled();
      return false;
    }
    await settled();
    return true;
  }

  let tail: Promise<unknown> = Promise.resolve();
  return {
    reconcile(): Promise<void> {
      const run = async (): Promise<void> => {
        if (await settle()) await ordinary.reconcile();
      };
      const next = tail.then(run, run);
      tail = next.catch(() => undefined);
      return next;
    },
    stop: ordinary.stop,
  };
}

// ── Production dependencies (the Safari background) ───────────────────────────────────────────

/** Offer the retained copy to the app (native `settingsAdopt`). Null when unreachable/unreadable. */
export async function adoptIntoApp(record: StoredSettingsRecord): Promise<LeftoverAdoption | null> {
  try {
    const { intentCommitted: _committed, ...stored } = record;
    const reply: unknown = await browser.runtime.sendNativeMessage(NATIVE_APP, { kind: "settingsAdopt", settings: JSON.stringify(stored) });
    return parseAdoptionReply(reply);
  } catch {
    return null;
  }
}

/** Parse the handler's `{ settings: "<json>" }` envelope around `{status, record}`. */
export function parseAdoptionReply(reply: unknown): LeftoverAdoption | null {
  if (!reply || typeof reply !== "object") return null;
  const raw = (reply as { settings?: unknown }).settings;
  if (typeof raw !== "string" || raw === "") return null;
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body || typeof body !== "object") return null;
  const { status, record } = body as { status?: unknown; record?: unknown };
  if (status !== "adopted" && status !== "kept" && status !== "refused") return null;
  if (record === null) return { status, record: null };
  const parsed = parseStoredSettingsRecord(record);
  return parsed ? { status, record: parsed } : null;
}

/** The App Group install id, read through the read-only entitlement lane's envelope. */
export async function appInstallId(): Promise<string | null> {
  try {
    return parseNativeEntitlement(await browser.runtime.sendNativeMessage(NATIVE_APP, { kind: "getEntitlement" })).installId;
  } catch {
    return null;
  }
}

/**
 * Write the projection directly. Only the one-time install decision uses this, inside the
 * reconciler's own serialized lane; every other projection write keeps the ordered mirror.
 */
export async function replaceProjection(record: StoredSettingsRecord): Promise<void> {
  const { intentCommitted: _committed, ...stored } = record;
  await browser.storage.local.set({ [SETTINGS_KEY]: stored });
}

/** The projection's install id in browser storage. */
export class BrowserProjectionInstallStore implements ProjectionInstallStore {
  async get(): Promise<string | null> {
    const value: unknown = (await browser.storage.local.get(PROJECTION_INSTALL_KEY))[PROJECTION_INSTALL_KEY];
    return typeof value === "string" && value !== "" ? value : null;
  }
  async set(id: string): Promise<void> {
    await browser.storage.local.set({ [PROJECTION_INSTALL_KEY]: id });
  }
  /** Never throws; a failure leaves the record unknown (no change is ever inferred from unknown). */
  async seed(): Promise<void> {
    try {
      if (await this.get()) return;
      const previous: unknown = (await browser.storage.local.get(INSTALL_GENERATION_KEY))[INSTALL_GENERATION_KEY];
      if (typeof previous === "string" && previous !== "") await this.set(previous);
    } catch {
      /* unknown stays unknown */
    }
  }
}

/**
 * The entitlement lane's id store in reinstall-aware builds: before it records a new App Group id
 * (the reinstall purge, or a first adopt), it seeds the projection's install id from the id it is
 * about to replace. Whichever lane runs first, the projection is associated with the previous
 * install, never the new one.
 */
export class SeedingInstallGenerationStore extends BrowserInstallGenerationStore {
  constructor(private readonly projection: ProjectionInstallStore = new BrowserProjectionInstallStore()) {
    super();
  }
  override async set(id: string): Promise<void> {
    await this.projection.seed();
    await super.set(id);
  }
}
