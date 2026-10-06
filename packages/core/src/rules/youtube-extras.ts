import type { ExtrasRoute, ServiceExtras } from "./extras.js";

/**
 * YouTube's Still Pro extras: hide surfaces (copied into the packaged rule set by sign-format2.mjs),
 * compiled routes and marker adapters. Each entry ships with the code and tests that implement
 * its feature, and every entry stays dormant while the paid tier is off (accessCapabilities).
 * Surface ids must never reuse a free surface id, and surfaces may target only this service's
 * Still Pro features (rules/__tests__/extras-free-protection.test.ts).
 *
 * SELECTOR STATUS: every selector below is an UNVERIFIED CANDIDATE taken from the synthetic
 * structural fixtures in tests/fixtures/extras/ (yt-watch-related, yt-m-watch-related,
 * yt-watch-end, yt-watch-comments-chat). None has been checked against live YouTube yet; each
 * control's release gate still needs its structural evidence. They are contracts only with
 * those fixtures.
 *
 * Boundaries every selector keeps: never a wrapper that also holds the playlist panel, the live
 * chat frame, the player's Replay/seek/settings controls or the autonav countdown. In particular
 * never `#secondary` or `#related` (they hold the playlist panel and chat), never the player
 * chrome, and never a carousel that holds the live-chat entry. Autoplay is separate work.
 */

/** youtube.related (Related videos): the recommendation renderer only, in either placement. */
const RELATED = Object.freeze([
  // Desktop: the watch-next renderer, in both the side-column and below-video placements.
  "ytd-watch-next-secondary-results-renderer",
  // m.youtube.com single-column watch next: only the related-items section, never the
  // comments entry section that shares its tag.
  'ytm-item-section-renderer[section-identifier="related-items"]',
]);

/** youtube.endscreen (End-of-video suggestions): in-player end cards and the end-screen grid. */
const ENDSCREEN = Object.freeze([
  ".ytp-ce-element",
  ".ytp-endscreen-content",
]);

/** youtube.comments (Comments): the comments section and the comments engagement panel. */
const COMMENTS = Object.freeze([
  // The element itself, not its `#comments` id, so a recycled section with another id still
  // matches. Its siblings (the action carousel, chat) are never touched.
  "ytd-comments",
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]',
]);

/** youtube.livechat (Live chat): the chat frame (with its entry button) and chat replay panel. */
const LIVECHAT = Object.freeze([
  "ytd-live-chat-frame",
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-live-chat-replay"]',
]);

/**
 * A TOP-LEVEL /live_chat or /live_chat_replay page goes to YouTube Home, silently (owner default:
 * extras redirects carry no notice). Content scripts run in the top frame only, so the chat
 * iframe embedded in a watch page is never redirected. Exact paths only (one optional trailing
 * slash, the same rule as extras.ts exactPath): /live_chatx or a nested path stays. Written as a
 * local pattern because sign-format2.mjs loads this module in plain Node, which allows type-only
 * imports here.
 */
const LIVE_CHAT_PATH = /^\/live_chat(?:_replay)?\/?$/;
const LIVE_CHAT_ROUTE: ExtrasRoute = Object.freeze({
  feature: "youtube.livechat",
  matches: (url: URL) => LIVE_CHAT_PATH.test(url.pathname),
  destination: (url: URL) => new URL("/", url.origin),
});

export const YOUTUBE_EXTRAS: ServiceExtras = Object.freeze({
  surfaces: Object.freeze([
    Object.freeze({ id: "youtube-related-videos", feature: "youtube.related", action: "hide", selectors: RELATED }),
    Object.freeze({ id: "youtube-end-of-video", feature: "youtube.endscreen", action: "hide", selectors: ENDSCREEN }),
    Object.freeze({ id: "youtube-comments", feature: "youtube.comments", action: "hide", selectors: COMMENTS }),
    Object.freeze({ id: "youtube-live-chat", feature: "youtube.livechat", action: "hide", selectors: LIVECHAT }),
  ]),
  routes: Object.freeze([LIVE_CHAT_ROUTE]),
  markers: Object.freeze([]),
});
