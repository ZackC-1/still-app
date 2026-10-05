import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Worker } from "@playwright/test";
import { createFormat2Test } from "./_format2-extension";

// The shipping content entry with the REAL packaged format-2 rule set, in a disposable copy of the
// built Chromium extension. The copy activates the services the shipping build still holds, so
// these cases prove what activation will do; the shipping artifact itself stays byte-identical.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");

const shippingContent =
  (packagedOverride: string) => (source: (path: string) => string) => `
    import { createShippingContentEntry } from ${source("packages/core/src/content/extension-entry.ts")};
    import { PACKAGED_RULE_SET_V2 } from ${source("packages/core/src/rules/packaged.ts")};
    let script;
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message.kind === "fixture.stop") { script?.stop(); reply(true); }
    });
    const packaged = structuredClone(PACKAGED_RULE_SET_V2);
    ${packagedOverride}
    void createShippingContentEntry({
      storage: chrome.storage.local, prod: false, earlyRedirect: false,
      packagedRuleSetV2: packaged,
      format2Services: new Set(["youtube", "instagram", "facebook", "tiktok"]),
      onScriptCreated: (s) => { script = s; },
      onLane: (lane) => document.documentElement.setAttribute(
        "data-fixture-lane", lane.kind === "format2" ? "format2" : lane.reason),
    })();`;

const test = createFormat2Test(shippingContent(""));
const fallback = createFormat2Test(shippingContent("delete packaged.services.instagram;"));
const expect = test.expect;

async function open(page: Page, url: string, file: string) {
  const host = new URL(url).hostname.split(".").slice(-2).join(".");
  await page.context().route(/^https?:/, (route) =>
    new URL(route.request().url()).hostname.endsWith(host)
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture(file) })
      : route.abort(),
  );
  await page.goto(url);
}

async function commit(authority: Worker, path: string, value: boolean) {
  await authority.evaluate(
    async ({ path, value }) => {
      await (
        globalThis as unknown as {
          fixtureAuthority: { commitIntent: (intent: unknown) => Promise<unknown> };
        }
      ).fixtureAuthority.commitIntent({ path, value, updatedAt: Date.now() });
    },
    { path, value },
  );
}

async function stopScripts(authority: Worker, url: string) {
  await authority.evaluate(async (url) => {
    const api = (
      globalThis as unknown as {
        chrome: {
          tabs: {
            query: (q: unknown) => Promise<{ id: number }[]>;
            sendMessage: (id: number, m: unknown) => Promise<unknown>;
          };
        };
      }
    ).chrome;
    for (const tab of await api.tabs.query({ url }))
      await api.tabs.sendMessage(tab.id, { kind: "fixture.stop" });
  }, url);
}

const cases = [
  ["youtube.html", "https://www.youtube.com/feed/subscriptions", ["shelf", "rich-shorts-section", "subs-shorts-shelf", "shorts-mini-guide"]],
  ["youtube-mobile.html", "https://m.youtube.com/", ["shorts-tab", "mobile-shorts-section", "mobile-reel-shelf-section", "mobile-shorts-card"]],
  ["instagram-home.html", "https://www.instagram.com/", ["reel-post", "reel-post-with-hashtags", "nav-reels"]],
  ["facebook.html", "https://www.facebook.com/", ["reel-article", "reels-shortcut", "reels-shelf-card"]],
  ["facebook-mobile.html", "https://m.facebook.com/", ["fb-mobile-reel", "fb-mobile-reels"]],
] as const;

