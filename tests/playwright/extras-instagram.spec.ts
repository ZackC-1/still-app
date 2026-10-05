import type { Page, Route, Worker } from "@playwright/test";
import { createFormat2Test } from "./_format2-extension";
import { extrasFixture, fixtureIds } from "../../packages/core/src/rules/__tests__/extras-fixtures.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// P4, paid ON: Instagram's four Still Pro extras on the synthetic extras fixtures, in a disposable
// copy of the built Chromium extension. The copy's content script is the maintained format-2 content
// script over the REAL packaged rule set, with the paid tier switched on only inside the copy:
// capabilities come from the real implementation table (accessCapabilities, paid on, Chromium host)
// and a stub access snapshot reports the four as purchased. The shipped artifact stays
// byte-identical (the fixture checks it) and its own dormancy is covered by extras-dormancy.spec.ts.
//
// Lane-aware: the copy brings its own worker, which commits fresh schema-2 settings, so these cases
// run the same way in the unconfigured and the sync-configured CI lanes.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const freeFixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");

const IG_PRO = ["instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads"];

const paidOnContent = (source: (path: string) => string) => `
  import { createContentScript } from ${source("packages/core/src/content/index.ts")};
  import { ChromeStorageAdapter, SettingsCache } from ${source("packages/core/src/storage/index.ts")};
  import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from ${source("packages/core/src/rules/packaged.ts")};
  import { ACCESS_BENEFITS, accessCapabilities, initialAccessSnapshot } from ${source("packages/core/src/entitlement/access-policy.ts")};
  import seed from ${source("packages/core/rules/seed.json")};
  const pro = ${JSON.stringify(IG_PRO)};
  const base = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  const snapshot = Object.freeze({ ...base, states: Object.freeze({ ...base.states, ...Object.fromEntries(pro.map((id) => [id, "purchased"])) }) });
  const entitlement = {
    current: () => true, currentAccessSnapshot: () => snapshot, subscribeAccess: () => () => {},
    subscribe: () => () => {}, watch: () => () => {}, refreshAccess: async () => {}, hydrate: async () => {},
  };
  const script = createContentScript({
    win: window, doc: document, ruleSet: seed, ruleSetV2: admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2),
    capabilities: accessCapabilities({ paidMode: true, host: "chromium" }),
    cache: new SettingsCache(new ChromeStorageAdapter()), entitlement,
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.kind === "fixture.stop") { script.stop(); reply(true); }
  });
  void script.start();`;

const test = createFormat2Test(paidOnContent);
const expect = test.expect;

async function commit(authority: Worker, path: string, value: boolean) {
  await authority.evaluate(async ({ path, value }) => {
    await (globalThis as unknown as {
      fixtureAuthority: { commitIntent: (intent: unknown) => Promise<unknown> };
    }).fixtureAuthority.commitIntent({ path, value, updatedAt: Date.now() });
  }, { path, value });
}

async function allExtras(authority: Worker, value: boolean) {
  for (const id of IG_PRO) await commit(authority, `sites.${id}`, value);
}

/** Serve `body(url)` for every Instagram document and count each path's document requests. */
async function serveInstagram(page: Page, body: (url: URL) => string) {
  const loads = new Map<string, number>();
  await page.context().route(/^https?:/, (route: Route) => {
    const url = new URL(route.request().url());
    if (!url.hostname.endsWith("instagram.com")) return route.abort();
    if (route.request().resourceType() === "document") loads.set(url.pathname, (loads.get(url.pathname) ?? 0) + 1);
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: body(url) });
  });
  return loads;
}

const explorePage = (url: URL) =>
  extrasFixture(url.pathname === "/explore/search/" ? "ig-explore-mobile.html" : "ig-explore.html");

async function settled(page: Page) {
  await expect(page.locator("html")).toHaveClass(/still-feature-\d+-instagram-reels/);
  await page.waitForTimeout(300); // let any (wrong) late redirect land
}

