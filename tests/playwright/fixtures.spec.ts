import { test, expect, fixture } from "./_extension.js";
import type { BrowserContext, Page } from "@playwright/test";
import { PAID_TIER_ENABLED } from "../../packages/shared-types/src/entitlement.js";

// Serve a service's fixture HTML for every request to its domain (no real network); the extension's
// content script injects because the committed URL matches its host pattern.
async function serve(page: Page, domainGlob: string, html: string): Promise<void> {
  await page.route(domainGlob, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
}

async function setEntitled(context: BrowserContext, extensionId: string, entitled: boolean): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate(async (value) => {
    const api = (globalThis as unknown as {
      chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };
    }).chrome;
    await api.storage.local.set({ "still:entitlement": { entitled: value, updatedAt: Date.now() } });
  }, entitled);
  await page.close();
}

// The YouTube regression matrix. Every fixture carries "keep-" controls copied from live markup,
// so each case asserts both halves of the promise: Shorts entry points disappear, and everything
// else is indistinguishable from the extension being off.

test("youtube home and subscriptions: Shorts shelves go, ordinary feed content stays", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube.html"));
  await page.goto("https://www.youtube.com/feed/subscriptions");

  await expect(page.locator("#shelf")).toHaveCount(0); // remove surface
  await expect(page.locator("#rich-shorts-section")).toHaveCount(0);
  await expect(page.locator("#subs-shorts-shelf")).toHaveCount(0);
  await expect(page.locator("#endpoint")).toBeHidden(); // hide surface (still-active CSS / applyDom)
  await expect(page.locator("#shorts-mini-guide")).toBeHidden();
  await expect(page.locator("#shorts-chip")).toBeHidden();

  await expect(page.locator("#keep-video")).toBeVisible(); // real content intact
  await expect(page.locator("#keep-subs-video")).toBeVisible();
  await expect(page.locator("#keep-guide-home")).toBeVisible();
  await expect(page.locator("#keep-chip-all")).toBeVisible();
  // A recommendation shelf is not a Shorts shelf just because one blurb links to a Short.
  await expect(page.locator("#keep-mixed-section")).toBeVisible();
  await expect(page.locator("#keep-mixed-video")).toBeVisible();
  // The Instagram and Facebook Reels rules must not reach a YouTube page (they are in the same
  // packaged stylesheet, scoped by the root service class).
  await expect(page.locator("#keep-reels-titled-video")).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/still-active/);
  await expect(page.locator("html")).toHaveClass(/still-service-youtube/);
});

test("youtube search: the Shorts shelf goes with its heading, ordinary results stay", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube-search.html"));
  await page.goto("https://www.youtube.com/results?search_query=shorts");

  // The whole shelf, not just its tiles: removing only the tiles left a "Shorts / Show more"
  // heading above an empty row.
  await expect(page.locator("#shorts-shelf")).toHaveCount(0);
  await expect(page.locator("#shorts-result")).toHaveCount(0);

  await expect(page.locator("#keep-first-result")).toBeVisible();
  await expect(page.locator("#keep-result-linking-to-short")).toBeVisible();
  await expect(page.locator("#keep-reels-titled-result")).toBeVisible();
  await expect(page.locator("#keep-normal-shelf")).toBeVisible();
});

test("youtube channel: the Shorts tab goes, uploads and community posts stay", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube-channel.html"));
  await page.goto("https://www.youtube.com/@YouTube");

  await expect(page.locator("#shorts-tab")).toBeHidden();
  await expect(page.locator("#shorts-tab-legacy")).toBeHidden();
  await expect(page.locator("#channel-shorts-shelf")).toHaveCount(0);

  await expect(page.locator("#keep-videos-tab")).toBeVisible();
  await expect(page.locator("#keep-videos-tab-legacy")).toBeVisible();
  await expect(page.locator("#keep-channel-video")).toBeVisible();
  // A creator's own words are not a Shorts entry point Still edits; following the link is what the
  // URL redirect handles.
  await expect(page.locator("#keep-community-post")).toBeVisible();
});

