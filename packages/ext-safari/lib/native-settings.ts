import type { StoredSettingsRecord } from "@still/core/storage";

// The native App-Group message the extension uses to WRITE settings into the app's shared container
// (KTD4). Shared by the background reconciler and the popup: on iOS Safari the background may be
// asleep when the user toggles a setting in the popup, so the popup pushes its own edit directly —
// otherwise the write sits in browser.storage.local and never reaches the app until some later
// content-script reconcile happens to run.

/** The native host id (the app's bundle id); browser.runtime.sendNativeMessage targets it. */
export const NATIVE_APP = "com.chartash.still";

/** Write a settings record to the App Group via the app's SafariWebExtensionHandler. Best-effort:
 * a missing native host (extension running outside the app container) is swallowed. */
export async function pushSettingsToApp(record: StoredSettingsRecord): Promise<void> {
  try {
    await browser.runtime.sendNativeMessage(NATIVE_APP, {
      kind: "set",
      settings: JSON.stringify(record),
    });
  } catch {
    /* native host unavailable */
  }
}
