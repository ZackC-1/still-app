import type { ServiceRulesV2 } from "@still/shared-types";
import type { LayoutRule } from "./instagram.js";

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

/**
 * ISS-0091: a single Reel post in a feed (Home, a Page, the Groups feed, search), captured 19 Oct
 * 2026. Home no longer renders feed or article roles: every feed item is its own
 * div[data-virtualized] unit. A Reel post is recognised by its own player: the video sits inside a
 * link to that Reel (/reel/<id>, relative or absolute). Never by a Reel link elsewhere in the unit:
 * a link in the post's own caption (Facebook's story_message box) or in a comment (a labelled
 * article: a comment's permalink, a pasted URL or an attached Reel), a link to the Reels feed
 * itself (/reel/, /reel/?s=..., /reel/following/, /reel/profile/), or a box beside an ordinary
 * video ("More from this Page", a Marketplace or Live title) never counts. Home Reel posts that
 * show no Reel link around their player stay visible.
 *
 * Two shapes: a unit with no post article (Home, Pages, Groups), whose child hides like the shelf
 * rule above; and, inside a unit where posts are unlabelled articles (search modules, which can
 * hold several posts in one unit), only the Reel post's own top-level article. A unit holding an
 * article post is left to the article shape, and a unit that is or holds another unit never
 * qualifies. A Reel opened on its own page is not in a feed unit and is never touched.
 */
const OWN_REEL_LINK_ORIGINS = Object.freeze([
  ["a[href^=\"/reel/\"]", ""],
  ["a[href*=\"facebook.com/reel/\"]", "facebook.com"],
] as const);
/** The singular /reel/ feed entries: the bare Reels feed and its Following and Profile tabs. */
const REEL_FEED_PATHS: readonly string[] = REELS_FEED_PATHS[0]!;
const notFeedEntry = (origin: string): string => origin === ""
  ? REEL_FEED_PATHS.map((path) => `[href="${path}"],[href^="${path}?"]`).join(",")
  : REEL_FEED_PATHS.map((path) => `[href$="${origin}${path}"],[href*="${origin}${path}?"]`).join(",");
const NOT_CAPTION_OR_COMMENT = '[data-ad-rendering-role="story_message"] *,[role="article"][aria-label] *';
const ownReelPlayer = (link: string, origin: string): string =>
  `${link}:not(${notFeedEntry(origin)},${NOT_CAPTION_OR_COMMENT}) video`;
const feedReelPosts = OWN_REEL_LINK_ORIGINS.flatMap(([link, origin]) => [
  `div[data-virtualized] > div:not([data-virtualized]):has(${ownReelPlayer(link, origin)}):not(:has([data-virtualized],[role="article"]:not([aria-label])))`,
  `div[data-virtualized] [role="article"]:not([aria-label]):not([role="article"] *):has(${ownReelPlayer(link, origin)})`,
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
  ...feedReelPosts,
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

/**
 * The phone layout's top tab bar (m.facebook.com in iPhone Safari, captured 20 Oct 2026): a tab list
 * of six equal fixed-width tabs ("feed, 1 of 6" … "reels, 4 of 6" … "marketplace, 6 of 6") that the
 * server positions with inline widths and margins, so hiding or shrinking the Reels tab never moves
 * the others. Its contents are hidden by the rule above (the tab keeps a box, as issue #58
 * settled), which left an empty slot and a gap in the line under the bar (ISS-0102). This layout
 * makes the tab invisible and untappable and redraws the five remaining tabs across the whole bar:
 * each is stretched to 1.2 times its width (six slots shared by five tabs) about its own centre and
 * slid so the five sit edge to edge from the bar's left edge to its right edge. Sliding by half a
 * slot alone closed the gap but left half a slot of the bar's grey background bare at each end
 * (owner retest on 2.1.1.420). The tab's own white background and its share of the line under the
 * bar stretch with it; so do its icon and badge, 20 per cent wider than drawn.
 *
 * A transform does not move the layout, so a tab is placed by its slot alone: the tab in slot n
 * (1-based, of six, each a sixth of the bar wide, w) is centred at (n - 0.5)w and must be centred at
 * (m - 0.5)(1.2w), where m is its place among the five (n before the Reels tab, n - 1 after it). The
 * slide in its own width is therefore 0.2n - 0.1 before the Reels tab (10, 30, 50, 70, 90 per cent)
 * and 0.2n - 1.3 after it (-90, -70, -50, -30, -10 per cent), whichever slot the Reels tab holds
 * (the live bar has it fourth). The arithmetic holds only for six equal tabs, so the rules apply
 * only to a tab list holding the feed tab and a Reels tab with exactly six children, all tabs; any
 * other bar, a Page's tab row (inner tabs labelled "Reels", no comma) and any other row with a
 * "Reels, N of M" tab are left as the hide alone leaves them. Compiled code, never rule data.
 */
const REELS_TAB = '[role="tab"][aria-label^="Reels," i]';
const TOP_BAR = '[role="tablist"]:has(> [role="tab"][aria-label^="feed," i])'
  + `:has(> ${REELS_TAB}):has(> :nth-child(6))`
  + ':not(:has(> :nth-child(7))):not(:has(> :not([role="tab"])))';
const TOP_BAR_REELS_TAB = `${TOP_BAR} > ${REELS_TAB}`;
const stretch = (shift: number) => `transform:translateX(${shift}%) scaleX(1.2)!important;transform-origin:50% 50%!important`;
const SLOTS = [1, 2, 3, 4, 5, 6] as const;
export const FACEBOOK_REELS_LAYOUT: readonly LayoutRule[] = Object.freeze([
  Object.freeze({ selector: TOP_BAR_REELS_TAB, declarations: "visibility:hidden!important;pointer-events:none!important" }),
  ...SLOTS.slice(0, 5).map((n) => Object.freeze({
    selector: `${TOP_BAR} > [role="tab"]:nth-child(${n}):has(~ ${REELS_TAB})`,
    declarations: stretch(20 * n - 10),
  })),
  ...SLOTS.slice(1).map((n) => Object.freeze({
    selector: `${TOP_BAR_REELS_TAB} ~ [role="tab"]:nth-child(${n})`,
    declarations: stretch(20 * n - 130),
  })),
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
