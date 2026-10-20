import type { ExtrasRoute, ServiceExtras } from "./extras.js";

/**
 * Instagram's Still Pro extras: hide surfaces (copied into the packaged rule set by sign-format2.mjs),
 * compiled routes and marker adapters. Each entry ships with the code and tests that implement
 * its feature, and every entry stays dormant while the paid tier is off (accessCapabilities).
 * Surface ids must never reuse a free surface id, and surfaces may target only this service's
 * Still Pro features (rules/__tests__/extras-free-protection.test.ts).
 *
 * The selectors below follow the desktop instagram.com layout seen signed in, in Chrome, on
 * 2026-10-19 (ISS-0087): the Home Stories tray, a profile's Highlights row and suggested-accounts
 * panel, Home's right-column "Suggested for you" block and the search entry's recommendation grid
 * (also at phone width). Instagram's markup is not a contract, so the synthetic fixtures in
 * tests/fixtures/extras/ig-*.html still mark them as candidates, and the live structural checks
 * (E0) still gate each control's release.
 *
 * Interface language: every selector observed on 2026-10-19 is structural (roles, element
 * names, Instagram's own data-pagelet name and link addresses), not English text. The one
 * English-only candidate left is the in-feed suggested-accounts list ([aria-label="Suggested
 * accounts"]), kept from the earlier fixtures because no in-feed carousel appeared in the check.
 *
 * Browsers without the Navigation API (Firefox; Safari before 26.2) see Instagram's own in-page
 * moves only through a URL poll (250 ms). The search-entry mark is address-scoped, so while it is
 * set the content script also re-reads the address on every DOM change: when Instagram moves from
 * the empty search page to a results page and renders the results, the stale mark is cleared in
 * the same mutation callback, before the results are painted. E0 must still confirm on those
 * browsers that Instagram changes the address before (not after) it renders the results; if it
 * renders first, the poll remains the bound.
 *
 * Every route is silent (no notice, no sub-line) and the predicates never overlap, because
 * resolveExtrasRoute stops at the first matching entry. Like every per-service extras module this
 * file has only type imports (sign-format2.mjs loads it directly in Node), so its path checks are
 * plain regular expressions rather than calls to extras.ts helpers.
 */

/** The intentional search entry the Explore hub opens instead (V3-D-021, owner decision 44). */
export const INSTAGRAM_SEARCH_ENTRY = "/explore/search/";

/** The exact Explore hub, with or without its trailing slash. */
const EXPLORE_HUB = /^\/explore\/?$/;
/**
 * Story viewer addresses: /stories/<user>/ and /stories/<user>/<id>/, shared links included, and
 * Highlights (/stories/highlights/<id>/), which also go Home per V3-D-252 while owner question Q8
 * (Home or the owning profile) is open. The Highlights part is its own commit so it can be dropped.
 */
const STORY_PATH = /^\/stories(\/|$)/;
/** Suggested accounts' own page and anything under it. */
const SUGGESTED_PATH = /^\/explore\/people(\/|$)/;

const home = (url: URL): URL => new URL("/", url.origin);

/** The no-query search entry itself: /explore/search/ (or without the slash) and no q parameter. */
const SEARCH_ENTRY_PATH = /^\/explore\/search\/?$/;
export function isSearchEntryWithoutQuery(location: Pick<URL, "pathname" | "search">): boolean {
  return SEARCH_ENTRY_PATH.test(location.pathname) && !new URLSearchParams(location.search).has("q");
}

/**
 * Address scope for the Explore recommendation hide. CSS cannot see the address, and the same
 * "search field, then a grid of posts" structure can also be a deliberate keyword or hashtag
 * RESULTS page (/explore/search/keyword/?q=..., where tag pages land per V3-D-045). So the content
 * script marks the document root only while the page is the no-query search entry, and the hide
 * selector requires that mark. On every other address the root is unmarked and the grid stays.
 *
 * Structure (2026-10-19): the search entry's main column holds the search field's box, then a
 * box of recommended post tiles nested a few levels deep. On desktop the field's box is a div,
 * at phone width a nav; neither is a form, and the field is a plain text input. The hide takes
 * the later sibling of the field's box that holds post or Reel tiles. The suggestions Instagram
 * shows while typing are profile, tag and keyword links, never /p/ or /reel/ tiles, so they stay.
 */
const SEARCH_ENTRY_MARKER = "data-still-instagram-search-entry" as const;
const EXPLORE_RECOMMENDATIONS =
  `[${SEARCH_ENTRY_MARKER}] main :has(input) ~ div:has(a[href^="/p/"], a[href^="/reel/"])`;

