import type { ServiceRulesV2 } from "@still/shared-types";
import type { MarkerAdapter } from "./extras.js";

/** A packaged layout repair: CSS declarations for one selector. Compiled code, never rule data. */
export interface LayoutRule {
  readonly selector: string;
  readonly declarations: string;
}

/** Instagram's web app hosts. Its other subdomains (about., help.) carry no profiles. */
export const INSTAGRAM_APP_HOST = /^(?:www\.|m\.)?instagram\.com$/;
/**
 * A profile's posts, Tagged or own Saved page (/<user>/, /<user>/tagged/, /<user>/saved/...), or
 * one of its posts or Reels (/<user>/p/<code>/, /<user>/reel/<code>/), which Instagram opens in a
 * dialog over the profile: the grid underneath keeps its layout while the dialog is open.
 */
const PROFILE_PATH = /^\/([\w.]+)(?:\/(?:(?:tagged|saved)(?:\/.*)?|(?:p|reel)\/[\w-]+\/?)?)?$/;
/** First segments that are Instagram's own sections, never a profile name. */
const NOT_PROFILES = new Set([
  "about", "accounts", "ajax", "api", "challenge", "developer", "direct", "directory", "emails",
  "explore", "graphql", "legal", "lite", "oauth", "p", "popular", "press", "privacy", "reel",
  "reels", "session", "static", "stories", "terms", "tv", "web",
]);

/** Whether an address is a profile's page: the only pages the grid rules below may touch. */
export function isInstagramProfilePage(location: Pick<URL, "hostname" | "pathname">): boolean {
  const name = PROFILE_PATH.exec(location.pathname)?.[1];
  return !!name && INSTAGRAM_APP_HOST.test(location.hostname) && !NOT_PROFILES.has(name.toLowerCase());
}

/**
 * The profile mark: the content script sets it on the document root while the Reels core is
 * effective and the address is a profile page (INSTAGRAM_PROFILE_MARKER). CSS cannot see the
 * address, and a page-wide :has() re-checked on every change of a busy feed costs too much on
 * iPhone Safari, so the profile-only rules below are bounded by this mark instead.
 */
const PROFILE_MARKER_ATTRIBUTE = "data-still-instagram-profile" as const;
const PROFILE = `[${PROFILE_MARKER_ATTRIBUTE}]`;
/**
 * The profile grid (captured 12 Oct 2026): a column of rows, each row a few tile boxes whose only
 * child is the tile's own post (`/<user>/p/<code>/`) or Reel (`/<user>/reel/<code>/`) link.
 * - A post opened over the profile shows in a dialog whose timestamp and comment links also
 *   contain /p/, so nothing inside a dialog is ever the grid.
 * - The column's inline padding is how Instagram stands in for rows it has unmounted on a long
 *   scroll. Flattened rows would no longer line up with that padding, so a column with non-zero
 *   inline padding is left as Instagram lays it out (its Reel links are still hidden by their
 *   Clip badge rule, leaving holes, as before this change).
 */
const GRID = 'div:not([role="dialog"] *)'
  + ':not([style*="padding-top: "]:not([style*="padding-top: 0px"]))'
  + ':not([style*="padding-bottom: "]:not([style*="padding-bottom: 0px"]))'
  + ':has(> div > div > a[href^="/"][href*="/p/"], > div > div > a[href^="/"][href*="/reel/"])';
/** A grid row: only the column's children that hold tile links (never a loading row or marker). */
const ROW = `${GRID} > div:has(> div > a[href^="/"])`;

/** A profile grid's Reel tile box; the profile mark's consuming selector. */
const PROFILE_REEL_TILE = `${PROFILE} ${ROW} > div:has(> a[href^="/"][href*="/reel/"])`;

/**
 * Sets the profile mark on the document root while the address is a profile page. Not
 * address-scoped (no per-change address re-read on browsers without the Navigation API): a mark
 * that outlives the profile by one URL poll is harmless, because only a profile grid's structure
 * matches the rules it bounds.
 */
export const INSTAGRAM_PROFILE_MARKER: MarkerAdapter = Object.freeze({
  feature: "instagram.reels",
  attribute: PROFILE_MARKER_ATTRIBUTE,
  candidates: "html",
  ruleSelector: PROFILE_REEL_TILE,
  owns: (root: Element) => {
    const location = root.ownerDocument.defaultView?.location;
    return !!location && isInstagramProfilePage(location);
  },
});

