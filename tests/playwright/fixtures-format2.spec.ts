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

// Configured (2.x store-style) builds keep the legacy settings document until the modern settings
// rollout, so they never run the format-2 lane; configured-lane.spec.ts pins that instead.
const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
test.skip(
  syncConfigured,
  "Format-2 lane needs committed schema-2 settings; configured builds stay on the legacy lane",
);

test.use({ settingsProfile: "modern" });

async function serve(page: Page, domainGlob: string, html: string): Promise<void> {
  await page.route(domainGlob, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
}

/**
 * The real options page's master switch: a committed Off/On through the shipped authority. Each
 * toggle resolves once the switch shows the new choice. The switch shows only saved choices, and
 * the background saves an Off only after the navigation rules it switches off are gone, so a page
 * opened after that is never redirected. Clicking alone is not enough: a page opened the moment
 * after the click can race the save itself, exactly as a person cannot outrun their own click.
 */
async function stillSwitch(context: BrowserContext, extensionId: string) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const control = options.getByRole("switch", { name: /^(Still|Still on\/off)$/, exact: true });
  return async () => {
    await expect(control).toBeEnabled();
    const next = (await control.getAttribute("aria-checked")) === "true" ? "false" : "true";
    await control.click();
    await expect(control).toHaveAttribute("aria-checked", next);
  };
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
  ["instagram current desktop menu and profile", "instagram-profile.html", "https://www.instagram.com/someuser/",
    ["#menu-reels", "#profile-reels-tab-slot", "#grid-reel-1", "#grid-reel-2", "#grid-reel-3", "#grid-reel-4",
      "#grid-reel-5", "#grid-reel-6"], null],
] as const;

for (const [name, file, url, targets, keep] of instagram)
  test(`format-2 ${name}: Reels hidden and retained, ordinary posts stay whole, Off restores`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await serve(page, "**://*.instagram.com/**", fixture(file));
    await page.goto(url);
    await expectFormat2Lane(page);
    await expectHiddenRetainedReversible(page, context, extensionId, targets, keep ?? (await keepAll(page)));
  });

/** Each tile's box, in document order, for the tiles that are laid out. */
const tileBoxes = (page: Page) =>
  page.locator("#profile-grid > div > div").evaluateAll((tiles) =>
    tiles.map((tile) => tile.getBoundingClientRect()).filter((box) => box.width > 0)
      .map(({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })));

test("format-2 instagram profile: the grid closes up without holes, the tab row and menu close up, Off restores", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram-profile.html"));
  await page.goto("https://www.instagram.com/someuser/");
  await expectFormat2Lane(page);
  const grid = await page.locator("#profile-grid").boundingBox();
  const expectClosedUp = async () => {
    const boxes = await tileBoxes(page);
    // Six posts remain, three to a line, every tile the same size as an untouched one: no hole and
    // no stretched neighbour.
    expect(boxes).toHaveLength(6);
    const { width, height } = boxes[0]!;
    expect(Math.abs(width - (grid!.width - 2) / 3)).toBeLessThanOrEqual(1);
    expect(Math.abs(height - (width * 4) / 3)).toBeLessThanOrEqual(1);
    boxes.forEach((box, index) => {
      expect(box.width, `tile ${index}`).toBe(width);
      expect(box.height, `tile ${index}`).toBe(height);
      expect(Math.abs(box.x - (boxes[index % 3]!.x)), `tile ${index} column`).toBeLessThanOrEqual(0);
      expect(Math.abs(box.y - (boxes[0]!.y + Math.floor(index / 3) * (height + 1))), `tile ${index} line`).toBeLessThanOrEqual(1);
    });
    // The remaining posts keep their order.
    expect(await page.locator("#profile-grid > div > div").evaluateAll((tiles) =>
      tiles.filter((tile) => tile.getBoundingClientRect().width > 0).map((tile) => tile.id)))
      .toEqual(["keep-tile-1", "keep-tile-2", "keep-tile-3", "keep-tile-4", "keep-tile-5", "keep-tile-6"]);
    // Posts and Tagged sit side by side; the menu keeps one item's pitch from Home to Messages.
    const posts = (await page.locator("#keep-tab-posts").boundingBox())!;
    const tagged = (await page.locator("#keep-tab-tagged").boundingBox())!;
    expect(tagged.x - (posts.x + posts.width)).toBeLessThan(10);
    const home = (await page.locator("#keep-menu-home").boundingBox())!;
    const messages = (await page.locator("#keep-menu-messages").boundingBox())!;
    expect(messages.y - home.y).toBe(56);
  };
  await expectClosedUp();
  // The profile mark comes from the address, and follows in-app moves off and back onto a profile.
  await expect(page.locator("html")).toHaveAttribute("data-still-instagram-profile", "");
  await page.evaluate(() => history.pushState(null, "", "/explore/"));
  await expect(page.locator("html")).not.toHaveAttribute("data-still-instagram-profile");
  await expect.poll(async () => (await tileBoxes(page)).length).toBe(12); // Instagram's own layout
  await page.evaluate(() => history.pushState(null, "", "/someuser/"));
  await expect(page.locator("html")).toHaveAttribute("data-still-instagram-profile", "");
  await expectClosedUp();
  const toggle = await stillSwitch(context, extensionId);
  await toggle();
  // Off: Instagram's own layout, all twelve tiles in four rows of three.
  await expect.poll(async () => (await tileBoxes(page)).length).toBe(12);
  await expect(page.locator("#profile-reels-tab")).toBeVisible();
  await expect(page.locator("#menu-reels")).toBeVisible();
  await toggle();
  await expect.poll(async () => (await tileBoxes(page)).length).toBe(6);
  await expectClosedUp();
});

