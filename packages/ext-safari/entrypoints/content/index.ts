import "./still.css"; // packaged critical CSS (manifest content_scripts css, KTD2)
import "./still-pro.css"; // packaged Pro CSS gated by html.still-pro-active
import { createExtensionContentEntry } from "@still/core/content";
import type { ContentScriptLifecycle } from "../../lib/reconcile-nudge.js";
import { startSafariReconcileNudges } from "../../lib/reconcile-nudge.js";

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
  async main(ctx) {
    await createExtensionContentEntry({
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
