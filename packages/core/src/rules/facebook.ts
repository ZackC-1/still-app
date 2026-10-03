import type { ServiceRulesV2 } from "@still/shared-types";

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
