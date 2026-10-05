import type { ExtrasRoute, ServiceExtras } from "./extras.js";

/**
 * Instagram's Still Pro extras: hide surfaces (copied into the packaged rule set by sign-format2.mjs),
 * compiled routes and marker adapters. Each entry ships with the code and tests that implement
 * its feature, and every entry stays dormant while the paid tier is off (accessCapabilities).
 * Surface ids must never reuse a free surface id, and surfaces may target only this service's
 * Still Pro features (rules/__tests__/extras-free-protection.test.ts).
 *
 * Every selector family below is an UNVERIFIED candidate taken from the synthetic structural
 * fixtures in tests/fixtures/extras/ig-*.html, not a contract with Instagram's markup. The live
 * structural checks (E0) gate each control's release, not this dormant code.
 *
 * ACTIVATION GATE (E0): the Stories tray and Suggested accounts selectors depend on English
 * aria-labels ("Stories", "Suggested accounts", "Similar accounts") and on the sidebar being an
 * <aside> that links straight to /explore/people/. Before paid activation, live signed-in checks
 * must confirm these shapes (and decide what to do for other interface languages, which these
 * labels do not match); until then these surfaces are candidates only.
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
 * "search form, then a grid of posts" structure is also a deliberate keyword or hashtag RESULTS
 * page (/explore/search/keyword/?q=..., where tag pages land per V3-D-045). So the content script
 * marks the document root only while the page is the no-query search entry, and the hide selector
 * requires that mark. On every other address the root is unmarked and the grid stays.
 */
const SEARCH_ENTRY_MARKER = "data-still-instagram-search-entry" as const;
const EXPLORE_RECOMMENDATIONS =
  `[${SEARCH_ENTRY_MARKER}] form:has(input[type="search"]) ~ div:has(> a[href^="/p/"], > a[href^="/reel/"])`;

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
      // The home Stories tray and the profile Highlights list. The profile header (photo, bio,
      // counts) and the post grid stay.
      selectors: Object.freeze([
        '[role="menu"][aria-label="Stories"]',
        ':is(ul, [role="list"]):has(> a[href^="/stories/highlights/"], > li > a[href^="/stories/highlights/"])',
      ]),
    }),
    Object.freeze({
      id: "instagram-suggested-accounts",
      feature: "instagram.suggested",
      action: "hide",
      // Recommendation containers only: the sidebar block that links to the Suggested page, the
      // in-feed carousel and a profile's similar-accounts row. Followers/following lists, search,
      // the account switcher and the footer stay.
      selectors: Object.freeze([
        'aside:has(> a[href="/explore/people/"])',
        '[role="list"][aria-label="Suggested accounts"]',
        '[role="region"][aria-label="Similar accounts"]',
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
      owns: (root: Element) => {
        const location = root.ownerDocument.defaultView?.location;
        return !!location && isSearchEntryWithoutQuery(location);
      },
    }),
  ]),
});
