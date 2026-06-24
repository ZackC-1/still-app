import "./still.css"; // packaged critical CSS (manifest content_scripts css, KTD2)
import { createContentScript, type StillWindow } from "@still/core/content";
import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import seed from "@still/core/seed";
import type { SignedRuleSet } from "@still/shared-types";

// The document_start content script for Safari. Same shared engine as Chromium, but on Safari there
// is no declarativeNetRequest: the Shorts→watch redirect is the content script's own location.replace
// (the core redirect port — KTD1), not a network-layer DNR rule.
//
// Bridge nudge (KTD4): the content script reads from browser.storage.local, but the *app's* WKWebView
// writes settings into the shared App-Group container. We don't block the document_start apply path
// on the bridge (U7) — instead we ask the background to reconcile the App Group into browser.storage;
// if the app's value is newer, the background's write fires storage.onChanged, which cache.watch()
// picks up and reapplies. So a stale browser.storage is corrected within a load, never silently kept.
export default defineContentScript({
  matches: [
    "*://*.youtube.com/*",
    "*://*.instagram.com/*",
    "*://*.facebook.com/*",
    "*://*.tiktok.com/*",
  ],
  runAt: "document_start",
  cssInjectionMode: "manifest",
  main() {
    const cache = new SettingsCache(new ChromeStorageAdapter());
    const script = createContentScript({
      win: window as unknown as StillWindow,
      doc: document,
      ruleSet: seed as unknown as SignedRuleSet,
      cache,
    });
    void script.start();

    // Nudge the background to pull the App-Group value (the app may have edited settings while the
    // extension was asleep). Fire-and-forget — the apply path above never waits on it.
    void browser.runtime.sendMessage({ kind: "reconcile" }).catch(() => {});
  },
});
