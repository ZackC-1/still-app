import type { ServiceRulesV2 } from "@still/shared-types";

/** Captured core Reels discovery targets for explicit internal format2 opt-in.
 * Media belongs to its own article; caption links and song credits are not Reel ownership.
 * Search, messages, direct/shared playback and the optional controls remain separate.
 */
const selectors = Object.freeze([
  'nav a[href="/reels/"]',
  'article:has(> a[href^="/reel/"])',
  'article:has(a[href^="/reels/"]:not([href^="/reels/audio/"]) video)',
  'a[href^="/"]:not([href^="//"])[href*="/reel/"]:has(svg[aria-label="Clip"]):not(article *)',
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
