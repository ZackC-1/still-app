import "./still.css"; // packaged critical CSS (manifest content_scripts css, KTD2)
import "./still-pro.css"; // packaged Pro CSS gated by html.still-pro-active
import { createExtensionContentEntry } from "@still/core/content";

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
  main: createExtensionContentEntry({
    storage: chrome.storage.local,
    prod: import.meta.env.PROD,
    earlyRedirect: import.meta.env.FIREFOX,
    requestReconcile: () => {
      void Promise.resolve(chrome.runtime.sendMessage({ kind: "reconcile" })).catch(() => {});
    },
  }),
});
