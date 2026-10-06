import "./still.css"; // packaged critical CSS (manifest content_scripts css, KTD2)
import "./still-pro.css"; // packaged Pro CSS gated by html.still-pro-active
import { createShippingContentEntry } from "@still/core/content";
import { createModernShippingContentEntry } from "@still/core/content/modern-entry";
import type { ContentScriptLifecycle } from "../../lib/reconcile-nudge.js";
import { startSafariReconcileNudges } from "../../lib/reconcile-nudge.js";

// The document_start content script for Safari. Same shared engine as Chromium, but on Safari there
// is no declarativeNetRequest: the Shorts→watch redirect is the content script's own location.replace
// (the core redirect port — KTD1), not a network-layer DNR rule. The shared shipping entry carries the
// packaged format-2 rule set and picks one engine per page (see FORMAT2_SHIPPING_SERVICES in core).
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
  async main(ctx) {
    // V3 builds (the same inline opt-in as the popup and settings page, and the Apple app's D04
    // rule: atomic-local, or configured with modern sync) run the modern entry: early redirects
    // for every core route and the pending cover (V3-D-052). Vite inlines these values, so default
    // and configured 2.x builds fold this branch and its import away and stay byte-identical
    // (U7-W3 ruling Q7).
    if (
      (import.meta.env.VITE_APPLE_ATOMIC_SETTINGS === "true" &&
        !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)) ||
      (import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" &&
        import.meta.env.VITE_SUPABASE_URL &&
        import.meta.env.VITE_SUPABASE_ANON_KEY)
    ) {
      await createModernShippingContentEntry({
        // As below: Safari implements only the extras every host implements.
        host: "safari",
        storage: browser.storage.local,
        prod: import.meta.env.PROD,
        earlyRedirect: true,
        pendingCover: window.top === window,
        nudge: {
          attach: (script, context) => startSafariReconcileNudges({
            lifecycle: context as ContentScriptLifecycle,
            send: () => browser.runtime.sendMessage({ kind: "reconcile" }),
            script,
            win: window,
            doc: document,
          }),
        },
      })(ctx);
      return;
    }
    await createShippingContentEntry({
      // Named for clarity: Safari implements only the extras every host implements (Instagram's
      // today), so this is the same set the engine uses without a host (and, while paid is off,
      // exactly the free features).
      host: "safari",
      storage: browser.storage.local,
      prod: import.meta.env.PROD,
      earlyRedirect: true,
      nudge: {
        attach: (script, context) => startSafariReconcileNudges({
          lifecycle: context as ContentScriptLifecycle,
          send: () => browser.runtime.sendMessage({ kind: "reconcile" }),
          script,
          win: window,
          doc: document,
        }),
      },
    })(ctx);
  },
});
