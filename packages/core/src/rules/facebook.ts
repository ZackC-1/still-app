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
  '[role="feed"] [role="article"]:has(> a[href^="/reel/"])',
  '[role="feed"] [role="article"]:has(> a[href^="/reels/"])',
  'div[data-virtualized] > div:has(div[role="grid"][aria-label="Reels"]):not(:has([data-virtualized]))',
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
