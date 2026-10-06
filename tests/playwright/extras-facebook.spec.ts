import type { Page, Worker } from "@playwright/test";
import { createFormat2Test } from "./_format2-extension";
import { extrasFixture } from "../../packages/core/src/rules/__tests__/extras-fixtures.js";

// P5, paid ON through explicit test seams, on the synthetic Facebook extras fixtures. A disposable
// copy of the built Chromium extension runs the maintained content script over the REAL packaged
// format-2 rule set, with a purchased access snapshot and the host's real implementation table
// (accessCapabilitiesForTest over IMPLEMENTED_PRO_FEATURES). The shipped artifact stays
// byte-identical and never gets this seam; its dormancy is extras-dormancy.spec.ts.
//
// Lanes: the copy replaces the built worker and content script with maintained source, so the
// behaviour here does not depend on the build's sync configuration (as format2-shipping.spec.ts);
// it is verified in both CI lanes.

const paidOnContent = (host: "chromium" | "firefox" | "safari") => (source: (path: string) => string) => `
  import seed from ${source("packages/core/rules/seed.json")};
  import { FEATURE_REGISTRY } from "@still/shared-types";
  import { createContentScript } from ${source("packages/core/src/content/index.ts")};
  import { SettingsCache, ChromeStorageAdapter } from ${source("packages/core/src/storage/index.ts")};
  import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from ${source("packages/core/src/rules/packaged.ts")};
  import { ACCESS_BENEFITS, IMPLEMENTED_PRO_FEATURES, accessCapabilitiesForTest, initialAccessSnapshot }
    from ${source("packages/core/src/entitlement/access-policy.ts")};
  const base = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  const access = Object.freeze({ ...base, states: Object.freeze({ ...base.states,
    ...Object.fromEntries(FEATURE_REGISTRY.filter((f) => f.tier === "pro").map((f) => [f.id, "purchased"])) }) });
  const entitlement = {
    currentAccessSnapshot: () => access, current: () => true, hydrate: async () => {},
    subscribeAccess: () => () => {}, subscribe: () => () => {}, watch: () => () => {}, refreshAccess: async () => access,
  };
  const script = createContentScript({
    win: window, doc: document, ruleSet: seed, ruleSetV2: admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2),
    capabilities: accessCapabilitiesForTest({ paidMode: true, host: ${JSON.stringify(host)} }, IMPLEMENTED_PRO_FEATURES),
    cache: new SettingsCache(new ChromeStorageAdapter()), entitlement,
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.kind === "fixture.stop") { script.stop(); reply(true); }
  });
  void script.start();`;

const test = createFormat2Test(paidOnContent("chromium"));
const safari = createFormat2Test(paidOnContent("safari"));
const expect = test.expect;
const FB = "https://www.facebook.com";

async function commit(authority: Worker, sites: Record<string, boolean>) {
  await authority.evaluate(async (sites) => {
    const writer = (globalThis as unknown as {
      fixtureAuthority: { commitIntent: (intent: unknown) => Promise<unknown> };
    }).fixtureAuthority;
    for (const [feature, value] of Object.entries(sites))
      await writer.commitIntent({ path: `sites.${feature}`, value, updatedAt: Date.now() });
  }, sites);
}
const ALL_ON = { "facebook.reels": true, "facebook.stories": true, "facebook.videos": true, "facebook.sponsored": true };

