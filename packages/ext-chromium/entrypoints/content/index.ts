import "./still.css"; // packaged critical CSS (manifest content_scripts css, KTD2)
import "./still-pro.css"; // packaged Pro CSS gated by html.still-pro-active
import { createShippingContentEntry } from "@still/core/content";
import { createModernShippingContentEntry } from "@still/core/content/modern-entry";
import { backForwardNavigation, createTikTokBlockedNavigation } from "@still/core/content";
import { tiktokBlockedPageEnabled } from "../tiktok-blocked/gate.js";

// The document_start content script. It wires core's engine to the live page, reading settings
// from the chrome.storage-backed cache. On Chromium the hard-nav Shorts redirect is the DNR rule
// (background.ts); this script handles SPA navigations, the observer, and rule application.
// The shipping entry carries the packaged format-2 rule set and picks one engine per page: format-2
// for YouTube, Instagram and Facebook once settings are schema 2, otherwise the legacy seed engine.
//
// TikTok: builds that show the V3 screens hand a blocked top-level TikTok document to the
// extension's own blocked page through the background (same gate as background.ts). The message
// names nothing; the background reads the browser's sender. Other builds keep the in-page block.
// The gate (tiktok-blocked/gate.ts) is shared with background.ts and import-free, because a
// content script must never import the sync module graph, which reaches analytics.
const tiktokEnabled = tiktokBlockedPageEnabled({
  // Name each input: passing import.meta.env whole inlines every VITE_* value into the
  // bundle. The Supabase pair is reduced to trimmed presence (the gate's own rule), which the
  // build folds, so neither value reaches this bundle.
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL?.trim() ? "set" : "",
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ? "set" : "",
  VITE_MODERN_SETTINGS_SYNC_ENABLED: import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED,
});
const tiktokBlockedPage = tiktokEnabled && window.top === window
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
  // Firefox V3 builds (the same `atomicLocal` rule as tiktokEnabled above, written inline so the
  // build folds it) run the modern entry: an early document_start redirect for every core route,
  // not only Shorts. Chrome keeps DNR and the existing entry; configured 2.x builds fold this away
  // and stay byte-identical (U7-W3 ruling Q7).
  main:
    import.meta.env.FIREFOX &&
    (!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
      import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true")
      ? createModernShippingContentEntry({
          storage: chrome.storage.local,
          prod: import.meta.env.PROD,
          earlyRedirect: true,
          tiktokBlockedPage,
          requestReconcile: () => {
            void Promise.resolve(chrome.runtime.sendMessage({ kind: "reconcile" })).catch(() => {});
          },
        })
      : createShippingContentEntry({
          storage: chrome.storage.local,
          prod: import.meta.env.PROD,
          earlyRedirect: import.meta.env.FIREFOX,
          tiktokBlockedPage,
          requestReconcile: () => {
            void Promise.resolve(chrome.runtime.sendMessage({ kind: "reconcile" })).catch(() => {});
          },
        }),
});
