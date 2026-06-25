import { ChromeStorageAdapter, parseSettings } from "@still/core/storage";
import type { StillSettings } from "@still/shared-types";

// Safari background — the native App-Group bridge (KTD4). The content/popup/options surfaces read &
// write settings through browser.storage.local, but the *app's* WKWebView writes them into the
// shared App-Group container (UserDefaults(suiteName:) via StillKit). These two stores are
// reconciled here, by last-write-wins:
//
//   • on startup / on a content-script "reconcile" nudge → pull the App-Group value via a native
//     message to the SafariWebExtensionHandler; if it's newer, write it into browser.storage.local
//     (which fires storage.onChanged → the content script's cache reapplies with fresh settings);
//   • on any in-extension edit (storage.onChanged) → push it back to the App Group so the app agrees.
//
// A stale browser.storage therefore can't silently win. There is no declarativeNetRequest on Safari,
// so — unlike the Chromium background — this does no redirect gating (the Shorts redirect is the
// content script's location.replace, KTD1).

// Safari ignores the application identifier (it always routes to the app's SafariWebExtensionHandler),
// but browser.runtime.sendNativeMessage requires the argument.
const NATIVE_APP = "com.chartash.still";

/** Coerce a native `{ settings: "<json>" }` reply into StillSettings, or null. Unwraps the envelope,
 * then delegates the JSON parse + shape guard to the shared validator (the single hardening point). */
function parseNativeSettings(reply: unknown): StillSettings | null {
  if (!reply || typeof reply !== "object") return null;
  return parseSettings((reply as { settings?: unknown }).settings ?? null);
}

export default defineBackground(() => {
  const adapter = new ChromeStorageAdapter();
  // Guards the echo: when we write the App's value into browser.storage we must not immediately push
  // it straight back to the App Group as if it were a local edit.
  let applyingFromApp = false;

  async function pullFromApp(): Promise<StillSettings | null> {
    try {
      const reply = await browser.runtime.sendNativeMessage(NATIVE_APP, { kind: "get" });
      return parseNativeSettings(reply);
    } catch {
      return null; // native host unavailable (extension running outside the app container)
    }
  }

  async function pushToApp(settings: StillSettings): Promise<void> {
    try {
      await browser.runtime.sendNativeMessage(NATIVE_APP, {
        kind: "set",
        settings: JSON.stringify(settings),
      });
    } catch {
      /* native host unavailable */
    }
  }

  async function reconcile(): Promise<void> {
    const app = await pullFromApp();
    const local = await adapter.get();
    const appAt = app?.updatedAt ?? -1;
    const localAt = local?.updatedAt ?? -1;
    if (app && appAt > localAt) {
      applyingFromApp = true;
      try {
        await adapter.set(app); // app edited more recently → the content script must see it
      } finally {
        applyingFromApp = false;
      }
    } else if (local && localAt > appAt) {
      await pushToApp(local); // extension edited more recently → the app must see it
    }
  }

  // Mirror in-extension edits (popup/options/content) out to the App Group, skipping our own
  // app-originated writes (LWW makes a redundant round-trip harmless, but the guard avoids churn).
  adapter.subscribe((settings) => {
    if (!applyingFromApp) void pushToApp(settings);
  });

  // Reconcile on a content-script nudge (fired at document_start when a page loads).
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (message && typeof message === "object" && (message as { kind?: string }).kind === "reconcile") {
      void reconcile();
    }
    return false;
  });

  // Reconcile on cold start / activation.
  void reconcile();
});