const routes: readonly ExtrasRoute[] = Object.freeze([
  Object.freeze({
    feature: "instagram.explore",
    // Only the exact Explore hub. Search (/explore/search/ and its keyword results), tags,
    // locations, /popular/ and every other nested path stay usable (D048, D057, V3-D-248). A hub
    // address that carries a search query is a deliberate search and is left alone.
    matches: (url: URL) => EXPLORE_HUB.test(url.pathname) && !url.searchParams.has("q"),
    // Only the path changes: language and other non-search parameters (hl=fr) and any fragment
    // carry over. A matched hub never has q, so no search query is invented.
    destination: (url: URL) => {
      const destination = new URL(url.href);
      destination.pathname = INSTAGRAM_SEARCH_ENTRY;
      return destination;
    },
  }),
  Object.freeze({
    feature: "instagram.stories",
    // The story viewer, including shared story links and Highlights, goes to same-site Home
    // (D043, V3-D-252).
    matches: (url: URL) => STORY_PATH.test(url.pathname),
    destination: home,
  }),
  Object.freeze({
    feature: "instagram.suggested",
    // The Suggested accounts page goes Home (V3-D-253).
    matches: (url: URL) => SUGGESTED_PATH.test(url.pathname),
    destination: home,
  }),
]);

/** Exact Threads hosts only, with and without www., never a look-alike, path or wrapped link. */
const THREADS_HOSTS = ["threads.com", "www.threads.com", "threads.net", "www.threads.net"] as const;
const threadsSelectors = THREADS_HOSTS.flatMap((host) => ["https", "http"].flatMap((scheme) => [
  // A path or query after the exact host: the trailing "/" or "?" stops "threads.com.example".
  `a[href^="${scheme}://${host}/" i]`,
  `a[href^="${scheme}://${host}?" i]`,
  // The bare host itself.
  `a[href="${scheme}://${host}" i]`,
]));

export const INSTAGRAM_EXTRAS: ServiceExtras = Object.freeze({
  surfaces: Object.freeze([
    Object.freeze({
      id: "instagram-explore-recommendations",
      feature: "instagram.explore",
      action: "hide",
      // Recommendation tiles beneath the search field only. The search field, its results list,
      // tag and location grids and the combined phone Search/Explore tab are never targets.
      selectors: Object.freeze([EXPLORE_RECOMMENDATIONS]),
    }),
    Object.freeze({
      id: "instagram-stories-highlights",
      feature: "instagram.stories",
      action: "hide",
      // The home Stories tray and the profile Highlights row. The profile header (photo, bio,
      // counts, buttons), the post grid and feed posts stay.
      selectors: Object.freeze([
        // Home: the tray's own region, named by Instagram's data-pagelet (desktop and phone width).
        '[data-pagelet="story_tray"]',
        // Profile: the row (a menu-role box with its scroll arrow) that holds the Highlights links.
        '[role="menu"]:has(a[href^="/stories/highlights/"])',
        // The Highlights list itself, inside the profile header only, should that box change.
        'header :is(ul, [role="list"]):has(> li a[href^="/stories/highlights/"])',
      ]),
    }),
    Object.freeze({
      id: "instagram-suggested-accounts",
      feature: "instagram.suggested",
      action: "hide",
      // Recommendation containers only: Home's right-column block, a profile's suggested-accounts
      // panel and the in-feed carousel. Followers/following lists, search, the account switcher,
      // the footer and feed posts stay.
      selectors: Object.freeze([
        // Home right column: the block whose heading row holds the "See all" link to the
        // Suggested page, heading and list together. Never a box that also holds a feed post, a
        // post or Reel link (an activity list), a footer or nav (a flatter right column whose box
        // also holds the account switcher and footer) or a named page region such as the Stories
        // tray (a new account's main column): such boxes stay.
        'div:has(> div > a[href="/explore/people/"])'
          + ':not(:has(article, footer, nav, [data-pagelet], a[href^="/p/"], a[href^="/reel/"]))',
        // Profile: the header section with its own heading and a carousel list of accounts (shown
        // by the header's similar-accounts toggle or after Follow). Never the Highlights row, and
        // never a section holding the profile's own name heading, its follower or following
        // counts, or outbound (bio) links, whatever headings and lists it also has.
        'header > section:has(h4):has(ul)'
          + ':not(:has(a[href^="/stories/highlights/"], h1, h2, a[href$="/followers/"], a[href$="/following/"], a[href^="http"]))',
        // In-feed carousel: an English-only candidate; not seen in the 2026-10-19 check.
        '[role="list"][aria-label="Suggested accounts"]',
      ]),
    }),
    Object.freeze({
      id: "instagram-threads-links",
      feature: "instagram.threads",
      action: "hide",
      selectors: Object.freeze(threadsSelectors),
    }),
  ]),
  routes,
  markers: Object.freeze([
    Object.freeze({
      feature: "instagram.explore",
      attribute: SEARCH_ENTRY_MARKER,
      // The document root: the mark scopes the whole page by address, so grids rendered later
      // (Instagram renders after load) are covered by CSS without any per-node work.
      candidates: "html",
      ruleSelector: EXPLORE_RECOMMENDATIONS,
      addressScoped: true,
      owns: (root: Element) => {
        const location = root.ownerDocument.defaultView?.location;
        return !!location && isSearchEntryWithoutQuery(location);
      },
    }),
  ]),
});
