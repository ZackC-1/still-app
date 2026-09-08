import type { SettingsSyncMetadata, StoredSettingsRecord } from "@still/core/storage";

// The App-Group reconcile + echo guard (KTD4), extracted from the background entrypoint so it is unit-
// testable with injected deps. Reconciles the extension's browser.storage against the app's App-Group
// container, and mirrors in-extension edits out to the App Group. The comparison asks which side has
// been repointed at a different account most recently, then the server version, then `updatedAt`;
// `shouldAppWin` explains why the first of those has to come first.
//
// Echo guard — VALUE-based, not a transient boolean. After applying an app value locally we remember
// its `updatedAt`; the push subscription suppresses a push whose `updatedAt` matches the last-applied
// one. Because `updatedAt` is monotonic, this only ever matches the echo of our own app→local write
// (a real local edit always has a strictly newer `updatedAt`). It is therefore immune to (a) the timing
// difference between a synchronous in-memory notify and chrome.storage.onChanged's async delivery, and
// (b) overlapping reconcile() calls — neither can sneak the just-applied value back to the app.

/** The local store the reconciler drives (browser.storage via ChromeStorageAdapter, or a test fake). */
export interface LocalSettingsStore {
  get(): Promise<StoredSettingsRecord | null>;
  set(record: StoredSettingsRecord): Promise<void>;
  subscribe(listener: (record: StoredSettingsRecord) => void): () => void;
}

export interface AppGroupReconcilerDeps {
  /** Read the App-Group value (native `get`). */
  pullFromApp(): Promise<StoredSettingsRecord | null>;
  /** Write a value to the App Group (native `set`). */
  pushToApp(record: StoredSettingsRecord): Promise<void>;
  /** The local browser.storage-backed store. */
  local: LocalSettingsStore;
}

export interface AppGroupReconciler {
  /** Pull the app value, compare it with the local one, and apply-down or push-up the winner. */
  reconcile(): Promise<void>;
  /** Tear down the push subscription. */
  stop(): void;
}

export function createAppGroupReconciler(deps: AppGroupReconcilerDeps): AppGroupReconciler {
  // `updatedAt` of the most recent app→local apply; a subscription firing with this exact value is the
  // echo of our own write and must not be pushed back to the app.
  let lastAppliedKey: string | null = null;

  const unsubscribe = deps.local.subscribe((record) => {
    if (recordKey(record) === lastAppliedKey) return; // echo of an app-originated apply → skip
    void deps.pushToApp(record);
  });

  async function reconcile(): Promise<void> {
    const app = await deps.pullFromApp();
    const local = await deps.local.get();
    if (app && shouldAppWin(app, local)) {
      lastAppliedKey = recordKey(app); // mark BEFORE set so the resulting onChanged echo is suppressed
      await deps.local.set(app); // app edited more recently → the content script must see it
    } else if (local && shouldAppWin(local, app)) {
      await deps.pushToApp(local); // extension edited more recently → the app must see it
    }
  }

  return { reconcile, stop: unsubscribe };
}

function shouldAppWin(candidate: StoredSettingsRecord, current: StoredSettingsRecord | null): boolean {
  if (current === null) return true;
  // The repoint counter is asked before anything else, for the reason set out on
  // StoredSettingsRecord.syncEpoch: `version` orders writes inside one account's row and cannot
  // order two different people's rows. When someone signs out of a shared iPhone or Mac and the
  // next person signs in, the app repoints the shared container at the newcomer's account, which is
  // routinely on a lower version. This extension keeps its own copy of the settings, so without
  // this test it would read the newcomer's record as stale and push the previous person's straight
  // back into the container, undoing the repoint and re-exposing one person's settings to another.
  //
  // A record with no counter has never been repointed and therefore ranks where zero ranks, which
  // is what keeps a record left behind by a build that predates the counter from winning here.
  // Same order, same reasoning, as the Swift App Group store and the shared SettingsCache.
  const repointOrder = repointCount(candidate) - repointCount(current);
  if (repointOrder !== 0) return repointOrder > 0;
  const candidateMeta = candidate.syncMetadata;
  const currentMeta = current.syncMetadata;
  if (candidateMeta && currentMeta) {
    const metadataOrder = compareMetadata(candidateMeta, currentMeta);
    if (metadataOrder !== 0) return metadataOrder > 0;
    return candidate.settings.updatedAt > current.settings.updatedAt;
  }
  if (candidateMeta && !currentMeta) return true;
  if (!candidateMeta && currentMeta) return false;
  return candidate.settings.updatedAt > current.settings.updatedAt;
}

/** How many times a sign-in has repointed the device that wrote this record. See `shouldAppWin`. */
function repointCount(record: StoredSettingsRecord): number {
  return record.syncEpoch ?? 0;
}

function compareMetadata(a: SettingsSyncMetadata, b: SettingsSyncMetadata): number {
  if (a.version !== b.version) return a.version - b.version;
  return Date.parse(a.serverUpdatedAt) - Date.parse(b.serverUpdatedAt);
}

function recordKey(record: StoredSettingsRecord): string {
  const meta = record.syncMetadata;
  return meta ? `${meta.version}:${meta.serverUpdatedAt}:${meta.lastWriteId ?? ""}` : `local:${record.settings.updatedAt}`;
}
