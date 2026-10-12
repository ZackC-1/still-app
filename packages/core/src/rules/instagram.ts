import type { ServiceRulesV2 } from "@still/shared-types";

/** A packaged layout repair: CSS declarations for one selector. Compiled code, never rule data. */
export interface LayoutRule {
  readonly selector: string;
  readonly declarations: string;
}

/**
 * A profile page: its tab row links to the profile's own Reels tab (`/<user>/reels/`, never the
 * bare `/reels/` feed) or Tagged tab. Every profile-only rule below is bounded by it, so Home,
 * Explore, search and post pages never match them.
 */
const PROFILE = 'body:has([role="tablist"] :is(a[href$="/tagged/"], a[href$="/reels/"]:not([href="/reels/"])))';
/**
 * The profile grid (captured 12 Oct 2026): a column of rows, each row a few tile boxes whose only
 * child is the tile's own post (`/<user>/p/<code>/`) or Reel (`/<user>/reel/<code>/`) link. A post
 * opened over the profile shows in a dialog whose timestamp and comment links also contain /p/, so
 * nothing inside a dialog is ever the grid.
 */
const GRID = 'div:not([role="dialog"] *):has(> div > div > a[href^="/"][href*="/p/"], > div > div > a[href^="/"][href*="/reel/"])';
/** A grid row: only the column's children that hold tile links (never a loading row or marker). */
const ROW = `${GRID} > div:has(> div > a[href^="/"])`;

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
  // A profile's Reels tab: its whole slot, so the remaining tabs close up (ISS-0034).
  '[role="tablist"] > div:has(> a[href$="/reels/"])',
  '[role="tablist"] a[href$="/reels/"]',
  // A profile grid's Reel tiles: the whole tile box, which INSTAGRAM_REELS_LAYOUT lets the
  // remaining tiles fill without holes (ISS-0034).
  `${PROFILE} ${ROW} > div:has(> a[href^="/"][href*="/reel/"])`,
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