/** Serves `file` for every Facebook document; counts top-level document loads per path. */
async function serveFacebook(page: Page, file: string): Promise<string[]> {
  const loads: string[] = [];
  await page.context().route(/^https?:/, (route) => {
    const url = new URL(route.request().url());
    if (!url.hostname.endsWith("facebook.com")) return route.abort();
    if (route.request().isNavigationRequest()) loads.push(`${url.pathname}${url.search}`);
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: extrasFixture(file) });
  });
  return loads;
}
/** The engine ran on this page: the free Reels feature class is the proof of life. */
const engineRan = (page: Page) => expect(page.locator("html")).toHaveClass(/still-feature-\d+-facebook-reels/);
const keepIds = (page: Page) => page.locator('[id^="keep-"]').evaluateAll((nodes) => nodes.map((node) => node.id));
/** Neither the element nor any ancestor is display:none (Still never hid it, even if it is now empty). */
const notHidden = (page: Page, id: string) => page.locator(`#${id}`).evaluate((node) => {
  for (let at: Element | null = node; at; at = at.parentElement) if (getComputedStyle(at).display === "none") return false;
  return true;
});
/** Every keep-* stays. `wrappers` may be left empty by hidden children, so only their own display is checked. */
async function expectKeptVisible(page: Page, wrappers: readonly string[] = []) {
  const ids = await keepIds(page);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    if (wrappers.includes(id)) expect(await notHidden(page, id), id).toBe(true);
    else await expect(page.locator(`#${id}`), id).toBeVisible();
  }
}
/** A navigation Still redirects: wait only for the commit, so an early redirect cannot interrupt goto. */
const gotoRedirected = (page: Page, url: string) => page.goto(url, { waitUntil: "commit" });
const stillElements = (page: Page) => page.locator("[id^='still-'], [class*='still-placeholder']").count();

test.describe("Facebook Stories (paid on)", () => {
  test("hides only the tray's story cards", async ({ page, authority }) => {
    await commit(authority, ALL_ON);
    await serveFacebook(page, "fb-stories.html");
    await page.goto(`${FB}/`);
    await engineRan(page);
    for (const id of ["target-story-card-1", "target-story-card-2"]) {
      await expect(page.locator(`#${id}`), id).toBeHidden();
      await expect(page.locator(`#${id}`), id).toHaveCount(1);
    }
    // The virtualiser wrapper keeps its place: only its story cards are hidden.
    await expectKeptVisible(page, ["keep-tray-wrapper"]);
  });

  test("a Story link goes silently to Home, once", async ({ page, authority }) => {
    await commit(authority, ALL_ON);
    const loads = await serveFacebook(page, "fb-stories.html");
    await gotoRedirected(page, `${FB}/stories/900000000001/`);
    await expect(page).toHaveURL(`${FB}/`);
    await engineRan(page);
    await page.waitForTimeout(300);
    expect(page.url()).toBe(`${FB}/`);
    expect(loads, "no loop: the Story, then Home, once").toEqual(["/stories/900000000001/", "/"]);
    expect(await stillElements(page), "no notice or sub-line").toBe(0);
  });
});

