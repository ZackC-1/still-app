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
 * The phone layout's top tab bar (m.facebook.com in iPhone Safari, captured 20 and 21 Oct 2026): a
 * tab list of six equal fixed-width tabs ("feed, 1 of 6" … "reels, 4 of 6" … "marketplace, 6 of 6")
 * that the server positions with inline widths and margins, so hiding or shrinking the Reels tab
 * never moves the others. Its contents are hidden by the rule above (the tab keeps a box, as issue
 * #58 settled), which left an empty slot and a gap in the line under the bar (ISS-0102).
 *
 * This layout makes the Reels tab invisible and untappable and redraws the other five as five equal
 * tabs across the whole bar: each tab box is a fifth of the bar wide and placed at its new fifth by
 * its own margin-left (percentages of the bar, so no transform and nothing scaled). Inside, every
 * tab is a stack of three or four layers (data-mcomponent), each as wide as the old tab (a sixth of
 * the bar): the icon layer, the 2 px line under the bar, the dot layer and, on tabs that can show
 * a count, the pill layer. Their contents sit at fixed pixel offsets from the
 * layer's left edge (the icon 18 px in, the badge 31 px), and each layer's background and the line
 * are painted by a ::before that fills the layer. So each layer is widened to the whole tab and
 * padded on the left by half the difference (a twelfth of the new tab, 1/5 - 1/6 = 1/30 of the bar
 * shared both sides): the icon and badge keep their size and land centred in the wider tab, and the
 * line and backgrounds fill it, edge to edge across the bar.
 *
 * Sliding half a slot (2.1.1.420) closed the gap but left half a slot of grey page background bare
 * at each end, and stretching the tabs with scaleX drew the icons 20 per cent wide; this does
 * neither. Two scopes. The hide (invisible and untappable: a tappable blank slot opens Reels, see
 * ISS-0035) applies to any tab list holding the feed tab, whatever its tab count. The widening
 * arithmetic holds only for six equal tabs, so it applies only to such a list with a Reels tab and
 * exactly six children, all tabs. Any other count (an account with an extra entry) keeps the
 * half-tab slide, which needs only equal neighbours: no empty slot, a band at each end. A Page's
 * tab row (inner tabs labelled "Reels", no comma) and any other row with a "Reels, N of M" tab are
 * left as the hide alone leaves them. Compiled code, never rule data.
 */
const REELS_TAB = '[role="tab"][aria-label^="Reels," i]';
const TOP_BAR = '[role="tablist"]:has(> [role="tab"][aria-label^="feed," i])';
const TOP_BAR_REELS_TAB = `${TOP_BAR} > ${REELS_TAB}`;
const SIX_TAB_BAR = `${TOP_BAR}:has(> ${REELS_TAB}):has(> :nth-child(6))`
  + ':not(:has(> :nth-child(7))):not(:has(> :not([role="tab"])))';
/** A remaining tab's box on the six-tab bar: a fifth of the bar, at the fifth it now holds (0-based). */
const fifth = (place: number) => `transform:none!important;width:20%!important;margin-left:${20 * place}%!important`;
const SLOTS = [1, 2, 3, 4, 5, 6] as const;
export const FACEBOOK_REELS_LAYOUT: readonly LayoutRule[] = Object.freeze([
  Object.freeze({ selector: TOP_BAR_REELS_TAB, declarations: "visibility:hidden!important;pointer-events:none!important" }),
  // Any other tab count: the half-tab slide towards the hidden tab.
  Object.freeze({ selector: `${TOP_BAR} > [role="tab"]:has(~ ${REELS_TAB})`, declarations: "transform:translateX(50%)!important" }),
  Object.freeze({ selector: `${TOP_BAR_REELS_TAB} ~ [role="tab"]`, declarations: "transform:translateX(-50%)!important" }),
  // Six tabs: slot n (1-based) before the Reels tab holds place n - 1; after it, place n - 2. These
  // selectors are more specific than the slide's and come after it, so they replace it.
  ...SLOTS.slice(0, 5).map((n) => Object.freeze({
    selector: `${SIX_TAB_BAR} > [role="tab"]:nth-child(${n}):has(~ ${REELS_TAB})`,
    declarations: fifth(n - 1),
  })),
  ...SLOTS.slice(1).map((n) => Object.freeze({
    selector: `${SIX_TAB_BAR} > ${REELS_TAB} ~ [role="tab"]:nth-child(${n})`,
    declarations: fifth(n - 2),
  })),
  Object.freeze({
    // Only Facebook's own layers (data-mcomponent): an unknown child keeps its width rather than
    // being widened and padded out of place.
    selector: `${SIX_TAB_BAR} > [role="tab"]:not(${REELS_TAB}) > [data-mcomponent]`,
    declarations: "width:100%!important;padding-left:calc(100% / 12)!important;box-sizing:border-box!important",
  }),
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