/** The Explore hub: /explore/ on a web app host (its search, tags and people pages are not). */
export function isInstagramExploreHub(location: Pick<URL, "hostname" | "pathname">): boolean {
  return INSTAGRAM_APP_HOST.test(location.hostname) && /^\/explore\/?$/.test(location.pathname);
}

/**
 * The item code of Instagram's post viewer address, /p/<code>/ or /<user>/p/<code>/, else null.
 * Explore opens every tile here, Reels included, so the address alone does not say whether the
 * open item is a Reel.
 */
export function instagramPostViewerCode(pathname: string): string | null {
  return /^\/(?:[\w.-]+\/)?p\/([\w-]+)\/?$/.exec(pathname)?.[1] ?? null;
}

/**
 * Whether the post viewer open in `doc` shows the Reel `code`: the viewer's own link to the item
 * it shows is its canonical address, /<user>/reel/<code>/ for a Reel and /<user>/p/<code>/ for a
 * post (captured 12 Oct 2026). Only a dialog counts, which is where the viewer's arrows live.
 */
export function instagramViewerShowsReel(doc: Document, code: string): boolean {
  if (!/^[\w-]+$/.test(code)) return false;
  return doc.querySelector(`[role="dialog"] a[href$="/reel/${code}/"]`) !== null;
}

/**
 * The Explore mark: set on the document root while the Reels core is effective and the address is
 * the Explore hub (INSTAGRAM_EXPLORE_MARKER), for the same reasons as the profile mark. Explore
 * itself stays for everyone (hiding it is a Still Pro extra); only its Reel tiles go (ISS-0038).
 */
const EXPLORE_MARKER_ATTRIBUTE = "data-still-instagram-explore" as const;
const EXPLORE = `[${EXPLORE_MARKER_ATTRIBUTE}]`;
/**
 * The Explore grid (captured 12 Oct 2026): the same virtualized column as the profile grid (left
 * alone while its inline padding is non-zero), whose rows are CSS grids (their inline style sets
 * `--x-gridTemplateColumns: repeat(N, 1fr)`) of tile boxes; each tile box holds a wrapper holding
 * the tile's /p/<code>/ link. A Reel tile's link carries an SVG titled "Reel" and a video.
 */
const EXPLORE_COLUMN = 'div:not([role="dialog"] *):has(> div > div > div > a[href^="/p/"])';
const EXPLORE_ROW = `${EXPLORE_COLUMN} > div:has(> div > div > a[href^="/p/"])`;
/** The column the layout below may join into one grid: never while Instagram virtualizes it. */
const EXPLORE_GRID = 'div:not([role="dialog"] *)'
  + ':not([style*="padding-top: "]:not([style*="padding-top: 0px"]))'
  + ':not([style*="padding-bottom: "]:not([style*="padding-bottom: 0px"]))'
  + ':has(> div > div > div > a[href^="/p/"])';
/**
 * An Explore Reel tile box; the Explore mark's consuming selector. The rows are fixed-track grids,
 * so a hidden tile never stretches its neighbours: without the layout below (a virtualized column
 * or an unlisted column count) it only leaves room at the end of its row, and it is hidden always.
 */
const EXPLORE_REEL_TILE = `${EXPLORE} ${EXPLORE_ROW} > div:has(> div > a[href^="/p/"] svg:is([aria-label="Reel"], [aria-label="Clip"]))`;

/**
 * Sets the Explore mark on the document root while the address is the Explore hub, and keeps it
 * while a tile is open in the post viewer over Explore (/p/<code>/), so the grid behind the dialog
 * keeps its layout and its Reels stay hidden. Any other address clears it.
 */
export const INSTAGRAM_EXPLORE_MARKER: MarkerAdapter = Object.freeze({
  feature: "instagram.reels",
  attribute: EXPLORE_MARKER_ATTRIBUTE,
  candidates: "html",
  ruleSelector: EXPLORE_REEL_TILE,
  owns: (root: Element) => {
    const location = root.ownerDocument.defaultView?.location;
    if (!location) return false;
    if (isInstagramExploreHub(location)) return true;
    return root.hasAttribute(EXPLORE_MARKER_ATTRIBUTE) && INSTAGRAM_APP_HOST.test(location.hostname)
      && instagramPostViewerCode(location.pathname) !== null;
  },
});