test.describe("Instagram extras, paid on", () => {
  test.beforeEach(async ({ authority }) => {
    await allExtras(authority, true);
  });

  test("Explore: the hub opens search once, without a loop, and search stays usable", async ({ page }) => {
    const loads = await serveInstagram(page, explorePage);
    await page.goto("https://www.instagram.com/explore/");
    await expect(page).toHaveURL("https://www.instagram.com/explore/search/");
    await settled(page);
    expect(page.url()).toBe("https://www.instagram.com/explore/search/");
    expect(loads.get("/explore/search/"), "the search entry loaded exactly once").toBe(1);
    expect(loads.get("/explore/"), "the hub loaded exactly once").toBe(1);
    // Recommendation tiles beneath the search field are hidden, never removed.
    await expect(page.locator("#target-mobile-explore-grid")).toBeHidden();
    await expect(page.locator("#target-mobile-explore-grid")).toHaveCount(1);
    // Search, its results and the combined phone Search/Explore tab stay.
    for (const id of fixtureIds(extrasFixture("ig-explore-mobile.html"), "keep-"))
      await expect(page.locator(`#${id}`), id).toBeVisible();
    await page.locator("#keep-mobile-search-input").fill("invented");
    await expect(page.locator("#keep-mobile-search-input")).toHaveValue("invented");
    await expect(page.locator("#keep-mobile-search-input")).toBeFocused();
  });

  for (const path of [
    "/explore/search/keyword/?q=invented", "/explore/tags/inventedtag/",
    "/explore/locations/900000001/invented-place/", "/popular/", "/popular/inventedtopic/", "/explore/?q=invented",
  ])
    test(`Explore: ${path} stays usable and is never redirected`, async ({ page }) => {
      const loads = await serveInstagram(page, explorePage);
      const url = `https://www.instagram.com${path}`;
      await page.goto(url);
      await settled(page);
      expect(page.url()).toBe(url);
      expect([...loads.values()].reduce((a, b) => a + b, 0), "a single document load").toBe(1);
      // A tag/location grid and the search panel are deliberate content: nothing here is hidden.
      for (const id of [...fixtureIds(extrasFixture("ig-explore.html"), "keep-"), "target-explore-grid", "target-nav-explore"]) {
        const hiddenByDesign = await page.locator(`#${id}`).evaluate((el) => el.hasAttribute("hidden"));
        if (!hiddenByDesign) await expect(page.locator(`#${id}`), id).toBeVisible();
      }
    });

  test("Explore: an in-page move to the hub also opens search (SPA navigation)", async ({ page }) => {
    await serveInstagram(page, explorePage);
    await page.goto("https://www.instagram.com/explore/tags/inventedtag/");
    await settled(page);
    await page.locator("#target-nav-explore").evaluate((anchor) => {
      anchor.addEventListener("click", (event) => { event.preventDefault(); history.pushState(null, "", "/explore/"); }, { once: true });
    });
    await page.locator("#target-nav-explore").click();
    await expect(page).toHaveURL("https://www.instagram.com/explore/search/");
  });

  test("Stories: story links (shared ones included) go Home; the tray and Highlights are hidden", async ({ page }) => {
    const loads = await serveInstagram(page, () => extrasFixture("ig-stories.html"));
    for (const path of ["/stories/inventeduser1/900000000001/", "/stories/inventeduser1/900000000001/?utm_source=ig_story_item_share&igsh=invented"]) {
      await page.goto(`https://www.instagram.com${path}`);
      await expect(page).toHaveURL("https://www.instagram.com/");
    }
    await settled(page);
    expect(page.url()).toBe("https://www.instagram.com/");
    expect(loads.get("/"), "Home loaded once per story link, never in a loop").toBe(2);
    for (const id of ["target-home-tray", "target-highlights"]) {
      await expect(page.locator(`#${id}`), id).toBeHidden();
      await expect(page.locator(`#${id}`), id).toHaveCount(1);
    }
    for (const id of fixtureIds(extrasFixture("ig-stories.html"), "keep-")) await expect(page.locator(`#${id}`), id).toBeVisible();
  });

  test("Suggested accounts: /explore/people/ goes Home; recommendation blocks hidden, account lists kept", async ({ page }) => {
    await serveInstagram(page, () => extrasFixture("ig-suggested.html"));
    await page.goto("https://www.instagram.com/explore/people/");
    await expect(page).toHaveURL("https://www.instagram.com/");
    await settled(page);
    for (const id of fixtureIds(extrasFixture("ig-suggested.html"), "target-")) await expect(page.locator(`#${id}`), id).toBeHidden();
    for (const id of fixtureIds(extrasFixture("ig-suggested.html"), "keep-")) await expect(page.locator(`#${id}`), id).toBeVisible();
  });

  test("Threads links: exact Threads hosts hidden, look-alikes and ordinary links kept; Off restores live", async ({ page, authority }) => {
    await serveInstagram(page, () => extrasFixture("ig-threads.html"));
    await page.goto("https://www.instagram.com/inventeduser/");
    await settled(page);
    const targets = fixtureIds(extrasFixture("ig-threads.html"), "target-");
    expect(targets).toHaveLength(4);
    for (const id of targets) await expect(page.locator(`#${id}`), id).toBeHidden();
    for (const id of fixtureIds(extrasFixture("ig-threads.html"), "keep-")) await expect(page.locator(`#${id}`), id).toBeVisible();
    const token = await page.evaluate(() => ((window as unknown as { __token?: number }).__token = Math.random()));
    await commit(authority, "sites.instagram.threads", false);
    for (const id of targets) await expect(page.locator(`#${id}`), id).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/instagram-threads/);
    await commit(authority, "sites.instagram.threads", true);
    for (const id of targets) await expect(page.locator(`#${id}`), id).toBeHidden();
    // No reload or navigation on the way.
    expect(await page.evaluate(() => (window as unknown as { __token?: number }).__token)).toBe(token);
    expect(page.url()).toBe("https://www.instagram.com/inventeduser/");
  });

  test("free Reels routes and hiding are unchanged with every Instagram extra on", async ({ page }) => {
    await serveInstagram(page, (url) => freeFixture(url.pathname.startsWith("/reel") ? "instagram-mobile.html" : "instagram-home.html"));
    await page.goto("https://www.instagram.com/reels/");
    await expect(page).toHaveURL("https://www.instagram.com/");
    await expect(page.locator("#reel-post")).toBeHidden();
    await expect(page.locator("#nav-reels")).toBeHidden();
    await page.goto("https://www.instagram.com/reels/InvReel1/");
    await expect(page).toHaveURL("https://www.instagram.com/reel/InvReel1/");
  });
});

test("Instagram extras saved Off: no extras effect even with paid on", async ({ page, authority }) => {
  await allExtras(authority, false);
  const loads = await serveInstagram(page, () => extrasFixture("ig-stories.html"));
  await page.goto("https://www.instagram.com/stories/inventeduser1/900000000001/");
  await settled(page);
  expect(page.url()).toBe("https://www.instagram.com/stories/inventeduser1/900000000001/");
  expect(loads.get("/")).toBeUndefined();
  for (const id of ["target-home-tray", "target-highlights"]) await expect(page.locator(`#${id}`), id).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/instagram-(explore|stories|suggested|threads)/);
});