test("format-2 instagram routes: the Reels feed goes home, a profile's Reels tab opens the profile; profiles and shared Reels stay usable", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram-mobile.html"));
  await page.goto("https://www.instagram.com/reels/");
  await expect(page).toHaveURL("https://www.instagram.com/");
  await page.goto("https://www.instagram.com/someuser/reels/").catch(() => {}); // replaced while loading
  await expect(page).toHaveURL("https://www.instagram.com/someuser/");
  for (const path of ["/someuser/reel/ABC123/", "/someuser/", "/someuser/tagged/"]) {
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
  for (const feed of ["/reels/", "/watch/reels", "/watch/reels/", "/watch/reels/?ref=bookmarks",
    // The top-menu Reels tab's feed entry and the player's own feeds (ISS-0035).
    "/reel/?s=tab", "/reel/", "/reel/following/", "/reel/profile/"]) {
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

// Facebook's current desktop navigation (ISS-0035): the top menu and the left sidebar are
// div[role="navigation"] lists whose Reels entry opens /reel/?s=tab, the Reels feed.
test("format-2 facebook navigation: the top-menu Reels tab and the sidebar shortcut go; every other entry stays", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook-nav.html"));
  await page.goto("https://www.facebook.com/");
  await expectFormat2Lane(page);
  // The remaining entries close up: no empty slot is left where the Reels entry was.
  const slots = await page.evaluate(() => ({
    top: [...document.querySelectorAll("#top-menu > li")].filter((li) => li.getBoundingClientRect().height > 0).length,
    side: [...document.querySelectorAll("#sidebar > li")].filter((li) => li.getBoundingClientRect().height > 0).length,
  }));
  expect(slots).toEqual({ top: 4, side: 11 });
  await expectHiddenRetainedReversible(
    page, context, extensionId,
    ["#top-reels-item", "#sidebar-reels-item", "#player-for-you", "#player-following", "#player-profile"],
    await keepAll(page),
  );
});

test("format-2 facebook: clicking the Reels tab goes home instead of opening the Reels player; Off lets it through", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook-nav.html"));
  // Facebook's router, as recorded: a click on the tab pushes /reel/?s=tab, then replaces it with
  // the first Reel of the feed. The tab is forced visible so a person can click it, as if the
  // hide had not matched, which is exactly the bypass the owner found. With Still on, the click
  // itself is caught before this router runs; the next test drives the router's push-then-replace
  // directly.
  const openReelsTab = async () => {
    await page.evaluate(() => {
      const tab = document.createElement("a");
      tab.id = "forced-reels-tab";
      tab.href = "https://www.facebook.com/reel/?s=tab";
      tab.textContent = "Reels";
      tab.setAttribute("style", "display:block !important; padding:20px");
      tab.addEventListener("click", (event) => {
        event.preventDefault();
        history.pushState(null, "", "/reel/?s=tab");
        setTimeout(() => history.replaceState(null, "", "/reel/1234567890123456/"), 50);
      });
      document.body.prepend(tab);
    });
    await page.locator("#forced-reels-tab").click();
  };
  await page.goto("https://www.facebook.com/groups/chosen/");
  await expectFormat2Lane(page);
  await openReelsTab();
  await expect(page).toHaveURL("https://www.facebook.com/");
  await page.waitForTimeout(300); // Facebook's delayed hand-over to the first Reel never lands
  await expect(page).toHaveURL("https://www.facebook.com/");

  const toggle = await stillSwitch(context, extensionId);
  await toggle();
  await page.goto("https://www.facebook.com/groups/chosen/");
  await openReelsTab();
  await expect(page).toHaveURL("https://www.facebook.com/reel/1234567890123456/");
  await expect(page.locator("#player-for-you")).toBeVisible();
});

// No click to catch: Facebook's own script pushes the feed entry, then hands over to its first
// Reel 50 ms later. On Home the push is stopped where it stands, and the hand-over that follows
// is judged from the stopped entry, so the Reel never takes over the address.
test("format-2 facebook: the router's own push-then-replace into the Reels player stays Home; Off lets it through", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook-nav.html"));
  const routeToReels = (entry: string) => page.evaluate((entry) => new Promise<string[]>((resolve) => {
    const seen: string[] = [];
    try { history.pushState(null, "", entry); } catch { /* a stopped push may throw */ }
    seen.push(location.pathname);
    setTimeout(() => {
      try { history.replaceState(null, "", "/reel/1234567890123456/"); } catch { /* stopped */ }
      seen.push(location.pathname);
      resolve(seen);
    }, 50);
  }), entry);
  // The tab's entry, and the two feeds a typed address reaches (ISS-0039).
  const entries = ["/reel/?s=tab", "/reels/", "/watch/reels/"];
  await page.goto("https://www.facebook.com/");
  await expectFormat2Lane(page);
  for (const entry of entries) {
    expect(await routeToReels(entry), entry).toEqual(["/", "/"]);
    await page.waitForTimeout(300);
    await expect(page, entry).toHaveURL("https://www.facebook.com/");
  }

  const toggle = await stillSwitch(context, extensionId);
  await toggle();
  for (const entry of entries) {
    await page.goto("https://www.facebook.com/");
    expect(await routeToReels(entry), entry).toEqual([new URL(entry, "https://x.invalid").pathname, "/reel/1234567890123456/"]);
  }
});