/** Captured core Reels discovery targets for explicit internal format2 opt-in.
 * Media belongs to its own article; caption links and song credits are not Reel ownership.
 * Search, messages, direct/shared playback and the optional controls remain separate.
 */
const selectors = Object.freeze([
  // The Reels item of the left menu or bottom bar. Instagram's current desktop menu is no longer
  // inside a <nav>, so the link is matched by its exact address alone (ISS-0033).
  'a[href="/reels/"]',
  'article:has(> a[href^="/reel/"])',
  'article:has(a[href^="/reels/"]:not([href^="/reels/audio/"]) video)',
  'a[href^="/"]:not([href^="//"])[href*="/reel/"]:has(svg[aria-label="Clip"]):not(article *)',
  // A profile's Reels tab: its whole slot, so the remaining tabs close up (ISS-0034). Never a
  // wrapper that also holds another tab, so the whole tab row can never go.
  '[role="tablist"] > div:has(> a[href$="/reels/"]):not(:has(> a:not([href$="/reels/"])))',
  '[role="tablist"] a[href$="/reels/"]',
  // A profile grid's Reel tiles: the whole tile box, which INSTAGRAM_REELS_LAYOUT lets the
  // remaining tiles fill without holes (ISS-0034).
  PROFILE_REEL_TILE,
  // Explore's Reel tiles: the whole tile box. Explore stays; its Reels do not (ISS-0038).
  EXPLORE_REEL_TILE,
]);

export const INSTAGRAM_REELS_RULES: ServiceRulesV2 = Object.freeze({
  matches: Object.freeze(["*://*.instagram.com/*"]),
  surfaces: Object.freeze([
    Object.freeze({
      id: "instagram-reels-discovery",
      feature: "instagram.reels",
      action: "hide",
      selectors,
    }),
  ]),
});

/**
 * The layout the profile grid needs once its Reel tiles are hidden (ISS-0034). Instagram lays the
 * grid out as fixed rows of three, and each tile grows to fill its row, so hiding a tile either
 * leaves a hole or stretches its neighbours to the full row. Here the rows stop being boxes and
 * the column wraps the remaining tiles three to a line at the grid's own size, so the posts close
 * up in order. Applied only while the Reels core hides, under the same owned feature class.
 * It is bound to the tile hide above: both use PROFILE and ROW, and a unit test fails if the
 * packaged hide stops selecting exactly the tile boxes this layout lays out.
 */
export const INSTAGRAM_REELS_LAYOUT: readonly LayoutRule[] = Object.freeze([
  Object.freeze({ selector: `${PROFILE} ${GRID}`, declarations: "flex-direction:row!important;flex-wrap:wrap!important;gap:1px!important" }),
  Object.freeze({ selector: `${PROFILE} ${ROW}`, declarations: "display:contents!important" }),
  Object.freeze({ selector: `${PROFILE} ${ROW} > div`, declarations: "flex:0 0 calc((100% - 2px) / 3)!important;margin:0!important" }),
  // Explore (ISS-0038): the column becomes one grid with the rows' own column count, and the rows
  // stop being boxes, so the remaining tiles close up in order. The count is read from the rows'
  // inline style; a count not listed here keeps Instagram's rows (room at the end of a row).
  ...[2, 3, 4, 5].flatMap((columns) => {
    // Every row says the same count (with or without a space after the comma), or no layout.
    const column = `${EXPLORE} ${EXPLORE_GRID}:has(> div[style*="repeat(${columns},"])`
      + `:not(:has(> div[style*="repeat("]:not([style*="repeat(${columns},"])))`;
    return [
      Object.freeze({ selector: column, declarations: `display:grid!important;grid-template-columns:repeat(${columns},1fr)!important;gap:1px!important` }),
      Object.freeze({ selector: `${column} > div:has(> div > div > a[href^="/p/"])`, declarations: "display:contents!important" }),
      // Anything else in the column (a loading row) spans the whole line instead of taking a cell.
      Object.freeze({ selector: `${column} > :not(div:has(> div > div > a[href^="/p/"]))`, declarations: "grid-column:1/-1!important" }),
    ];
  }),
]);
