import "./still.css"; // packaged critical CSS (manifest content_scripts css, KTD2)
import "./still-pro.css"; // packaged Pro CSS gated by html.still-pro-active
import { createContentScript, type StillWindow } from "@still/core/content";
import { EntitlementCache, ChromeEntitlementAdapter } from "@still/core/entitlement";
import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import { resolveRuleSetForLoad } from "@still/core/rules";
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
  async main() {
    const cache = new SettingsCache(new ChromeStorageAdapter());
    const entitlement = new EntitlementCache(new ChromeEntitlementAdapter());

    // Apply the newest of {cached, bundled}. The cached set was signature-verified by the
    // background before it was stored; the bundled seed is the trusted offline floor packaged with
    // the extension. A fast local storage read — no network on the apply path. (The hard-nav
    // Shorts redirect is DNR, so this await doesn't sit on that path.)
    const { ruleSet } = await resolveRuleSetForLoad(
      seed as unknown as SignedRuleSet,
      chrome.storage.local,
    );

    const script = createContentScript({
      win: window as unknown as StillWindow,
      doc: document,
      ruleSet,
      cache,
      entitlement,
    });
    void script.start();

    // Nudge the background to refresh the signed rule-set cache for the next load. Fire-and-forget.
    void Promise.resolve(chrome.runtime.sendMessage({ kind: "reconcile" })).catch(() => {});
  },
});