test("format-2 facebook: a shared Reel still opens and plays; its player's feed links are hidden", async ({ context }) => {
  const page = await context.newPage();
  await serve(page, "**://*.facebook.com/**", fixture("facebook-nav.html"));
  await page.goto("https://www.facebook.com/reel/1234567890123456/");
  await expectFormat2Lane(page);
  await expect(page).toHaveURL("https://www.facebook.com/reel/1234567890123456/");
  await expect(page.locator("#still-placeholder")).toHaveCount(0);
  await expect(page.locator("#keep-reel-player")).toBeVisible();
  for (const id of ["#player-for-you", "#player-following", "#player-profile"]) await expect(page.locator(id), id).toBeHidden();
  // Opening another shared Reel from a message is a deliberate click and is not stopped.
  await page.goto("https://www.facebook.com/messages/t/1/");
  await page.locator("#keep-shared-reel").click();
  await expect(page).toHaveURL("https://www.facebook.com/reel/1234567890123456/");
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

// ── Reel viewers (plural feed viewer goes home; a shared Reel opens but does not continue) ─────

/** A hand-written single-page viewer: the page itself pushes the next Reel, like a swipe. */
const viewer = (next: string, pushed = next, delayMs = 0) => `<!doctype html><html><head><title>viewer</title></head><body>
  <main id="keep-viewer">One Reel playing</main>
  <a id="deliberate" href="${next}">Open another Reel</a>
  <script>
    document.getElementById("deliberate").addEventListener("click", (event) => {
      event.preventDefault(); // the site routes the click itself, as single-page apps do
      setTimeout(() => history.pushState(null, "", ${JSON.stringify(pushed)}), ${delayMs});
    });
    window.swipe = (to) => history.pushState(null, "", to);
  </script></body></html>`;

async function serveViewer(page: Page, domainGlob: string, next: string, pushed = next, delayMs = 0) {
  await page.route(domainGlob, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: viewer(next, pushed, delayMs) }),
  );
}

