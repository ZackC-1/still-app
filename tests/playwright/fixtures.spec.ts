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
  // A Page whose name starts with the letters "reel" is not a Reel.
  await expect(page.locator("#keep-lookalike-article")).toBeVisible();
  await expect(page.locator("#keep-menu-lookalike")).toBeVisible();
  await expect(page.locator("#keep-menu-home")).toBeVisible();
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
  await expect(page.locator("#keep-menu-reels-tab-page")).toBeVisible();
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