for (const [file, url, targets] of cases)
  test(`shipping format-2 lane: ${url} hides packaged targets and leaves ordinary content alone`, async ({ page }) => {
    await open(page, url, file);
    await expect(page.locator("html")).toHaveAttribute("data-fixture-lane", "format2");
    for (const id of targets) {
      await expect(page.locator(`#${id}`), id).toBeHidden();
      await expect(page.locator(`#${id}`), id).toHaveCount(1); // hidden, never removed
    }
    const keep = page.locator('[id^="keep-"]');
    expect(await keep.count()).toBeGreaterThan(0);
    for (const id of await keep.evaluateAll((nodes) => nodes.map((node) => node.id)))
      await expect(page.locator(`#${id}`), id).toBeVisible();
    await expect(page.locator("#still-placeholder")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveClass(/still-active|still-service-|still-pro-active/);
  });

test("shipping format-2 lane: Off hides nothing, On restores, stop removes owned effects", async ({ page, authority }) => {
  await open(page, "https://www.instagram.com/", "instagram-home.html");
  await expect(page.locator("#reel-post")).toBeHidden();
  await commit(authority, "sites.instagram.reels", false);
  await expect(page.locator("#reel-post")).toBeVisible();
  await expect(page.locator("#nav-reels")).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/still-feature-/);
  await commit(authority, "services.instagram", true);
  await commit(authority, "sites.instagram.reels", true);
  await expect(page.locator("#reel-post")).toBeHidden();
  await commit(authority, "globalOn", false);
  await expect(page.locator("#reel-post")).toBeVisible();
  await commit(authority, "globalOn", true);
  await expect(page.locator("#reel-post")).toBeHidden();
  await stopScripts(authority, "https://www.instagram.com/*");
  await expect(page.locator("#reel-post")).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/still-feature-/);
  expect(await page.locator("style").evaluateAll((nodes) => nodes.filter((node) => node.textContent?.includes("still-feature-")).length)).toBe(0);
});

test("shipping format-2 lane: late and recycled nodes follow the stylesheet across SPA navigation", async ({ page }) => {
  await open(page, "https://m.youtube.com/", "youtube-mobile.html");
  await expect(page.locator("#mobile-shorts-card")).toBeHidden();
  await page.evaluate(() => history.pushState(null, "", "/results?search_query=example"));
  await page.evaluate(() => {
    const late = document.createElement("ytm-reel-shelf-renderer");
    late.id = "late-shelf";
    late.textContent = "late shelf";
    document.querySelector("ytm-app")!.append(late);
  });
  await expect(page.locator("#late-shelf")).toBeHidden();
  await page.locator("#mobile-shorts-card ytm-media-item").evaluate((node) => node.classList.remove("big-shorts-singleton"));
  await page.locator("#mobile-shorts-card a").first().evaluate((anchor) => anchor.setAttribute("href", "/watch?v=reused"));
  await expect(page.locator("#mobile-shorts-card")).toBeVisible();
  await expect(page.locator("#keep-mobile-video")).toBeVisible();
});

test("shipping format-2 lane: a direct Shorts URL lands on the watch page", async ({ page }) => {
  await open(page, "https://www.youtube.com/shorts/abc123", "youtube.html");
  await expect(page).toHaveURL("https://www.youtube.com/watch?v=abc123");
});

test("shipping entry keeps TikTok on its existing legacy site block without a trusted port", async ({ page }) => {
  await open(page, "https://www.tiktok.com/foryou", "tiktok.html");
  await expect(page.locator("html")).toHaveAttribute("data-fixture-lane", "tiktok-port-absent");
  await expect(page.locator("#still-placeholder")).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
});

test("shipping entry keeps the legacy engine for a legacy schema-1 settings projection", async ({ page, authority }) => {
  await authority.evaluate(async () => {
    await (
      globalThis as unknown as { chrome: { storage: { local: { set(items: object): Promise<void> } } } }
    ).chrome.storage.local.set({
      "still:settings": {
        settings: { globalOn: true, services: { youtube: true, instagram: true, tiktok: true, facebook: true }, pauses: [], updatedAt: 5 },
        syncMetadata: null,
      },
    });
  });
  await open(page, "https://www.youtube.com/feed/subscriptions", "youtube.html");
  await expect(page.locator("html")).toHaveAttribute("data-fixture-lane", "settings-not-schema2");
  await expect(page.locator("html")).toHaveClass(/still-active/);
  await expect(page.locator("#shelf")).toHaveCount(0); // the legacy remove surface still runs
  await expect(page.locator("#keep-video")).toBeVisible();
});

fallback("an invalid packaged set falls back to the legacy seed engine and its existing behaviour", async ({ page }) => {
  await open(page, "https://www.youtube.com/feed/subscriptions", "youtube.html");
  await fallback.expect(page.locator("html")).toHaveAttribute("data-fixture-lane", "packaged-invalid");
  await fallback.expect(page.locator("html")).toHaveClass(/still-active/);
  await fallback.expect(page.locator("html")).not.toHaveClass(/still-feature-/);
  await fallback.expect(page.locator("#shelf")).toHaveCount(0);
  await fallback.expect(page.locator("#endpoint")).toBeHidden();
  await fallback.expect(page.locator("#keep-video")).toBeVisible();
});