async function commitIntent(context: BrowserContext, extensionId: string, path: string, value: boolean) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const reply = await options.evaluate(
    ({ path, value }) =>
      (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } } }).chrome.runtime
        .sendMessage({ kind: "still:settings-intent", path, value, updatedAt: Date.now() }),
    { path, value },
  );
  expect(reply).toMatchObject({ status: "committed" });
  await options.close();
}

test("format-2 instagram: the plural /reels/<code>/ viewer opens that Reel at /reel/<code>/; a shared /reel/<code>/ opens", async ({ context }) => {
  const page = await context.newPage();
  await serveViewer(page, "**://*.instagram.com/**", "/reel/B2/");
  await page.goto("https://www.instagram.com/reels/C0de1/?igsh=share").catch(() => {}); // replaced while loading
  await expect(page).toHaveURL("https://www.instagram.com/reel/C0de1/?igsh=share");
  await page.goto("https://www.instagram.com/reels/").catch(() => {});
  await expect(page).toHaveURL("https://www.instagram.com/");
  for (const shared of ["/reel/A1/", "/some.user/reel/A1/"]) {
    await page.goto(`https://www.instagram.com${shared}`);
    await expect(page.locator("html")).toHaveClass(/still-feature-\d+-instagram-reels/);
    await expect(page).toHaveURL(`https://www.instagram.com${shared}`);
    await expect(page.locator("#keep-viewer")).toBeVisible();
  }
});

for (const [service, origin, swipes, home] of [
  ["instagram", "https://www.instagram.com/reel/A1/", ["/reels/B2/", "/reel/B2/"], "https://www.instagram.com/"],
  ["facebook", "https://www.facebook.com/reel/111", ["/reel/222"], "https://www.facebook.com/"],
] as const)
  test(`format-2 ${service}: a shared Reel opens, but the viewer continuing into another Reel is stopped`, async ({ context }) => {
    for (const swipe of swipes) {
      const page = await context.newPage();
      await serveViewer(page, `**://*.${service}.com/**`, swipe);
      await page.goto(origin);
      await expect(page.locator("html")).toHaveClass(new RegExp(`still-feature-\\d+-${service}-reels`));
      await expect(page).toHaveURL(origin); // the deliberately opened Reel stays
      await page.evaluate((to) => (window as unknown as { swipe(to: string): void }).swipe(to), swipe);
      await expect(page, swipe).toHaveURL(home);
      await page.goBack();
      await expect(page).toHaveURL(origin); // Back returns to the Reel that was opened
      await page.close();
    }
  });

for (const [service, origin, next] of [
  ["instagram", "https://www.instagram.com/reel/A1/", "/reel/B2/"],
  ["facebook", "https://www.facebook.com/reel/111", "/reel/222"],
] as const)
  test(`format-2 ${service}: deliberately clicking another Reel opens it`, async ({ context }) => {
    const page = await context.newPage();
    await serveViewer(page, `**://*.${service}.com/**`, next);
    await page.goto(origin);
    await expect(page.locator("html")).toHaveClass(new RegExp(`still-feature-\\d+-${service}-reels`));
    await page.locator("#deliberate").click(); // a trusted click; the site pushes the URL itself
    await expect(page).toHaveURL(new URL(next, origin).href);
    await expect(page.locator("#keep-viewer")).toBeVisible();
  });

