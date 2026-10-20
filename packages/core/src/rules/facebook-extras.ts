import type { ExtrasRoute, ServiceExtras } from "./extras.js";

/**
 * Facebook's Still Pro extras: hide surfaces (copied into the packaged rule set by sign-format2.mjs),
 * compiled routes and marker adapters. Each entry ships with the code and tests that implement
 * its feature, and every entry stays dormant while the paid tier is off (accessCapabilities).
 * Surface ids must never reuse a free surface id, and surfaces may target only this service's
 * Still Pro features (rules/__tests__/extras-free-protection.test.ts).
 *
 * The Stories tray and sidebar ads selectors follow the desktop www.facebook.com Home seen signed
 * in, in Chrome, on 2026-10-19 (ISS-0088); the feed Videos selectors could not be checked then
 * (see VIDEOS_FEED). The synthetic fixtures in tests/fixtures/extras/fb-*.html still mark every
 * family as a candidate, and each control's release gate still needs the owner's structural checks
 * (H-012, H-013, H-014). Uncertain content stays visible: every guard below errs towards leaving
 * a block on the page. No selector here depends on English text.
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
 * Facebook Stories (CP-081): the Stories tray above the feed, never "People you may know", posts or
 * messages. On 2026-10-19 the tray was a region holding a grid (rows of grid cells, each a card
 * whose link opens a Story) plus its scroll arrows, at a fixed depth: the region is the only child
 * of the only child of the main column's virtualised wrapper ([data-virtualized] > div > region).
 * The hide takes that region at that depth only, so a region that spans the whole column (tray and
 * posts together) can never qualify. A feed post that links to a Story (an author's story ring, a
 * shared Story) has no grid, so it stays; the in-feed Reels shelf is a grid with no Story links, so
 * it stays too. The region must also hold no other region and no Reel link (a Reel is only ever
 * hidden by the Reels control; feed Reels show their link only on hover, which is why the depth
 * anchor, not this guard, is what keeps posts safe), and is never inside a feed.
 */
const NOT_IN_FEED = ':not([role="feed"] *)';
const TRAY_REGION = `[role="main"] [data-virtualized] > div > [role="region"]:not(:has([role="region"]))${NOT_A_REEL}${NOT_IN_FEED}`;
/**
 * The phone layout (m.facebook.com in iPhone Safari, captured signed in on 20 Oct 2026, ISS-0101):
 * no main region, no virtualised wrapper and no Story links. The Home feed is the server-positioned
 * vscroller, and the tray is one of its rows: a horizontal scroller four levels down whose cards are
 * buttons, the person's own "Create story" card first, then "View <name> story. N new story" cards.
 * No other feed row is a horizontal scroller of story buttons: the Reels section's cards read
 * "View reel video …" (the free Reels control's, never this one), People you may know holds no
 * story button, and a post's author story ring is not inside a scroller. Rows stack with margins,
 * so hiding one closes its gap (docs/solutions/ui-bugs/facebook-mobile-layout-is-server-positioned.md).
 * A row that also holds a heading, an article or a Reel stays; an unknown depth fails open.
 */
const MOBILE_TRAY_ROW = '[data-type="vscroller"] > :has(> * > * > * > [data-is-h-scrollable] [role="button"]';
const NOT_ANOTHER_ROW = ':not(:has(h2, [role="article"], a[href*="/reel/"], a[href*="/reels/"], [aria-label^="View reel" i]))';
const STORIES_TRAY = Object.freeze([
  `${TRAY_REGION}:has([role="grid"] a[href^="/stories/"])`,
  `${TRAY_REGION}:has([role="grid"] a[href^="https://www.facebook.com/stories/"])`,
  `${MOBILE_TRAY_ROW}[aria-label^="Create story" i])${NOT_ANOTHER_ROW}`,
  `${MOBILE_TRAY_ROW}[aria-label^="View " i][aria-label*=" story" i])${NOT_ANOTHER_ROW}`,
]);