test.describe("Videos and Watch (paid on)", () => {
  for (const reels of [false, true])
    for (const videos of [false, true])
      test(`Reels ${reels ? "On" : "Off"}, Videos ${videos ? "On" : "Off"}`, async ({ page, authority }) => {
        await commit(authority, { ...ALL_ON, "facebook.reels": reels, "facebook.videos": videos });
        await serveFacebook(page, "fb-videos.html");
        await page.goto(`${FB}/`);
        if (reels) await engineRan(page);
        else await expect(page.locator("html")).toHaveClass(/still-feature-\d+-facebook-stories/);
        // Shortcut list items go with their Watch link (relative, no-slash and absolute), so no
        // empty <li> is left behind.
        for (const id of ["target-feed-video", "target-feed-live", "target-nav-watch", "target-nav-watch-bookmarks",
          "target-nav-watch-bookmarks-item", "target-nav-watch-absolute", "target-nav-watch-absolute-item",
          "target-nav-watch-noslash", "target-nav-watch-noslash-item"]) {
          if (videos) await expect(page.locator(`#${id}`), id).toBeHidden();
          else await expect(page.locator(`#${id}`), id).toBeVisible();
        }
        // The feed Reel is free Reels' alone: Videos never hides it.
        if (reels) await expect(page.locator("#reel-feed-free")).toBeHidden();
        else await expect(page.locator("#reel-feed-free")).toBeVisible();
        await expectKeptVisible(page);
      });

  test("the Watch hub goes silently to Home, once", async ({ page, authority }) => {
    await commit(authority, ALL_ON);
    const loads = await serveFacebook(page, "fb-videos.html");
    await gotoRedirected(page, `${FB}/watch/`);
    await expect(page).toHaveURL(`${FB}/`);
    await engineRan(page);
    await page.waitForTimeout(300);
    expect(loads).toEqual(["/watch/", "/"]);
    expect(await stillElements(page)).toBe(0);
  });

  test("the Watch live hub goes silently to Home, while a direct live link plays (Q10)", async ({ page, authority }) => {
    await commit(authority, ALL_ON);
    const loads = await serveFacebook(page, "fb-videos.html");
    await gotoRedirected(page, `${FB}/watch/live/`);
    await expect(page).toHaveURL(`${FB}/`);
    await engineRan(page);
    await page.goto(`${FB}/watch/live/?v=900000000112`);
    await engineRan(page);
    await page.waitForTimeout(300);
    expect(page.url()).toBe(`${FB}/watch/live/?v=900000000112`);
    await expect(page.locator("#keep-direct-player video")).toBeVisible();
    expect(loads).toEqual(["/watch/live/", "/", "/watch/live/?v=900000000112"]);
  });

  for (const path of ["/watch/?v=900000000105", "/inventedpage/videos/900000000106", "/videos/900000000107", "/watch/900000000108"])
    test(`the direct player ${path} stays playable`, async ({ page, authority }) => {
      await commit(authority, ALL_ON);
      const loads = await serveFacebook(page, "fb-videos.html");
      await page.goto(`${FB}${path}`);
      await engineRan(page);
      await page.waitForTimeout(300);
      expect(page.url()).toBe(`${FB}${path}`);
      expect(loads).toEqual([path]);
      await expect(page.locator("#keep-direct-player")).toBeVisible();
      await expect(page.locator("#keep-direct-player video")).toBeVisible();
    });

  test("free Reels routing still wins, and a shared Reel plays in the normal player (D244)", async ({ page, authority }) => {
    await commit(authority, ALL_ON);
    await serveFacebook(page, "fb-videos.html");
    await gotoRedirected(page, `${FB}/watch/reels/`);
    await expect(page).toHaveURL(`${FB}/`);
    await page.goto(`${FB}/reel/900000000103`);
    await engineRan(page);
    await page.waitForTimeout(300);
    expect(page.url()).toBe(`${FB}/reel/900000000103`);
    await expect(page.locator("#keep-direct-player video")).toBeVisible();
  });

  test("Off restores what Videos hid without navigating or reloading", async ({ page, authority }) => {
    await commit(authority, ALL_ON);
    const loads = await serveFacebook(page, "fb-videos.html");
    await page.goto(`${FB}/`);
    await expect(page.locator("#target-feed-video")).toBeHidden();
    await page.evaluate(() => { (window as unknown as { token: string }).token = "same-document"; });
    await commit(authority, { "facebook.videos": false });
    await expect(page.locator("#target-feed-video")).toBeVisible();
    await expect(page.locator("#target-nav-watch")).toBeVisible();
    await expect(page.locator("#reel-feed-free")).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { token?: string }).token)).toBe("same-document");
    expect(loads).toEqual(["/"]);
  });
});

test.describe("Desktop sidebar ads (paid on)", () => {
  for (const sponsored of [true, false])
    test(`Contacts, birthdays and group chats stay visible with sidebar ads ${sponsored ? "On" : "Off"}`, async ({ page, authority }) => {
      await commit(authority, { ...ALL_ON, "facebook.sponsored": sponsored });
      await serveFacebook(page, "fb-sidebar.html");
      await page.goto(`${FB}/`);
      await engineRan(page);
      if (sponsored) await expect(page.locator("#target-sidebar-ad-block")).toBeHidden();
      else await expect(page.locator("#target-sidebar-ad-block")).toBeVisible();
      for (const id of ["keep-contacts", "keep-birthdays", "keep-group-chats"])
        await expect(page.locator(`#${id}`), id).toBeVisible();
      await expectKeptVisible(page);
    });
});

safari.describe("Desktop sidebar ads on the Safari host (paid on)", () => {
  safari("is not implemented there: iPad is open owner question Q4", async ({ page, authority }) => {
    await commit(authority, ALL_ON);
    await serveFacebook(page, "fb-sidebar.html");
    await page.goto(`${FB}/`);
    await engineRan(page);
    await expect(page.locator("html")).not.toHaveClass(/still-feature-\d+-facebook-sponsored/);
    await expect(page.locator("#target-sidebar-ad-block")).toBeVisible();
    await expectKeptVisible(page);
  });
});