test("youtube watch: the related Shorts shelf goes, the player and up-next stay", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube-watch.html"));
  await page.goto("https://www.youtube.com/watch?v=long123");

  await expect(page.locator("#watch-shorts-shelf")).toHaveCount(0);
  await expect(page.locator("#watch-mobile-short")).toHaveCount(0);

  await expect(page.locator("#keep-player")).toBeVisible();
  await expect(page.locator("#keep-title")).toBeVisible();
  await expect(page.locator("#keep-desktop-next")).toBeVisible();
  await expect(page.locator("#keep-mobile-next")).toBeVisible();
});

test("youtube: a Shorts URL ends up on the watch page (redirect)", async ({ context }) => {
  const page = await context.newPage();
  await page.route("**://*.youtube.com/**", (route) => {
    const url = route.request().url();
    const body = url.includes("/watch") ? "<!doctype html><title>watch</title>watch" : fixture("youtube.html");
    return route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  await page.goto("https://www.youtube.com/shorts/abc123");
  await expect(page).toHaveURL(/\/watch\?v=abc123/);
});

test("m.youtube.com home: Shorts shelves and the Shorts tab go, ordinary cards stay", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube-mobile.html"));
  await page.goto("https://m.youtube.com/");

  await expect(page.locator("#shorts-tab")).toBeHidden();
  await expect(page.locator("#shorts-tab-by-href")).toBeHidden();
  await expect(page.locator("#mobile-shorts-section")).toHaveCount(0);
  await expect(page.locator("#mobile-reel-shelf-section")).toHaveCount(0);
  await expect(page.locator("#mobile-loose-short")).toHaveCount(0);
  await expect(page.locator("#mobile-shorts-card")).toHaveCount(0);

  await expect(page.locator("#home-tab")).toBeVisible();
  await expect(page.locator("#keep-mobile-video")).toBeVisible();
  // A section is not a Shorts shelf just because one blurb links to a Short, and a card is a Short
  // only when its own thumbnail is one. Both used to be removed.
  await expect(page.locator("#keep-mobile-mixed-section")).toBeVisible();
  await expect(page.locator("#keep-mobile-mixed-video")).toBeVisible();
  await expect(page.locator("#keep-mobile-video-linking-to-short")).toBeVisible();
  await expect(page.locator("#keep-mobile-reels-titled-video")).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/still-active/);
  await expect(page.locator("html")).toHaveClass(/still-service-youtube/);
});

test("m.youtube.com search: the Shorts shelf and Shorts results go, ordinary results stay", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube-mobile-search.html"));
  await page.goto("https://m.youtube.com/results?search_query=shorts");

  await expect(page.locator("#mobile-shorts-shelf")).toHaveCount(0);
  await expect(page.locator("#mobile-shorts-result")).toHaveCount(0);

  await expect(page.locator("#keep-mobile-first-result")).toBeVisible();
  await expect(page.locator("#keep-mobile-result-linking-to-short")).toBeVisible();
  await expect(page.locator("#keep-mobile-normal-shelf")).toBeVisible();
});

test("m.youtube.com channel: the Shorts shelf and tab go, ordinary shelves stay", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube-mobile-channel.html"));
  await page.goto("https://m.youtube.com/@YouTube");

  await expect(page.locator("#mobile-shorts-tab")).toBeHidden();
  await expect(page.locator("#mobile-channel-shorts-shelf")).toHaveCount(0);

  await expect(page.locator("#keep-mobile-videos-tab")).toBeVisible();
  await expect(page.locator("#keep-mobile-channel-shelf")).toBeVisible();
  await expect(page.locator("#keep-mobile-channel-video")).toBeVisible();
});

test("m.youtube.com watch: the related Shorts go, the up-next rail stays", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube-watch.html"));
  await page.goto("https://m.youtube.com/watch?v=long123");

  await expect(page.locator("#watch-mobile-short")).toHaveCount(0);
  await expect(page.locator("#keep-mobile-rail")).toBeVisible();
  await expect(page.locator("#keep-mobile-next")).toBeVisible();
});

