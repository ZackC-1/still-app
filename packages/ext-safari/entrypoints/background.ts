import { ChromeStorageAdapter, createSettingsIntentRouter, parseStoredSettingsRecord, type StoredSettingsRecord } from "@still/core/storage";
import { ChromeEntitlementAdapter, createEntitlementMessageRouter, parseBenefitAccessSnapshot } from "@still/core/entitlement";
import { createRuleSetRefresher } from "@still/core/rules";
import { createAppGroupReconciler } from "../lib/app-group-reconcile.js";
import { BrowserInstallGenerationStore, createEntitlementPull } from "../lib/entitlement-pull.js";
import {
  BrowserProjectionInstallStore,
  SeedingInstallGenerationStore,
  adoptIntoApp,
  appInstallId,
  createReinstallAwareReconciler,
  replaceProjection,
} from "../lib/reinstall-reconcile.js";
import { NATIVE_APP, pushSettingsToApp } from "../lib/native-settings.js";
import { createIndexedDbKeyValue, QUIET_FLUSH_ALARM, requestQuietFlush } from "@still/core/analytics";
import { createSafariBackgroundAnalytics } from "../lib/analytics.js";

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

// NATIVE_APP + pushSettingsToApp are shared with the popup's direct push (see lib/native-settings).
// Safari ignores the application identifier (it always routes to the app's SafariWebExtensionHandler),
// but browser.runtime.sendNativeMessage requires the argument.

/** Coerce a native `{ settings: "<json>" }` reply into a settings record, or null. Unwraps the envelope,
 * then delegates the JSON parse + shape guard to the shared validator (the single hardening point). */
function parseNativeSettings(reply: unknown): StoredSettingsRecord | null {
  if (!reply || typeof reply !== "object") return null;
  return parseStoredSettingsRecord((reply as { settings?: unknown }).settings ?? null);
}

export default defineBackground(() => {
  const entitlements = new ChromeEntitlementAdapter(Date.now, { authority: true, nativeObservation: async () => {
    const reply = await browser.runtime.sendNativeMessage(NATIVE_APP, { kind: "getBenefitAccess" });
    const envelope = reply && typeof reply === "object" ? (reply as { settings?: unknown }).settings : null;
    const value: unknown = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
    if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) throw new Error("Native benefit authority unavailable");
    return parseBenefitAccessSnapshot((value as { snapshot?: unknown }).snapshot);
  } });
  browser.runtime.onMessage.addListener(createEntitlementMessageRouter(entitlements, browser.runtime.id, browser.runtime.getURL("")));
  const adapter = new ChromeStorageAdapter({ authority: true, nativeMirror: true });
  browser.runtime.onMessage.addListener(createSettingsIntentRouter(
    intent => adapter.commitIntent(intent), browser.runtime.id, browser.runtime.getURL(""), record => adapter.set(record), () => adapter.readNativeAuthority(),
  ));

  // Product analytics (lib/analytics.ts): under the app's install, following the app's switch.
  // Registered in this first synchronous pass so onInstalled is not missed.
  const extensionOrigin = browser.runtime.getURL("");
  const analytics = createSafariBackgroundAnalytics({
    config: {
      key: import.meta.env.VITE_POSTHOG_KEY as string | undefined,
      host: import.meta.env.VITE_POSTHOG_HOST as string | undefined,
    },
    appVersion: browser.runtime.getManifest().version,
    sendNative: (message) => browser.runtime.sendNativeMessage(NATIVE_APP, message),
    platform: async () => (await browser.runtime.getPlatformInfo()).os,
    local: {
      async get(key) {
        return (await browser.storage.local.get(key))[key] ?? null;
      },
      async set(key, value) {
        await browser.storage.local.set({ [key]: value });
      },
    },
    queue: createIndexedDbKeyValue(),
    requestQuietFlush: () => requestQuietFlush(browser.alarms),
    isTrustedPage: (sender) =>
      sender.id === browser.runtime.id && typeof sender.url === "string" && sender.url.startsWith(extensionOrigin),
  });
  browser.runtime.onInstalled.addListener((details) => analytics.onInstalled(details));
  browser.runtime.onMessage.addListener(analytics.listener);
  browser.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === QUIET_FLUSH_ALARM) analytics.flush();
  });
  analytics.onStart();

  async function pullFromApp(): Promise<StoredSettingsRecord | null> {
    try {
      const reply = await browser.runtime.sendNativeMessage(NATIVE_APP, { kind: "get" });
      return parseNativeSettings(reply);
    } catch {
      return null; // native host unavailable (extension running outside the app container)
    }
  }


  // The reconcile + value-based echo guard live in a tested module (lib/app-group-reconcile); it owns
  // the storage subscription that mirrors in-extension edits out to the App Group, suppressing the
  // echo of its own app→local writes by `updatedAt`.
  //
  // Builds in which the Apple app saves committed (atomic) settings get the reinstall-aware reconcile
  // instead (owner decisions 28 and 30, lib/reinstall-reconcile), selected by the same build-time
  // opt-ins as the app's own mode rule. Vite inlines these values, so every default build folds to
  // the ordinary reconciler and entitlement store, byte-for-byte as before.
  const reinstallAware =
    (import.meta.env.VITE_APPLE_ATOMIC_SETTINGS === "true" &&
      !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)) ||
    (import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" &&
      import.meta.env.VITE_SUPABASE_URL &&
      import.meta.env.VITE_SUPABASE_ANON_KEY);
  const reconciler = reinstallAware
    ? createReinstallAwareReconciler({
        pullFromApp, pushToApp: pushSettingsToApp, local: adapter, adoptIntoApp,
        replaceLocal: replaceProjection, appInstallId, projectionInstall: new BrowserProjectionInstallStore(),
      })
    : createAppGroupReconciler({ pullFromApp, pushToApp: pushSettingsToApp, local: adapter });

  // Entitlement pull: the app mirrors its server-reconciled entitlement into the App Group; we copy
  // it into browser.storage so the content scripts' EntitlementCache gates Pro blocking on it. A
  // failed/empty pull leaves storage untouched (the TTL in ChromeEntitlementAdapter bounds staleness).
  // The pull is single-flighted, compares the app's install-generation id, and purges a stale grant
  // when the id changes (reinstall detection, issue #63) — all in lib/entitlement-pull.
  const pullEntitlementFromApp = createEntitlementPull({
    send: () => browser.runtime.sendNativeMessage(NATIVE_APP, { kind: "getEntitlement" }),
    sink: entitlements,
    // The reinstall-aware build seeds the projection's install id before this lane moves its own
    // id on after a reinstall (lib/reinstall-reconcile).
    generations: reinstallAware ? new SeedingInstallGenerationStore() : new BrowserInstallGenerationStore(),
  });

  // Reconcile on a content-script nudge (fired at document_start when a page loads).
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (message && typeof message === "object" && (message as { kind?: string }).kind === "reconcile") {
      void reconciler.reconcile();
      void pullEntitlementFromApp();
      // Real use (a supported site, or the popup, asked for a reconcile); only its day is recorded.
      analytics.onActivity();
    }
    return false;
  });

  // Reconcile on cold start / activation.
  void reconciler.reconcile();
  void pullEntitlementFromApp();

  // Refresh the signed rule-set cache for the next page load (P1 #6): fetch → verify against this
  // build's trusted keys → cache. Skipped (no-op) when no endpoint is configured, or on a production
  // build before production keys are published — in both cases the bundled seed keeps applying.
  const refreshRuleSet = createRuleSetRefresher({
    prod: import.meta.env.PROD,
    url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
    area: browser.storage.local,
  });
  void refreshRuleSet();
});
