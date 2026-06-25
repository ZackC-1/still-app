import type { StillSettings } from "@still/shared-types";

// The App-Group reconcile + echo guard (KTD4), extracted from the background entrypoint so it is unit-
// testable with injected deps. Reconciles the extension's browser.storage against the app's App-Group
// container by last-write-wins on `updatedAt`, and mirrors in-extension edits out to the App Group.
//
// Echo guard — VALUE-based, not a transient boolean. After applying an app value locally we remember
// its `updatedAt`; the push subscription suppresses a push whose `updatedAt` matches the last-applied
// one. Because `updatedAt` is monotonic, this only ever matches the echo of our own app→local write
// (a real local edit always has a strictly newer `updatedAt`). It is therefore immune to (a) the timing
// difference between a synchronous in-memory notify and chrome.storage.onChanged's async delivery, and
// (b) overlapping reconcile() calls — neither can sneak the just-applied value back to the app.

/** The local store the reconciler drives (browser.storage via ChromeStorageAdapter, or a test fake). */
export interface LocalSettingsStore {
  get(): Promise<StillSettings | null>;
  set(settings: StillSettings): Promise<void>;
  subscribe(listener: (settings: StillSettings) => void): () => void;
}

export interface AppGroupReconcilerDeps {
  /** Read the App-Group value (native `get`). */
  pullFromApp(): Promise<StillSettings | null>;
  /** Write a value to the App Group (native `set`). */
  pushToApp(settings: StillSettings): Promise<void>;
  /** The local browser.storage-backed store. */
  local: LocalSettingsStore;
}

export interface AppGroupReconciler {
  /** Pull the app value, compare `updatedAt`, and apply-down or push-up the newer side. */
  reconcile(): Promise<void>;
  /** Tear down the push subscription. */
  stop(): void;
}

export function createAppGroupReconciler(deps: AppGroupReconcilerDeps): AppGroupReconciler {
  // `updatedAt` of the most recent app→local apply; a subscription firing with this exact value is the
  // echo of our own write and must not be pushed back to the app.
  let lastAppliedAt: number | null = null;

  const unsubscribe = deps.local.subscribe((settings) => {
    if (settings.updatedAt === lastAppliedAt) return; // echo of an app-originated apply → skip
    void deps.pushToApp(settings);
  });

  async function reconcile(): Promise<void> {
    const app = await deps.pullFromApp();
    const local = await deps.local.get();
    const appAt = app?.updatedAt ?? -1;
    const localAt = local?.updatedAt ?? -1;
    if (app && appAt > localAt) {
      lastAppliedAt = app.updatedAt; // mark BEFORE set so the resulting onChanged echo is suppressed
      await deps.local.set(app); // app edited more recently → the content script must see it
    } else if (local && localAt > appAt) {
      await deps.pushToApp(local); // extension edited more recently → the app must see it
    }
  }

  return { reconcile, stop: unsubscribe };
}
