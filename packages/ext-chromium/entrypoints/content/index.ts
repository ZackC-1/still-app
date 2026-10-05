import "./still.css"; // packaged critical CSS (manifest content_scripts css, KTD2)
import "./still-pro.css"; // packaged Pro CSS gated by html.still-pro-active
import { createShippingContentEntry } from "@still/core/content";
import { backForwardNavigation, createTikTokBlockedNavigation } from "@still/core/content";

// The document_start content script. It wires core's engine to the live page, reading settings
// from the chrome.storage-backed cache. On Chromium the hard-nav Shorts redirect is the DNR rule
// (background.ts); this script handles SPA navigations, the observer, and rule application.
// The shipping entry carries the packaged format-2 rule set and picks one engine per page; services
// stay on the legacy seed engine until core activates them (FORMAT2_SHIPPING_SERVICES).
//
// TikTok: builds that show the V3 screens hand a blocked top-level TikTok document to the
// extension's own blocked page through the background (same gate as background.ts). The message
// names nothing; the background reads the browser's sender. Other builds keep the in-page block.
// The gate is lib/modern-settings-runtime.ts's `atomicLocal` (unconfigured, or configured with
// modern sync opted in), restated here because a content script must never import the sync
// module graph, which reaches analytics (core/src/analytics/__tests__/boundaries.test.ts).
const configured = Boolean(
  (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() &&
    (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim(),
);
const showsV3Screens =
  !configured || (import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED as string | undefined) === "true";
const tiktokBlockedPage = showsV3Screens && window.top === window
  ? createTikTokBlockedNavigation({
      doc: document,
      send: (message) => chrome.runtime.sendMessage(message),
      traversal: backForwardNavigation,
    })
  : undefined;

export default defineContentScript({
  matches: [
    "*://*.youtube.com/*",
    "*://*.instagram.com/*",
    "*://*.facebook.com/*",
    "*://*.tiktok.com/*",
  ],
  runAt: "document_start",
  cssInjectionMode: "manifest",
  main: createShippingContentEntry({
    storage: chrome.storage.local,
    prod: import.meta.env.PROD,
    earlyRedirect: import.meta.env.FIREFOX,
    tiktokBlockedPage,
    requestReconcile: () => {
      void Promise.resolve(chrome.runtime.sendMessage({ kind: "reconcile" })).catch(() => {});
    },
  }),
});