test("m.youtube.com: a Shorts URL ends up on the watch page (redirect)", async ({ context }) => {
  const page = await context.newPage();
  await page.route("**://*.youtube.com/**", (route) => {
    const url = route.request().url();
    const body = url.includes("/watch") ? "<!doctype html><title>watch</title>watch" : fixture("youtube-mobile.html");
    return route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  await page.goto("https://m.youtube.com/shorts/def456");
  await expect(page).toHaveURL(/\/watch\?v=def456/);
});

test("instagram: free-user Reels behavior follows the paid-tier switch", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram.html"));
  await page.goto("https://www.instagram.com/someuser/");

  await expect(page.locator("#keep-post")).toBeVisible();
  if (PAID_TIER_ENABLED) {
    await expect(page.locator("#reel-post")).toBeVisible();
    await expect(page.locator("#reels-link")).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/still-pro-active/);
  } else {
    await expect(page.locator("#reel-post")).toHaveCount(0);
    await expect(page.locator("#reels-link")).toBeHidden();
    await expect(page.locator("html")).toHaveClass(/still-pro-active/);
  }
});

test("instagram: Pro user removes an inline Reel + hides the Reels nav, keeps a normal post", async ({ context, extensionId }) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram.html"));
  await page.goto("https://www.instagram.com/someuser/");

  await expect(page.locator("#reel-post")).toHaveCount(0);
  await expect(page.locator("#keep-post")).toBeVisible();
  await expect(page.locator("#reels-link")).toBeHidden();
});

// The signed-in home feed, rebuilt by hand from a real capture. It is the first surface anyone
// opens, so it is the one place over-blocking is most expensive and under-blocking most visible.
test("instagram home feed: Reels posts go, ordinary posts stay whole", async ({ context, extensionId }) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram-home.html"));
  await page.goto("https://www.instagram.com/");

  // A Reel in the feed links to /reels/<id>/, with an s. The rules used to look for /reel/<id>/
  // and so matched nothing at all here: both of these posts stayed, minus their video.
  await expect(page.locator("#reel-post")).toHaveCount(0);
  await expect(page.locator("#reel-post-with-hashtags")).toHaveCount(0);
  await expect(page.locator("#nav-reels")).toBeHidden();

  // Everything else is indistinguishable from the extension being off.
  await expect(page.locator("#keep-photo-post")).toBeVisible();
  await expect(page.locator("#keep-photo-post-image")).toBeVisible();
  await expect(page.locator("#keep-sponsored-post")).toBeVisible();
  await expect(page.locator("#keep-sponsored-post-cta")).toBeVisible();
  await expect(page.locator("#keep-sponsored-post-video")).toBeVisible();
  await expect(page.locator("#keep-nav-home")).toBeVisible();
  await expect(page.locator("#keep-nav-search")).toBeVisible();
  await expect(page.locator("#keep-nav-messages")).toBeVisible();

  // The post that decides how wide the rules may be drawn: an ordinary video post that uses a song
  // carries a /reels/audio/<id>/ credit, so a rule keyed on "/reels/" alone takes the whole post
  // with it. The post survives AND so does the credit line itself.
  await expect(page.locator("#keep-video-post-with-audio")).toBeVisible();
  await expect(page.locator("#keep-video-post-video")).toBeVisible();
  await expect(page.locator("#keep-video-post-audio")).toBeVisible();
});

test("instagram profile: grid Reels go, ordinary grid posts stay", async ({ context, extensionId }) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram.html"));
  await page.goto("https://www.instagram.com/someuser/");

  // A profile's own Reels live at /<username>/reel/<id>/, so a rule anchored to the start of the
  // address never matched them and eleven of them stayed on a real captured profile.
  await expect(page.locator("#profile-reel-tile")).toHaveCount(0);

  await expect(page.locator("#keep-profile-post-tile")).toBeVisible();
  // A username that merely begins with the letters "reel" is not a Reel.
  await expect(page.locator("#keep-profile-lookalike")).toBeVisible();
});