/**
 * Videos and Watch (CP-082): non-Reel and live feed-video units inside the feed, positively
 * identified by a video player plus their own direct link to a FACEBOOK video page (/videos/),
 * and the Watch navigation entries. A link to another site's /videos/ page (a GIF, a shared clip)
 * never counts, and a comment (an article inside a post's article) is never a feed unit. Direct
 * players outside the feed (Watch links, a Page's video, a shared Reel) are never matched.
 *
 * A unit whose only video link is /watch/?v=<id> is NOT a feed video: a Reel shared into the feed
 * can carry just that link (no /reel/ link for the Reel guard to see), and a Reel is only ever
 * hidden by the free Reels control. Uncertain, so it stays.
 *
 * UNVERIFIED and currently inert (ISS-0088, 2026-10-19): the signed-in desktop feed no longer
 * renders [role="feed"] or [role="article"], so these selectors match nothing. Every feed video
 * seen in that check was a Reel playing in the normal player, and its post carried no /videos/ or
 * /reel/ link until the pointer moved over its timestamp (Facebook fills that link in on hover).
 * A replacement must not identify a feed video by its player alone, or it would hide Reels. Kept
 * unchanged until a non-Reel feed video can be observed.
 */
const FEED_UNIT = '[role="feed"] [role="article"]:not([role="article"] [role="article"])';
const VIDEOS_FEED = Object.freeze([
  `${FEED_UNIT}:has(> a[href^="/"][href*="/videos/"]):has(video)${NOT_A_REEL}`,
  `${FEED_UNIT}:has(> a[href^="https://www.facebook.com/"][href*="/videos/"]):has(video)${NOT_A_REEL}`,
]);

/**
 * The Watch hub's navigation entries: exactly /watch or /watch/, relative or absolute, with any
 * query that names no video. Facebook's left-nav shortcut carries a tracking query
 * (/watch/?ref=bookmarks), which an exact href match would miss. A link that names a video
 * (?v= or &v=) plays that video and is never a hub entry, the same rule as the Watch hub route.
 * The safe-selector grammar has no "&", so any query containing "v=" stays (a parameter such as
 * nav= too): uncertain links err towards staying visible.
 */
const NAMES_NO_VIDEO = ':not([href*="v="])';
const WATCH_HUB_HREFS = Object.freeze(["/watch/", "/watch", "https://www.facebook.com/watch/", "https://www.facebook.com/watch"]);
const watchHubLink = (href: string): readonly string[] => [`a[href="${href}"]`, `a[href^="${href}?"]${NAMES_NO_VIDEO}`];
const VIDEOS_WATCH_NAV = Object.freeze([
  ...WATCH_HUB_HREFS.flatMap((href) => watchHubLink(href).map((link) => `nav ${link}`)),
  // The list item around any hub link goes too, so no empty <li> is left in the shortcut list.
  ...WATCH_HUB_HREFS.flatMap((href) => watchHubLink(href).map((link) => `nav li:has(> ${link})`)),
]);

/**
 * Desktop sidebar ads (CP-083, D039): only a right-column block made of outbound sponsored links.
 * Any block that also holds a same-site (relative) or www/web/m Facebook link, a list, a region
 * or a grid stays visible, so Contacts, birthdays and group chats are never hidden. No text or
 * "Sponsored"-letter detection, no feed ads and no mobile claim.
 *
 * On 2026-10-19 each ad's outbound link (through Facebook's l.facebook.com redirect, rel=nofollow)
 * sat several boxes deep in the right column, and the Sponsored heading, the ads and their divider
 * shared one box beside the Birthdays box. So the match is a box in the column that holds such a
 * link AND its own heading (h2, h3 or a heading role), and nothing a guard rejects: that is the
 * whole Sponsored block, while the box that also holds Birthdays (a relative link) stays. Requiring
 * the heading keeps the guards meaningful: without it, any inner box of a kept block (a group
 * card's shared link, a chat row's link preview) that holds only an outbound link would hide on its
 * own. The redirect host is not a guarded Facebook link, because every sidebar ad link goes
 * through it.
 */
const FACEBOOK_LINK = ':is(a[href^="/"], a[href*="//www.facebook.com/"], a[href*="//web.facebook.com/"], a[href*="//m.facebook.com/"], a[href*="//facebook.com/"])';
const SIDEBAR_ADS = Object.freeze([
  '[role="complementary"] div:has(a[href^="https://"][rel~="nofollow"]):has(h2, h3, [role="heading"])'
    + `:not(:has(${FACEBOOK_LINK}))`
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