for (const [service, origin, swipe] of [
  ["instagram", "https://www.instagram.com/reel/A1/", "/reel/B2/"],
  ["facebook", "https://www.facebook.com/reel/111", "/reel/222"],
] as const)
  for (const level of ["globalOn", `services.${service}`, `sites.${service}.reels`])
    test(`format-2 ${service}: Off at ${level} leaves Reel viewers alone`, async ({ context, extensionId }) => {
      await commitIntent(context, extensionId, level, false);
      const page = await context.newPage();
      await serveViewer(page, `**://*.${service}.com/**`, swipe);
      if (service === "instagram") {
        await page.goto("https://www.instagram.com/reels/C0de1/");
        await expect(page).toHaveURL("https://www.instagram.com/reels/C0de1/");
      }
      await page.goto(origin);
      await expect(page.locator("html")).not.toHaveClass(/still-feature-/);
      await page.evaluate((to) => (window as unknown as { swipe(to: string): void }).swipe(to), swipe);
      await expect(page).toHaveURL(new URL(swipe, origin).href);
      await expect(page.locator("#still-placeholder")).toHaveCount(0);
      await commitIntent(context, extensionId, level, true);
      await page.goto(origin);
      await expect(page.locator("html")).toHaveClass(new RegExp(`still-feature-\\d+-${service}-reels`));
      await page.evaluate((to) => (window as unknown as { swipe(to: string): void }).swipe(to), swipe);
      await expect(page).toHaveURL(new URL("/", origin).href); // On again: continuation stopped
    });

test("format-2 instagram: a link click still counts when the site pushes its route 2 s later", async ({ context }) => {
  const page = await context.newPage();
  await serveViewer(page, "**://*.instagram.com/**", "/reel/B2/", "/reel/B2/", 2_000);
  await page.goto("https://www.instagram.com/reel/A1/");
  await expect(page.locator("html")).toHaveClass(/still-feature-\d+-instagram-reels/);
  await page.locator("#deliberate").click();
  await expect(page).toHaveURL("https://www.instagram.com/reel/B2/", { timeout: 5_000 });
  await page.waitForTimeout(500);
  await expect(page).toHaveURL("https://www.instagram.com/reel/B2/");
});

test("format-2 instagram: a link click to one Reel does not cover the page pushing a different one", async ({ context }) => {
  const page = await context.newPage();
  await serveViewer(page, "**://*.instagram.com/**", "/reel/B2/", "/reel/C3/", 100);
  await page.goto("https://www.instagram.com/reel/A1/");
  await expect(page.locator("html")).toHaveClass(/still-feature-\d+-instagram-reels/);
  await page.locator("#deliberate").click();
  await expect(page).toHaveURL("https://www.instagram.com/");
});

test("format-2 instagram: one Reel opened from a profile plays, but its modal moving on to the next Reel returns to the profile", async ({ context }) => {
  const page = await context.newPage();
  await serveViewer(page, "**://*.instagram.com/**", "/some.user/reel/B2/");
  await page.goto("https://www.instagram.com/some.user/reel/A1/");
  await expect(page.locator("html")).toHaveClass(/still-feature-\d+-instagram-reels/);
  await expect(page).toHaveURL("https://www.instagram.com/some.user/reel/A1/"); // the one Reel stays
  await expect(page.locator("#keep-viewer")).toBeVisible();
  await page.evaluate(() => (window as unknown as { swipe(to: string): void }).swipe("/some.user/reel/B2/"));
  await expect(page).toHaveURL("https://www.instagram.com/some.user/");
});

// ── Instagram Explore (ISS-0038) ────────────────────────────────────────────────────────────────