test("instagram mobile: Pro user blocks Reels routes and removes mobile Reels surfaces", async ({ context, extensionId }) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram-mobile.html"));

  await page.goto("https://www.instagram.com/");
  await expect(page.locator("#ig-mobile-reel")).toHaveCount(0);
  await expect(page.locator("#ig-mobile-post")).toBeVisible();
  await expect(page.locator("#ig-mobile-reels")).toBeHidden();

  await page.goto("https://www.instagram.com/someuser/reels/");
  await expect(page.locator("#still-placeholder")).toBeVisible();

  // The same Reel is served at /reel/<id>/ and at /<username>/reel/<id>/. Only the first was
  // blocked, so a Reel opened from a profile or a shared link still played.
  await page.goto("https://www.instagram.com/someuser/reel/ABC123/");
  await expect(page.locator("#still-placeholder")).toBeVisible();

  // An ordinary profile is not a Reels route.
  await page.goto("https://www.instagram.com/someuser/");
  await expect(page.locator("#still-placeholder")).toHaveCount(0);
  await expect(page.locator("#ig-mobile-post")).toBeVisible();
});

test("facebook: free-user Reels behavior follows the paid-tier switch", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/");

  await expect(page.locator("#keep-article")).toBeVisible();
  if (PAID_TIER_ENABLED) {
    await expect(page.locator("#reel-article")).toBeVisible();
    await expect(page.locator("#reels-shortcut")).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/still-pro-active/);
  } else {
    await expect(page.locator("#reel-article")).toHaveCount(0);
    await expect(page.locator("#reels-shortcut")).toBeHidden();
    await expect(page.locator("html")).toHaveClass(/still-pro-active/);
  }
});

test("facebook: Pro user removes a Reel article + hides the Reels shortcut, keeps a normal post", async ({ context, extensionId }) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/");

  await expect(page.locator("#reel-article")).toHaveCount(0);
  await expect(page.locator("#keep-article")).toBeVisible();
  await expect(page.locator("#reels-shortcut")).toBeHidden();
  // The shortcut as Facebook addresses it: a query-string address no address selector reaches, so
  // its exact accessible name is the only thing hiding it.
  await expect(page.locator("#reels-shortcut-by-label")).toBeHidden();
  // A Page whose name starts with the letters "reel" is not a Reel.
  await expect(page.locator("#keep-lookalike-article")).toBeVisible();
  await expect(page.locator("#keep-menu-lookalike")).toBeVisible();
  await expect(page.locator("#keep-menu-home")).toBeVisible();
});

// A person named Reels is not a Reel. Facebook's people directory lists everyone whose name
// contains the word, and each result's photo link carries that name as its accessible name, so a
// rule that hid any link labelled with the word took 24 of the 25 photos with it.
test("facebook people directory: profiles of people named Reels keep their photos", async ({
  context,
  extensionId,
}) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/public/reels");

  await expect(page.locator("#still-placeholder")).toHaveCount(0);
  for (const person of ["one", "two", "three"]) {
    await expect(page.locator(`#keep-directory-person-${person}`)).toBeVisible();
    await expect(page.locator(`#keep-directory-photo-${person}`)).toBeVisible();
  }
  // And the genuine shortcut is still hidden on the same page, so this is a narrowing and not a
  // switching-off.
  await expect(page.locator("#reels-shortcut-by-label")).toBeHidden();
});

test("facebook page: the Reels tab goes, the other Page tabs stay", async ({ context, extensionId }) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/stillapp");

  // Every Page carries a Reels tab. It was only ever hidden by accident, by an Instagram rule that
  // used to load on Facebook, so scoping the packaged stylesheets by service brought it back.
  await expect(page.locator("#page-reels-tab")).toBeHidden();

  await expect(page.locator("#keep-page-posts-tab")).toBeVisible();
  await expect(page.locator("#keep-page-photos-tab")).toBeVisible();
  // The rule keys on the tab, not on the word: an ordinary link to a Page called "reels_tab" stays.
  // Assert on the link itself, because the list item around it keeps its box either way.
  await expect(page.locator("#keep-menu-reels-tab-page a")).toBeVisible();
});

