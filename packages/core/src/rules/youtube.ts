import type { ServiceRulesV2 } from "@still/shared-types";

/** Captured Shorts discovery targets for explicit internal format2 opt-in.
 * Renderer children stay attached; the existing compiler owns reversible feature CSS.
 * Plain-text Shorts search-chip recovery and the five optional controls are separate work.
 */
const selectors = Object.freeze([
  'ytd-guide-entry-renderer:has(a[title="Shorts"])',
  'ytd-mini-guide-entry-renderer:has(a[title="Shorts"])',
  'a#endpoint[title="Shorts"]',
  'ytm-pivot-bar-item-renderer:has(a[href="/shorts"])',
  "ytm-pivot-bar-item-renderer:has(.pivot-shorts)",
  "ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])",
  "ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model):not(ytm-app *)",
  "ytm-rich-section-renderer:has(ytm-reel-shelf-renderer):not(ytm-app *)",
  "ytd-reel-shelf-renderer",
  "ytm-reel-shelf-renderer:not(ytm-app *)",
  "grid-shelf-view-model:has(ytm-shorts-lockup-view-model):not(ytm-app *)",
  "ytm-rich-item-renderer:has(ytm-shorts-lockup-view-model):not(ytm-app *)",
  "ytm-video-with-context-renderer:has(ytm-media-item.big-shorts-singleton):not(ytm-app *)",
  'ytm-video-with-context-renderer:has(a.media-item-thumbnail-container[href^="/shorts/"]):not(ytm-app *)',
  'ytm-rich-item-renderer:has(a.media-item-thumbnail-container[href^="/shorts/"]):not(ytm-app *)',
  "ytm-shorts-lockup-view-model:not(ytm-app *)",
  'ytd-video-renderer:has(a#thumbnail[href^="/shorts/"])',
  'yt-tab-shape[tab-title="Shorts"]',
  'tp-yt-paper-tab:has([href$="/shorts"])',
  'yt-chip-cloud-chip-renderer:has([title="Shorts"])',
  "ytm-app ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model)",
  "ytm-app ytm-rich-section-renderer:has(ytm-reel-shelf-renderer)",
  "ytm-app ytm-reel-shelf-renderer",
  "ytm-app grid-shelf-view-model:has(ytm-shorts-lockup-view-model)",
  "ytm-app ytm-rich-item-renderer:has(ytm-shorts-lockup-view-model)",
  "ytm-app ytm-video-with-context-renderer:has(ytm-media-item.big-shorts-singleton)",
  'ytm-app ytm-video-with-context-renderer:has(a.media-item-thumbnail-container[href^="/shorts/"])',
  'ytm-app ytm-rich-item-renderer:has(a.media-item-thumbnail-container[href^="/shorts/"])',
  "ytm-app ytm-shorts-lockup-view-model",
]);

export const YOUTUBE_SHORTS_RULES: ServiceRulesV2 = Object.freeze({
  matches: Object.freeze(["*://*.youtube.com/*"]),
  surfaces: Object.freeze([
    Object.freeze({
      id: "youtube-shorts-discovery",
      feature: "youtube.shorts",
      action: "hide",
      selectors,
    }),
  ]),
});
