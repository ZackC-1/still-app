import type { Tab } from "./_session.js";

// "Still left this page alone" is the hardest claim to test, because before Still has decided
// anything the page also looks untouched. These checks therefore hold across a window that outlasts
// the content script's start-up, and callers must first have seen a positive sign that Still is
// running (the page was blocked, or the root marker was removed live).
//
// This unconfigured Firefox build runs the shipped format-2 engine for YouTube, Instagram and
// Facebook: it marks the page with an owned feature class (still-feature-<n>-<service>-<feature>)
// and hides targets with a scoped stylesheet, leaving them in the page. TikTok stays on the legacy
// engine's site block.

const rootClass = (tab: Tab) =>
  tab.evaluate<string>("document.documentElement.className");

export const stillIsActive = async (tab: Tab): Promise<boolean> =>
  (await rootClass(tab)).includes("still-active");

const CORE = {
  youtube: "youtube-shorts",
  instagram: "instagram-reels",
  facebook: "facebook-reels",
} as const;
export type Format2Service = keyof typeof CORE;

/** Still is working on this page: its owned feature marker for the service's core is present. */
export const stillIsWorking = async (
  tab: Tab,
  service: Format2Service,
): Promise<boolean> =>
  new RegExp(`(^|\\s)still-feature-\\d+-${CORE[service]}(\\s|$)`).test(
    await rootClass(tab),
  );

/** No format-2 marker and no legacy marker: nothing of Still's is on the page root. */
export const noStillMarker = async (tab: Tab): Promise<boolean> =>
  !/(^|\s)still-(feature-|active|service-|pro-active)/.test(await rootClass(tab));

export async function expectYoutubeLeftAlone(tab: Tab): Promise<void> {
  await tab.holdsFor(
    "YouTube left alone",
    async () =>
      (await tab.isVisible("#shelf")) &&
      (await tab.isVisible("#endpoint")) &&
      (await noStillMarker(tab)),
  );
}

export async function expectInstagramLeftAlone(tab: Tab): Promise<void> {
  await tab.holdsFor(
    "Instagram left alone",
    async () =>
      (await tab.isVisible("#reel-post")) &&
      (await tab.isVisible("#reels-link")) &&
      (await noStillMarker(tab)),
  );
}
