import type { ExtrasRoute, ServiceExtras } from "./extras.js";

/**
 * Facebook's Still Pro extras: hide surfaces (copied into the packaged rule set by sign-format2.mjs),
 * compiled routes and marker adapters. Each entry ships with the code and tests that implement
 * its feature, and every entry stays dormant while the paid tier is off (accessCapabilities).
 * Surface ids must never reuse a free surface id, and surfaces may target only this service's
 * Still Pro features (rules/__tests__/extras-free-protection.test.ts).
 *
 * The selector families below are UNVERIFIED candidates modelled on the synthetic fixtures in
 * tests/fixtures/extras/fb-*.html. Each control's release gate still needs the owner's structural
 * checks (H-012, H-013, H-014). Uncertain content stays visible: every guard below errs towards
 * leaving a block on the page.
 *
 * Free Reels stay independent and always win. The core's Reels routing (/reels/, /watch/reels/)
 * runs before any entry here, no entry may ever match /reel/, /reels/ or /watch/reels/
 * (facebook-extras.test.ts), and the Videos surfaces skip any unit that carries a Reel link, so a
 * Reel is only ever hidden by the Reels control. Under D244 a shared Reel playing in the normal
 * player is never re-hidden by Videos and Watch.
 */

/** A feed unit that owns a Reel belongs to the free Reels control, never to Videos and Watch. */
const NOT_A_REEL = ':not(:has(a[href*="/reel/"])):not(:has(a[href*="/reels/"]))';

/**
 * Facebook Stories (CP-081): the story cards in the tray, never the virtualiser wrapper that
 * holds them (its geometry stays), "People you may know", posts or messages. A card is a direct
 * child of a virtualised wrapper whose own direct child link opens a Story, OUTSIDE the feed: the
 * feed virtualises its posts with the same wrapper shape, so a post sharing a Story stays.
 */
const NOT_IN_FEED = ':not([role="feed"] *)';
const STORIES_TRAY = Object.freeze([
  `[role="main"] [data-virtualized] > div:has(> a[href^="/stories/"])${NOT_IN_FEED}`,
  `[role="main"] [data-virtualized] > div:has(> a[href^="https://www.facebook.com/stories/"])${NOT_IN_FEED}`,
]);

/**
 * Videos and Watch (CP-082): non-Reel and live feed-video units inside the feed, positively
 * identified by a video player plus their own direct link to a FACEBOOK video, and the Watch
 * navigation entries. A link to another site's /videos/ page (a GIF, a shared clip) never counts,
 * and a comment (an article inside a post's article) is never a feed unit. Direct players
 * outside the feed (Watch links, a Page's video, a shared Reel) are never matched.
 */
const FEED_UNIT = '[role="feed"] [role="article"]:not([role="article"] [role="article"])';
const VIDEOS_FEED = Object.freeze([
  `${FEED_UNIT}:has(> a[href^="/"][href*="/videos/"]):has(video)${NOT_A_REEL}`,
  `${FEED_UNIT}:has(> a[href^="https://www.facebook.com/"][href*="/videos/"]):has(video)${NOT_A_REEL}`,
  `${FEED_UNIT}:has(> a[href^="/watch/?v="]):has(video)${NOT_A_REEL}`,
]);
const VIDEOS_WATCH_NAV = Object.freeze([
  'nav a[href="/watch/"]',
  'nav a[href="/watch"]',
  'nav a[href="https://www.facebook.com/watch/"]',
  'nav li:has(> a[href="/watch/"])',
]);

/**
 * Desktop sidebar ads (CP-083, D039): only a right-column block made of outbound sponsored links.
 * Any block that also holds a Facebook link, a list, a region or a grid stays visible, so
 * Contacts, birthdays and group chats are never hidden. No text or "Sponsored"-letter detection,
 * no feed ads and no mobile claim.
 */
const SIDEBAR_ADS = Object.freeze([
  '[role="complementary"] > div:has(> a[href^="https://"][rel~="nofollow"])'
    + ':not(:has(a[href^="/"])):not(:has(a[href*="facebook.com/"]))'
    + ':not(:has([role="region"])):not(:has([role="list"])):not(:has([role="grid"]))',
]);

/**
 * True when the path is exactly `path`, with or without one trailing slash (the same rule as
 * extras.ts exactPath). Inlined because sign-format2.mjs imports this module directly in Node,
 * so it may carry only type imports.
 */
const isPath = (pathname: string, path: string): boolean => pathname === path || pathname === `${path}/`;

/** True when the URL names a video to play: a non-empty `v` query parameter. */
const namesVideo = (url: URL): boolean => (url.searchParams.get("v") ?? "") !== "";

/** Every Facebook extras route lands on the same-site Home, silently. */
const home = (url: URL): URL => new URL("/", url.origin);

/** Facebook Stories: /stories and everything under it, including shared Story links (D043). */
export const FACEBOOK_STORIES_ROUTE: ExtrasRoute = Object.freeze({
  feature: "facebook.stories",
  matches: (url: URL) => url.pathname === "/stories" || url.pathname.startsWith("/stories/"),
  destination: home,
});

/**
 * The Watch hub: exactly /watch or /watch/ with no video named. /watch/?v=<id> plays, and
 * /watch/<number> is left alone until the owner settles whether it is a direct player (Q10).
 */
export const FACEBOOK_WATCH_HUB_ROUTE: ExtrasRoute = Object.freeze({
  feature: "facebook.videos",
  matches: (url: URL) => isPath(url.pathname, "/watch") && !namesVideo(url),
  destination: home,
});

/**
 * The Watch live hub: exactly /watch/live or /watch/live/ with no video named. A direct live link
 * (/watch/live/?v=<id>, a Page's /videos/<id>) stays playable. Owner question Q10 is open; this
 * entry ships on its own so it can be dropped without touching the Watch hub above.
 */
export const FACEBOOK_WATCH_LIVE_HUB_ROUTE: ExtrasRoute = Object.freeze({
  feature: "facebook.videos",
  matches: (url: URL) => isPath(url.pathname, "/watch/live") && !namesVideo(url),
  destination: home,
});

export const FACEBOOK_EXTRAS: ServiceExtras = Object.freeze({
  surfaces: Object.freeze([
    Object.freeze({ id: "facebook-stories-tray", feature: "facebook.stories", action: "hide", selectors: STORIES_TRAY }),
    Object.freeze({ id: "facebook-videos-feed", feature: "facebook.videos", action: "hide", selectors: VIDEOS_FEED }),
    Object.freeze({ id: "facebook-videos-watch-nav", feature: "facebook.videos", action: "hide", selectors: VIDEOS_WATCH_NAV }),
    Object.freeze({ id: "facebook-sponsored-sidebar", feature: "facebook.sponsored", action: "hide", selectors: SIDEBAR_ADS }),
  ]),
  routes: Object.freeze([FACEBOOK_STORIES_ROUTE, FACEBOOK_WATCH_HUB_ROUTE, FACEBOOK_WATCH_LIVE_HUB_ROUTE]),
  markers: Object.freeze([]),
});
