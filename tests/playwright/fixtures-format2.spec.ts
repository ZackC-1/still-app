import { test, expect, fixture } from "./_extension.js";
import type { BrowserContext, Page } from "@playwright/test";

// The format-2 lane's contract on the shipped Chromium build, against the same hand-written
// fixtures as fixtures.spec.ts (which pins the legacy lane with a schema-1 profile). Here the
// background has committed schema-2 settings, as on a fresh install of an unconfigured build, so
// YouTube, Instagram and Facebook pages run the packaged format-2 rules.
//
// The format-2 contract differs from the legacy one in three deliberate ways: targets are hidden
// by a scoped stylesheet and stay in the page (renderer-owned nodes are never removed); the page
// carries an owned feature class instead of the legacy still-active/still-service/still-pro
// markers; and no Instagram/Facebook route is replaced by a placeholder. Every case therefore
// asserts the target is hidden AND still attached, ordinary content stays visible, and turning
// Still off restores the target (then on hides it again).

test.use({ settingsProfile: "modern" });

async function serve(page: Page, domainGlob: string, html: string): Promise<void> {
  await page.route(domainGlob, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
}

/** The real options page's master switch: a committed Off/On through the shipped authority. */
async function stillSwitch(context: BrowserContext, extensionId: string) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  return () =>
    options.getByRole("switch", { name: /^(Still|Still on\/off)$/, exact: true }).click();
}

async function expectFormat2Lane(page: Page) {
  await expect(page.locator("html")).toHaveClass(/still-feature-\d+-(youtube-shorts|instagram-reels|facebook-reels)/);
  await expect(page.locator("html")).not.toHaveClass(/(^|\s)still-(active|pro-active|service-)/);
  await expect(page.locator("#still-placeholder")).toHaveCount(0);
}

/** Hidden, still attached, and restored by Off then re-hidden by On; ordinary content stays. */
async function expectHiddenRetainedReversible(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  targets: readonly string[],
  keep: readonly string[],
) {
  for (const id of targets) {
    await expect(page.locator(id), id).toHaveCount(1);
    await expect(page.locator(id), id).toBeHidden();
  }
  for (const id of keep) await expect(page.locator(id), id).toBeVisible();
  const toggle = await stillSwitch(context, extensionId);
  await toggle();
  for (const id of targets) await expect(page.locator(id), `${id} after Off`).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/still-feature-/);
  for (const id of keep) await expect(page.locator(id), `${id} after Off`).toBeVisible();
  await toggle();
  for (const id of targets) await expect(page.locator(id), `${id} after On`).toBeHidden();
  for (const id of keep) await expect(page.locator(id), `${id} after On`).toBeVisible();
}

const keepAll = async (page: Page) =>
  (await page.locator('[id^="keep-"]').evaluateAll((nodes) => nodes.map((node) => `#${node.id}`)));

// ── YouTube ─────────────────────────────────────────────────────────────────────────────────────

const youtube = [
  ["youtube home and subscriptions", "youtube.html", "https://www.youtube.com/feed/subscriptions",
    ["#shelf", "#rich-shorts-section", "#subs-shorts-shelf", "#endpoint", "#shorts-mini-guide", "#shorts-chip"]],
  ["youtube search", "youtube-search.html", "https://www.youtube.com/results?search_query=shorts",
    ["#shorts-shelf", "#shorts-result"]],
  ["youtube channel", "youtube-channel.html", "https://www.youtube.com/@YouTube",
    ["#shorts-tab", "#shorts-tab-legacy", "#channel-shorts-shelf"]],
  ["youtube watch", "youtube-watch.html", "https://www.youtube.com/watch?v=long123",
    ["#watch-shorts-shelf", "#watch-mobile-short"]],
  ["m.youtube.com home", "youtube-mobile.html", "https://m.youtube.com/",
    ["#shorts-tab", "#shorts-tab-by-href", "#mobile-shorts-section", "#mobile-reel-shelf-section", "#mobile-loose-short", "#mobile-shorts-card"]],
  ["m.youtube.com search", "youtube-mobile-search.html", "https://m.youtube.com/results?search_query=shorts",
    ["#mobile-shorts-shelf", "#mobile-shorts-result"]],
  ["m.youtube.com channel", "youtube-mobile-channel.html", "https://m.youtube.com/@YouTube",
    ["#mobile-shorts-tab", "#mobile-channel-shorts-shelf"]],
] as const;

