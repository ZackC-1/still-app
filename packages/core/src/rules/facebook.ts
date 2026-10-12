import type { ServiceRulesV2 } from "@still/shared-types";

/**
 * Addresses that open Facebook's Reels feed rather than one Reel: the bare /reel/ entry the
 * top-menu tab and the left-sidebar shortcut use (/reel/?s=tab), the Reels player's own "For you",
 * "Following" and "Profile" feeds, the plural /reels feed and Watch's /watch/reels feed. A single
 * shared Reel is always /reel/<digits>, which none of these prefixes reach. Facebook writes the
 * address either relative or absolute, on www. or m.
 */
const REELS_FEED_HREF_PREFIXES = Object.freeze(["", "https://www.facebook.com", "https://m.facebook.com"]);
const reelsFeedLink = (origin: string): string =>
  `a:is([href="${origin}/reel/"], [href^="${origin}/reel/?"], [href^="${origin}/reel/following"], `
  + `[href^="${origin}/reel/profile"], [href="${origin}/reels"], [href^="${origin}/reels?"], `
  + `[href="${origin}/reels/"], [href^="${origin}/reels/?"], [href^="${origin}/watch/reels"])`;

/**
 * Facebook's top menu and left sidebar are div[role="navigation"] lists, not <nav> (12 Oct 2026):
 * each entry is an li whose link sits a few wrappers down. The whole li goes so the remaining
 * entries close up; an li that holds another list is never hidden.
 */
const reelsFeedEntries = REELS_FEED_HREF_PREFIXES.flatMap((origin) => [
  reelsFeedLink(origin),
  `:is(nav, [role="navigation"]) li:has(${reelsFeedLink(origin)}):not(:has(li))`,
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
  // ISS-0035: the top-menu Reels tab and the sidebar shortcut, by the label Facebook gives the tab.
  '[role="navigation"] li:has(a[aria-label="Reels"]):not(:has(li))',
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