// Facebook's own sections live in the first path segment, so "/<name>/reels" is a Page's Reels tab
// only when <name> is a Page. facebook.com/groups/reels is a live group that auctions fishing rods,
// reels and tackle, facebook.com/hashtag/reels is the hashtag feed, and facebook.com/public/reels
// is the people directory, which lists everyone whose name contains "Reels". None is short-form
// video, and all three load without an account.
test("facebook: a Facebook section whose address ends in the word reels is not a Reels tab", async ({
  context,
  extensionId,
}) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));

  for (const path of [
    "/groups/reels",
    "/groups/reels/",
    "/hashtag/reels",
    "/marketplace/reels",
    "/gaming/reels",
    "/events/reels",
    "/pages/reels",
    "/people/reels",
    "/stories/reels",
    "/help/reels",
    "/business/reels",
    "/settings/reels",
    "/public/reels",
  ]) {
    await page.goto(`https://www.facebook.com${path}`);
    await expect(page.locator("#still-placeholder")).toHaveCount(0);
    await expect(page.locator("#keep-section-page")).toBeVisible();
    await expect(page.locator("#keep-section-title")).toBeVisible();
    await expect(page.locator("#keep-section-post")).toBeVisible();
  }

  // A Page's Reels tab is still covered, including a Page whose vanity name merely begins with the
  // name of a section, and a Page addressed by its numeric id.
  for (const path of [
    "/stillapp/reels/",
    "/groupsofpeople/reels",
    "/100064860875397/reels",
    // "watch" is not a reserved word, so the general "<name>/reels" alternative covers Facebook's
    // own Reels feed without the pattern naming it.
    "/watch/reels",
  ]) {
    await page.goto(`https://www.facebook.com${path}`);
    await expect(page.locator("#still-placeholder")).toBeVisible();
  }
});

test("facebook mobile: Pro user blocks Reels routes and removes mobile Reels sections", async ({ context, extensionId }) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook-mobile.html"));

  await page.goto("https://m.facebook.com/");
  await expect(page.locator("#fb-mobile-reel")).toHaveCount(0);
  await expect(page.locator("#fb-mobile-post")).toBeVisible();
  await expect(page.locator("#fb-mobile-reels")).toBeHidden();
  await expect(page.locator("#keep-fb-mobile-lookalike")).toBeVisible();
  // The tab node keeps its slot in the tablist so the bar does not gain a grey gap (issue #58);
  // only its contents are hidden.
  await expect(page.locator("#fb-mobile-reels-tab")).toHaveCount(1);
  await expect(page.locator("#fb-mobile-reels-tab span")).toBeHidden();
  await expect(page.locator("#keep-fb-mobile-home-tab")).toBeVisible();

  await page.goto("https://m.facebook.com/watch/reels/");
  await expect(page.locator("#still-placeholder")).toBeVisible();

  // Where the Page's hidden Reels tab leads. Typing the address reached it before.
  await page.goto("https://m.facebook.com/stillapp/reels/");
  await expect(page.locator("#still-placeholder")).toBeVisible();

  // A Page's other sections are long-form video and photos, which Still leaves alone.
  await page.goto("https://m.facebook.com/stillapp/videos");
  await expect(page.locator("#still-placeholder")).toHaveCount(0);
  await expect(page.locator("#fb-mobile-post")).toBeVisible();

  // And a Facebook section whose address ends in the word reels is not a Page's Reels tab.
  await page.goto("https://m.facebook.com/groups/reels");
  await expect(page.locator("#still-placeholder")).toHaveCount(0);
  await expect(page.locator("#fb-mobile-post")).toBeVisible();
});

test("tiktok: free-user whole-site blocking follows the paid-tier switch", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.tiktok.com/**", fixture("tiktok.html"));
  await page.goto("https://www.tiktok.com/foryou");

  if (PAID_TIER_ENABLED) {
    await expect(page.locator("#still-placeholder")).toHaveCount(0);
    await expect(page.locator("#tiktok-feed")).toBeVisible();
  } else {
    await expect(page.locator("#still-placeholder")).toBeVisible();
    await expect(page.locator("#tiktok-feed")).toHaveCount(0);
  }
});

test("tiktok: Pro user gets the Still placeholder", async ({ context, extensionId }) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.tiktok.com/**", fixture("tiktok.html"));
  await page.goto("https://www.tiktok.com/foryou");

  await expect(page.locator("#still-placeholder")).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
});

test("tiktok mobile: Pro user gets the Still placeholder on m.tiktok.com", async ({ context, extensionId }) => {
  await setEntitled(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, "**://*.tiktok.com/**", fixture("tiktok.html"));
  await page.goto("https://m.tiktok.com/foryou");

  await expect(page.locator("#still-placeholder")).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
});