for (const [name, file, url, targets] of youtube)
  test(`format-2 ${name}: Shorts hidden and retained, ordinary content stays, Off restores`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await serve(page, "**://*.youtube.com/**", fixture(file));
    await page.goto(url);
    await expectFormat2Lane(page);
    await expectHiddenRetainedReversible(page, context, extensionId, targets, await keepAll(page));
  });

test("format-2 m.youtube.com watch: the related Shorts go, the up-next rail stays", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.youtube.com/**", fixture("youtube-watch.html").replace("<body>", "<body><ytm-app>").replace("</body>", "</ytm-app></body>"));
  await page.goto("https://m.youtube.com/watch?v=long123");
  await expectFormat2Lane(page);
  await expectHiddenRetainedReversible(page, context, extensionId, ["#watch-mobile-short"], ["#keep-mobile-rail", "#keep-mobile-next"]);
});

for (const host of ["www", "m"] as const)
  test(`format-2 ${host}.youtube.com: a Shorts URL ends up on the watch page`, async ({ context }) => {
    const page = await context.newPage();
    await page.route("**://*.youtube.com/**", (route) => {
      const body = route.request().url().includes("/watch")
        ? "<!doctype html><title>watch</title>watch"
        : fixture(host === "m" ? "youtube-mobile.html" : "youtube.html");
      return route.fulfill({ contentType: "text/html; charset=utf-8", body });
    });
    await page.goto(`https://${host}.youtube.com/shorts/abc123`);
    // Chromium's DNR rule may land on www for an m. Shorts URL, exactly as on the legacy lane.
    await expect(page).toHaveURL(/\/watch\?v=abc123$/);
  });

// ── Instagram ───────────────────────────────────────────────────────────────────────────────────

const instagram = [
  ["instagram profile", "instagram.html", "https://www.instagram.com/someuser/",
    ["#reel-post", "#reels-link", "#profile-reel-tile"], ["#keep-post", "#keep-profile-post-tile", "#keep-profile-lookalike"]],
  ["instagram home feed", "instagram-home.html", "https://www.instagram.com/",
    ["#reel-post", "#reel-post-with-hashtags", "#nav-reels"], null],
  ["instagram mobile", "instagram-mobile.html", "https://www.instagram.com/",
    ["#ig-mobile-reel", "#ig-mobile-reels"], ["#ig-mobile-post"]],
] as const;

for (const [name, file, url, targets, keep] of instagram)
  test(`format-2 ${name}: Reels hidden and retained, ordinary posts stay whole, Off restores`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await serve(page, "**://*.instagram.com/**", fixture(file));
    await page.goto(url);
    await expectFormat2Lane(page);
    await expectHiddenRetainedReversible(page, context, extensionId, targets, keep ?? (await keepAll(page)));
  });

test("format-2 instagram routes: the Reels feed goes home; profiles and shared Reels stay usable", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram-mobile.html"));
  await page.goto("https://www.instagram.com/reels/");
  await expect(page).toHaveURL("https://www.instagram.com/");
  for (const path of ["/someuser/reels/", "/someuser/reel/ABC123/", "/someuser/"]) {
    await page.goto(`https://www.instagram.com${path}`);
    await expect(page).toHaveURL(`https://www.instagram.com${path}`);
    await expect(page.locator("#still-placeholder")).toHaveCount(0);
    await expect(page.locator("#ig-mobile-post")).toBeVisible();
    // Entry points into Reels on the same page are still hidden.
    await expect(page.locator("#ig-mobile-reels")).toBeHidden();
    await expect(page.locator("#ig-mobile-reel")).toBeHidden();
  }
});

// ── Facebook ────────────────────────────────────────────────────────────────────────────────────

test("format-2 facebook home: Reel articles, shortcuts and the Reels shelf hidden; every other card stays", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/");
  await expectFormat2Lane(page);
  for (const id of ["reels-shelf", "emptied-reels-shelf", "nested-reels-shelf"]) {
    await expect(page.locator(`#${id}-card`)).toBeHidden();
    await expect(page.locator(`#${id}-header`)).toBeHidden();
  }
  // The measured feed unit keeps a laid-out box of zero height rather than losing its box.
  const unit = await page.evaluate(() => {
    const el = document.querySelector("#reels-shelf-unit")!;
    return { display: getComputedStyle(el).display, height: el.getBoundingClientRect().height };
  });
  expect(unit).toEqual({ display: "block", height: 0 });
  await expectHiddenRetainedReversible(
    page, context, extensionId,
    ["#reel-article", "#reels-shortcut", "#reels-shortcut-by-label", "#reels-shelf-card", "#reels-shelf-more"],
    ["#keep-article", "#keep-lookalike-article", "#keep-menu-lookalike", "#keep-menu-home", "#keep-unit-post",
      "#keep-sponsored-post", "#keep-stories-tray", "#keep-people-shelf-card", "#keep-people-shelf-header",
      "#keep-outer-unit-post", "#keep-shallow-feed-post"],
  );
});

test("format-2 facebook home: a shelf added after load never shows its header", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/");
  await expectFormat2Lane(page);
  const sampled = await page.evaluate(async () => {
    const unit = document.querySelector("#reels-shelf-unit")!.cloneNode(true) as HTMLElement;
    for (const el of unit.querySelectorAll("[id]")) el.removeAttribute("id");
    unit.id = "late-reels-shelf-unit";
    const grid = unit.querySelector('[role="grid"]')!;
    grid.querySelector("[role='row'] > div > div")!.innerHTML =
      '<div role="gridcell"><a role="link" aria-label="Reel by a creator" href="/reel/777/">a late reel</a></div>';
    const header = unit.querySelector("span")!;
    document.querySelector("main")!.append(unit);
    let visibleFrames = 0;
    let frames = 0;
    for (; frames < 30; frames++) {
      if (frames === 15) for (const cell of grid.querySelectorAll('[role="gridcell"]')) cell.remove();
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const box = header.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) visibleFrames++;
    }
    return { frames, visibleFrames };
  });
  expect(sampled.visibleFrames, `Reels header was visible in ${sampled.visibleFrames} of ${sampled.frames} frames`).toBe(0);
  await expect(page.locator("#keep-unit-post")).toBeVisible();
});

test("format-2 facebook page: the Reels tab stays hidden without flickering; other tabs stay", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/stillapp");
  await expectFormat2Lane(page);
  const sampled = await page.evaluate(async () => {
    const tab = document.querySelector<HTMLElement>("#page-reels-tab")!;
    let addressChanges = 0;
    const observer = new MutationObserver((records) => (addressChanges += records.length));
    observer.observe(tab, { attributes: true, attributeFilter: ["href"] });
    let visibleFrames = 0;
    const frames = 40;
    for (let i = 0; i < frames; i++) {
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const box = tab.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) visibleFrames++;
    }
    observer.disconnect();
    return { frames, visibleFrames, addressChanges, href: tab.getAttribute("href") };
  });
  expect(sampled.visibleFrames, `Reels tab was visible in ${sampled.visibleFrames} of ${sampled.frames} frames`).toBe(0);
  expect(sampled.addressChanges, "Facebook's overflow logic is fighting the rule").toBe(0);
  expect(sampled.href).toBe("https://www.facebook.com/stillapp/reels_tab");
  await expectHiddenRetainedReversible(
    page, context, extensionId,
    ["#page-reels-tab", "#page-more-reels"],
    ["#keep-page-posts-tab", "#keep-page-photos-tab", "#keep-page-more-live", "#keep-menu-reels-tab-page a",
      ...["vanity-prefix", "vanity-exact", "group", "external", "query", "ordinary-link"].map((id) => `#keep-more-${id}`)],
  );
});

test("format-2 facebook people directory: profiles of people named Reels keep their photos", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/public/reels");
  await expectFormat2Lane(page);
  await expectHiddenRetainedReversible(
    page, context, extensionId,
    ["#reels-shortcut-by-label"],
    ["one", "two", "three"].flatMap((person) => [`#keep-directory-person-${person}`, `#keep-directory-photo-${person}`]),
  );
});

test("format-2 facebook routes: the Reels feeds go home; sections, Pages and their tabs stay usable", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  for (const feed of ["/reels/", "/watch/reels", "/watch/reels/", "/watch/reels/?ref=bookmarks"]) {
    await page.goto(`https://www.facebook.com${feed}`).catch(() => {}); // replaced while loading
    await expect(page, feed).toHaveURL("https://www.facebook.com/");
  }
  for (const path of ["/groups/reels", "/hashtag/reels", "/public/reels", "/stillapp/reels/", "/100064860875397/reels", "/reel/123/"]) {
    await page.goto(`https://www.facebook.com${path}`);
    await expect(page).toHaveURL(`https://www.facebook.com${path}`);
    await expect(page.locator("#still-placeholder")).toHaveCount(0);
    await expect(page.locator("#keep-section-page")).toBeVisible();
    await expect(page.locator("#keep-section-post")).toBeVisible();
    // Reels entry points and Reel articles on the same page are still hidden.
    await expect(page.locator("#page-reels-tab")).toBeHidden();
    await expect(page.locator("#reel-article")).toBeHidden();
  }
});

test("format-2 facebook mobile: Reels hidden and retained, the tab keeps its slot, Off restores", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook-mobile.html"));
  await page.goto("https://m.facebook.com/");
  await expectFormat2Lane(page);
  await expect(page.locator("#fb-mobile-reels-tab")).toHaveCount(1);
  await expectHiddenRetainedReversible(
    page, context, extensionId,
    ["#fb-mobile-reel", "#fb-mobile-reels", "#fb-mobile-reels-tab span"],
    ["#fb-mobile-post", "#keep-fb-mobile-lookalike", "#keep-fb-mobile-home-tab"],
  );
});

test("format-2 lane never adds a legacy placeholder or root marker without an account or purchase", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram-home.html"));
  await page.goto("https://www.instagram.com/");
  await expectFormat2Lane(page);
  await expect(page.locator("#reel-post")).toBeHidden();
});

test("format-2 facebook: in-app navigation into the Watch Reels feed goes home; Still Off leaves it alone", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook.html"));
  await page.goto("https://www.facebook.com/stillapp");
  await expectFormat2Lane(page);
  await page.evaluate(() => history.pushState(null, "", "/watch/reels/?ref=nav"));
  await expect(page).toHaveURL("https://www.facebook.com/");
  await page.goto("https://m.facebook.com/watch/reels/");
  await expect(page).toHaveURL("https://m.facebook.com/");

  const toggle = await stillSwitch(context, extensionId);
  await toggle();
  await page.goto("https://www.facebook.com/watch/reels/");
  await expect(page.locator("html")).not.toHaveClass(/still-feature-/);
  await expect(page).toHaveURL("https://www.facebook.com/watch/reels/");
  await page.goto("https://www.facebook.com/stillapp");
  await page.evaluate(() => history.pushState(null, "", "/watch/reels/"));
  await expect(page).toHaveURL("https://www.facebook.com/watch/reels/");
  await expect(page.locator("#still-placeholder")).toHaveCount(0);
  await toggle();
  // The content script replaces this navigation while it loads, so goto may report it aborted.
  await page.goto("https://www.facebook.com/watch/reels/").catch(() => {});
  await expect(page).toHaveURL("https://www.facebook.com/");
});
