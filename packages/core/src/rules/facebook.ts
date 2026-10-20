import type { ServiceRulesV2 } from "@still/shared-types";

/**
 * Addresses that open Facebook's Reels feed rather than one Reel: the bare /reel/ entry the
 * top-menu tab and the left-sidebar shortcut use (/reel/?s=tab), the Reels player's own "For you",
 * "Following" and "Profile" feeds, the plural /reels feed and Watch's /watch/reels feed. A single
 * shared Reel is always /reel/<digits>, which none of these addresses reach. Facebook writes the
 * address either relative or absolute on the host it is serving.
 */
const REELS_FEED_HREF_PREFIXES = Object.freeze([
  "", "https://www.facebook.com", "https://m.facebook.com", "https://web.facebook.com", "https://facebook.com",
]);
/** Exactly the feed addresses the free core routes home (engine.ts), with or without a query. */
const REELS_FEED_PATHS = Object.freeze([["/reel/", "/reel/following/", "/reel/profile/"], ["/reels/", "/watch/reels/"]]);
const reelsFeedLink = (origin: string, paths: readonly string[]): string =>
  `a:is(${paths.map((path) => `[href="${origin}${path}"],[href^="${origin}${path}?"]`).join(",")})`;

/**
 * Facebook's top menu and left sidebar are div[role="navigation"] lists, not <nav> (12 Oct 2026):
 * each entry is an li whose link sits a few wrappers down. The whole li goes so the remaining
 * entries close up; an li that holds another list is never hidden. (Split per path group to stay
 * inside the 512-character selector bound.)
 */
const reelsFeedEntries = REELS_FEED_HREF_PREFIXES.flatMap((origin) => [
  reelsFeedLink(origin, REELS_FEED_PATHS.flat()),
  ...REELS_FEED_PATHS.map((paths) => `:is(nav, [role="navigation"]) li:has(${reelsFeedLink(origin, paths)}):not(:has(li))`),
]);

/** Captured core Reels discovery targets for explicit internal format2 opt-in.
 * Keep virtualizer and measured-tab boxes, renderer nodes and ordinary feed content.
 * Individual/shared playback and the optional Facebook categories remain separate.
 */
const selectors = Object.freeze([
  'nav a[aria-label="Reels"]',
  'nav li:has(> a[aria-label="Reels"])',
  // A feed article whose own direct child is a Reel link. Home no longer renders feed or article
  // roles (19 Oct 2026), but the Groups feed (/groups/feed/) and search results still do, so these
  // stay for those layouts.
  '[role="feed"] [role="article"]:has(> a[href^="/reel/"])',
  '[role="feed"] [role="article"]:has(> a[href^="/reels/"])',
  'div[data-virtualized] > div:has(div[role="grid"][aria-label="Reels"]):not(:has([data-virtualized]))',
  // ISS-0091: a single Reel post in a feed (Home, a Page, the Groups feed, search), captured 19 Oct
  // 2026. Every feed item is its own div[data-virtualized] unit; a Reel post's unit holds a video
  // and a link to a Facebook Reel (/reel/<id>, relative or absolute): its own "N second Reel" link,
  // its timestamp, or its comments' permalinks. Plain posts and shared Stories carry no Reel link,
  // a text post that only links a Reel has no video, and a Reel link in the post's own caption
  // (Facebook's story_message box) never counts, so those all stay. Some Home Reel posts show their
  // Reel link only once the pointer reaches the timestamp; until then nothing marks them as Reels,
  // so they stay visible until that moment. Hides the unit's child, like the shelf rule above.
  'div[data-virtualized] > div:has(:is(a[href^="/reel/"], a[href*="facebook.com/reel/"]):not([data-ad-rendering-role="story_message"] *)):has(video):not(:has([data-virtualized]))',
  'a[role="tab"][href^="https://www.facebook.com/"][href$="/reels_tab"]:not([href="https://www.facebook.com/reels_tab"]):not([href*="/groups/"]):not([href*="?"]):not([href*="#"]) > *',
  '[role="menu"] a[role="menuitemradio"][aria-checked][href^="https://www.facebook.com/"][href$="/reels_tab"]:not([href="https://www.facebook.com/reels_tab"]):not([href*="/groups/"]):not([href*="?"]):not([href*="#"])',
  '[role="tab"][aria-label^="Reels," i] > *',
  // ISS-0035: a Page's tab row in Facebook's mobile layout (iPhone Safari, captured 15 Oct 2026).
  // Each outer tab is the tap target and holds an inner tab labelled exactly "Reels"; the whole
  // outer tab goes, or an invisible area would still open the Reel grid. Facebook places the tabs
  // at fixed offsets, so the others stay where they are and nothing is measured again. Only a tab
  // after the first: each later tab is pulled up against the one before it, so hiding the first
  // would slide the rest out of the row. A Reels-first row stays as it is.
  '[role="tablist"] > [role="tab"] ~ [role="tab"]:has(> * > [role="tab"][aria-label="Reels"])',
  // ISS-0035: the Home feed's Reels section in Facebook's mobile layout (iPhone Safari, captured
  // 16 Oct 2026). Each feed unit is one direct row of the vscroller; this one has a section header
  // (an h2) three wrappers down and reel cards labelled "View reel ...". The whole row goes and the
  // rows below close up. A single shared reel has no section header, so it stays.
  '[data-type="vscroller"] > :has(> * > * > * > h2):has([role="button"][aria-label^="View reel"])',
  // ISS-0035: the top-menu Reels tab by its label, a fallback should its address change. Only the
  // banner's menu: the sidebar's own shortcuts (a group or Page someone named "Reels") never match.
  '[role="banner"] [role="navigation"] li:has(a[aria-label="Reels"]):not(:has(li))',
  ...reelsFeedEntries,
]);

export const FACEBOOK_REELS_RULES: ServiceRulesV2 = Object.freeze({
  matches: Object.freeze(["*://*.facebook.com/*"]),
  surfaces: Object.freeze([
    Object.freeze({
      id: "facebook-reels-discovery",
      feature: "facebook.reels",
      action: "hide",
      selectors,
    }),
  ]),
});
