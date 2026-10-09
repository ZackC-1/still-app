import type { ExtrasRoute, MarkerAdapter, ServiceExtras } from "./extras.js";

/**
 * YouTube's Still Pro extras: hide surfaces (copied into the packaged rule set by sign-format2.mjs),
 * compiled routes and marker adapters. Each entry ships with the code and tests that implement
 * its feature, and every entry stays dormant while the paid tier is off (accessCapabilities).
 * Surface ids must never reuse a free surface id, and surfaces may target only this service's
 * Still Pro features (rules/__tests__/extras-free-protection.test.ts).
 *
 * SELECTOR STATUS: the mobile related-items section, individual comments teaser and dedicated
 * comments panel were observed on public m.youtube.com with a phone viewport on 2026-10-08.
 * Their preservation fixtures remain synthetic. Desktop/end-screen/chat selectors remain
 * UNVERIFIED CANDIDATES. Phone viewport evidence is not physical Safari or Firefox Android
 * acceptance; each control's device release gate still needs its behavioral evidence.
 * End-of-video suggestions and Live chat have NO phone-layout selectors on purpose: on 2026-10-09
 * public m.youtube.com in phone emulation showed no end cards or end-screen grid (its only end
 * card is the autoplay countdown, which is never hidden) and no live chat on live streams whose
 * desktop page had chat. Phone platforms therefore never offer them (access-policy.ts
 * DESKTOP_LAYOUT_ONLY_PRO).
 *
 * Boundaries every selector keeps: never a wrapper that also holds the playlist panel, the live
 * chat frame, the player's Replay/seek/settings controls or the autonav countdown. In particular
 * never `#secondary` or `#related` (they hold the playlist panel and chat), never the player
 * chrome, and never a carousel that holds the live-chat entry. Autoplay is a content handler (content/youtube-autoplay.ts), not a selector.
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

const COMMENTS_PANEL = "ytm-engagement-panel:has(> ytm-engagement-panel-section-list-renderer.engagement-panel-comments-section):not(:has(> * + *))";
const COMMENTS_PANEL_MARKER: MarkerAdapter = Object.freeze({
  feature: "youtube.comments",
  attribute: "data-still-youtube-comments-panel",
  candidates: "ytm-engagement-panel",
  ruleSelector: "ytm-engagement-panel[data-still-youtube-comments-panel]",
  structuralFallback: COMMENTS_PANEL,
  owns: (element: Element) => element.matches("ytm-engagement-panel") && element.children.length === 1
    && element.firstElementChild!.matches("ytm-engagement-panel-section-list-renderer.engagement-panel-comments-section"),
});

/** youtube.comments (Comments): the comments section and the comments engagement panel. */
const COMMENTS = Object.freeze([
  // The element itself, not its `#comments` id, so a recycled section with another id still
  // matches. Its siblings (the action carousel, chat) are never touched.
  "ytd-comments",
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]',
  // Mobile: the individual teaser, never its metadata carousel (which can also contain chat).
  "comments-entry-point-teaser-view-model",
  // An observed dedicated comments panel includes its own scrim. Hiding only the section
  // leaves that scrim/modal shell intercepting taps. Require the sole direct child to be the
  // comments renderer; an ambiguous panel that also holds another section remains visible.
  COMMENTS_PANEL,
  COMMENTS_PANEL_MARKER.ruleSelector,
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
  markers: Object.freeze([COMMENTS_PANEL_MARKER]),
  // youtube.autoplay (Autoplay prevention) is a packaged content handler, never rule data:
  // content/youtube-autoplay.ts, attached only while effectiveFeatures() reports it.
  handlers: Object.freeze(["youtube.autoplay"] as const),
});