test("format-2 instagram explore: Reel tiles go, the other posts close up four to a line, Off restores", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await serve(page, "**://*.instagram.com/**", fixture("instagram-explore.html"));
  await page.goto("https://www.instagram.com/explore/");
  await expectFormat2Lane(page);
  await expect(page.locator("html")).toHaveAttribute("data-still-instagram-explore", "");
  const boxes = () => page.locator("#explore-grid > div > div").evaluateAll((tiles) =>
    tiles.map((tile) => ({ id: tile.id, box: tile.getBoundingClientRect() })).filter(({ box }) => box.width > 0)
      .map(({ id, box }) => ({ id, x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) })));
  const expectClosedUp = async () => {
    const tiles = await boxes();
    // Six posts, in order, four to a line at the rows' own tile size: no Reel and no hole.
    expect(tiles.map((tile) => tile.id)).toEqual(["keep-explore-1", "keep-explore-2", "keep-explore-3", "keep-explore-4", "keep-explore-5", "keep-explore-6"]);
    tiles.forEach((tile, index) => {
      expect(tile.width, tile.id).toBe(tiles[0]!.width);
      expect(tile.height, tile.id).toBe(tiles[0]!.height);
      expect(tile.x, tile.id).toBe(tiles[index % 4]!.x);
      expect(Math.abs(tile.y - (tiles[0]!.y + Math.floor(index / 4) * (tiles[0]!.height + 1))), tile.id).toBeLessThanOrEqual(1);
    });
    expect(new Set(tiles.slice(0, 4).map((tile) => tile.x)).size).toBe(4);
  };
  await expectClosedUp();
  // A tile opened over Explore (/p/<code>/) keeps the mark: the grid behind the viewer stays closed up.
  await page.evaluate(() => history.pushState(null, "", "/p/ExPost0001/"));
  await page.waitForTimeout(300);
  await expect(page.locator("html")).toHaveAttribute("data-still-instagram-explore", "");
  await expectClosedUp();
  await page.evaluate(() => history.pushState(null, "", "/explore/"));
  // Leaving for any other page clears it.
  await page.evaluate(() => history.pushState(null, "", "/"));
  await expect(page.locator("html")).not.toHaveAttribute("data-still-instagram-explore");
  await page.evaluate(() => history.pushState(null, "", "/explore/"));
  await expect(page.locator("html")).toHaveAttribute("data-still-instagram-explore", "");
  const toggle = await stillSwitch(context, extensionId);
  await toggle();
  await expect.poll(async () => (await boxes()).length).toBe(16); // Instagram's own grid, Reels and all
  await toggle();
  await expect.poll(async () => (await boxes()).length).toBe(6);
  await expectClosedUp();
});

/**
 * Instagram's post viewer as Explore opens it: a dialog whose Next arrow is a button. With
 * `drawFirst`, the arrow draws the next item (a post) before it changes the address, so at the
 * moment of the move the page no longer shows the item being left.
 */
const postViewer = (code: string, kind: "reel" | "p", next: string, drawFirst = false) => `<!doctype html><html><head><title>viewer</title></head><body>
  <main id="keep-explore">Explore</main>
  <div role="dialog"><article id="keep-viewer"><a href="/someuser/">someuser</a><a id="item" href="/someuser/${kind}/${code}/">2d</a>
    <button type="button" id="next" aria-label="Next">›</button></article></div>
  <script>
    document.getElementById("next").addEventListener("click", () => {
      if (${drawFirst}) document.getElementById("item").setAttribute("href", "/someuser/p/B2/");
      history.pushState(null, "", ${JSON.stringify(next)});
    });
  </script></body></html>`;

for (const [kind, drawFirst, expected] of [
  ["reel", false, "https://www.instagram.com/"],
  ["reel", true, "https://www.instagram.com/"],
  ["p", false, "https://www.instagram.com/p/B2/"],
] as const)
  test(`format-2 instagram explore viewer: Next from a ${kind === "reel" ? "Reel goes Home" : "post opens the next item (the first Reel may play)"}${drawFirst ? ", even when the next item is drawn before the address changes" : ""}`, async ({ context }) => {
    const page = await context.newPage();
    await page.route("**://*.instagram.com/**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: postViewer("A1", kind, "/p/B2/", drawFirst) }));
    await page.goto("https://www.instagram.com/p/A1/");
    await expect(page.locator("html")).toHaveClass(/still-feature-\d+-instagram-reels/);
    await expect(page).toHaveURL("https://www.instagram.com/p/A1/"); // the opened item stays
    await page.locator("#next").click(); // a trusted click on the viewer's own arrow: the page moves
    await expect(page).toHaveURL(expected);
    if (kind === "p") {
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(expected);
    }
  });
