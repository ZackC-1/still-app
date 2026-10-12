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
]);
