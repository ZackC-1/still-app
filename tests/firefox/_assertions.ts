import type { Tab } from "./_session.js";

// "Still left this page alone" is the hardest claim to test, because before Still has decided
// anything the page also looks untouched. These checks therefore hold across a window that outlasts
// the content script's start-up, and callers must first have seen a positive sign that Still is
// running (the page was blocked, or the root marker was removed live).

const rootClass = (tab: Tab) =>
  tab.evaluate<string>("document.documentElement.className");

export const stillIsActive = async (tab: Tab): Promise<boolean> =>
  (await rootClass(tab)).includes("still-active");

export async function expectYoutubeLeftAlone(tab: Tab): Promise<void> {
  await tab.holdsFor(
    "YouTube left alone",
    async () =>
      (await tab.count("#shelf")) > 0 &&
      (await tab.isVisible("#endpoint")) &&
      !(await stillIsActive(tab)),
  );
}

export async function expectInstagramLeftAlone(tab: Tab): Promise<void> {
  await tab.holdsFor(
    "Instagram left alone",
    async () =>
      (await tab.count("#reel-post")) > 0 &&
      (await tab.isVisible("#reels-link")) &&
      !(await stillIsActive(tab)),
  );
}
