import "./still.css"; // packaged critical CSS (manifest content_scripts css, KTD2)
import "./still-pro.css"; // packaged Pro CSS gated by html.still-pro-active
import { createContentScript, earlyShortsRedirect, type StillWindow } from "@still/core/content";
import { EntitlementCache, ChromeEntitlementAdapter } from "@still/core/entitlement";
import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import { resolveRuleSetForLoad, ruleSetTrust } from "@still/core/rules";
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

    // Firefox ships NO DNR redirect (wxt.config omits the ruleset — Firefox doesn't support the
    // regexSubstitution redirect), so there the content script is the ONLY Shorts redirect. Fire it
    // ahead of the ruleset read below: it awaits only the persisted settings (one storage read), so
    // a cold nav to m.youtube.com/shorts/<id> redirects before the page hydrates, and an off/paused
    // user is never redirected. Chromium keeps DNR-only: it redirects at the network layer, is
    // correctly gated on the setting, and needs no content-script pre-redirect.
    if (import.meta.env.FIREFOX) {
      void earlyShortsRedirect({
        win: window as unknown as StillWindow,
        ruleSet: seed as unknown as SignedRuleSet,
        cache,
      });
    }

    // Apply the newest of {cached, bundled}. The cached set is re-verified against THIS build's
    // trusted keys on read (storage outlives builds — a stale dev-signed or tampered cache must
    // not beat the bundled seed); the bundled seed is the trusted offline floor packaged with
    // the extension. A fast local storage read — no network on the apply path. (The hard-nav
    // Shorts redirect is DNR, so this await doesn't sit on that path.)
    const { ruleSet, source } = await resolveRuleSetForLoad(
      seed as unknown as SignedRuleSet,
      chrome.storage.local,
      ruleSetTrust(import.meta.env.PROD),
    );

    const script = createContentScript({
      win: window as unknown as StillWindow,
      doc: document,
      ruleSet,
      cache,
      entitlement,
      // The packaged manifest CSS is generated from the bundled seed: when that's what applies,
      // the per-frame reapply can skip hide surfaces entirely (CSS owns them) and only run removes.
      manifestCssOwnsHides: source === "bundled",
    });
    void script.start();

    // Nudge the background to refresh the signed rule-set cache for the next load. Fire-and-forget.
    void Promise.resolve(chrome.runtime.sendMessage({ kind: "reconcile" })).catch(() => {});
  },
});
