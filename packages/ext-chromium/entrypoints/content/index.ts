import "./still.css"; // packaged critical CSS (manifest content_scripts css, KTD2)
import "./still-pro.css"; // packaged Pro CSS gated by html.still-pro-active
import { createContentScript, type StillWindow } from "@still/core/content";
import { EntitlementCache, ChromeEntitlementAdapter } from "@still/core/entitlement";
import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import seed from "@still/core/seed";
import type { SignedRuleSet } from "@still/shared-types";

// The document_start content script. It wires core's engine to the live page, reading settings
// from the chrome.storage-backed cache. On Chromium the hard-nav Shorts redirect is the DNR rule
// (background.ts); this script handles SPA navigations, the observer, and rule application.
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
    const entitlement = new EntitlementCache(new ChromeEntitlementAdapter());
    const script = createContentScript({
      win: window as unknown as StillWindow,
      doc: document,
      ruleSet: seed as unknown as SignedRuleSet,
      cache,
      entitlement,
    });
    void script.start();
  },
});
