import { test, expect, fixture } from "./_extension.js";
import type { BrowserContext, Page, Worker } from "@playwright/test";

// The TikTok blocked page (D29) in the built Chromium extension: an unconfigured build shows the
// V3 screens, so a blocked TikTok tab goes to the extension's own page. "Open TikTok this time"
// allows that one living tab only, after the confirmation, and never changes saved settings.

const BLOCKED = /^chrome-extension:\/\/[a-p]{32}\/tiktok-blocked\.html\?r=[A-Za-z0-9-]+$/;

async function serve(context: BrowserContext): Promise<void> {
  // The blocked page acts only on committed settings; wait for this fresh profile's first record.
  await expect
    .poll(async () => (await worker(context)).evaluate(async () => Boolean((await chrome.storage.local.get("still:settings"))["still:settings"])))
    .toBe(true);
  await context.route("**://*.tiktok.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture("tiktok.html") }),
  );
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: "<h1 id='elsewhere'>Elsewhere</h1>" }),
  );
}

async function worker(context: BrowserContext): Promise<Worker> {
  const [sw] = context.serviceWorkers();
  return sw ?? ((await context.waitForEvent("serviceworker")) as Worker);
}

const savedSettings = async (context: BrowserContext) =>
  (await worker(context)).evaluate(async () => (await chrome.storage.local.get("still:settings"))["still:settings"]);
const sessionKeys = async (context: BrowserContext) =>
  (await worker(context)).evaluate(async () => Object.keys(await chrome.storage.session.get(null)).sort());

async function openBlocked(page: Page, url = "https://www.tiktok.com/foryou"): Promise<void> {
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForURL(BLOCKED, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "TikTok stays closed." })).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
}

async function allowThisTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Open TikTok in this tab?");
  await dialog.getByRole("button", { name: "Open TikTok this time" }).click();
  await expect(page.getByText("Reload this page to open TikTok.")).toBeVisible();
  await page.getByRole("button", { name: "Reload page" }).click();
}

test("blocked TikTok opens the extension page; Open TikTok this time allows this one living tab only", async ({ context }) => {
  test.setTimeout(90_000);
  await serve(context);
  const page = await context.newPage();
  await page.goto("https://example.com/start");
  await openBlocked(page);
  const before = await savedSettings(context);

  await allowThisTab(page);
  await page.waitForURL("https://www.tiktok.com/foryou");
  await expect(page.locator("#tiktok-feed")).toBeVisible();
  await expect(page.locator("#still-placeholder")).toHaveCount(0);

  // Same tab: other TikTok addresses stay open.
  await page.goto("https://www.tiktok.com/@still/video/1");
  await expect(page.locator("#tiktok-feed")).toBeVisible();
  expect(page.url()).toBe("https://www.tiktok.com/@still/video/1");

  // Any other tab is still blocked.
  const other = await context.newPage();
  await openBlocked(other, "https://www.tiktok.com/@still/video/1");

  // The allowance never touched saved (or synced) settings.
  expect(await savedSettings(context)).toEqual(before);

  // Closing the allowed tab clears its allowance; the other tab's binding remains until it closes.
  const keys = await sessionKeys(context);
  expect(keys.filter((key) => key.startsWith("still:tiktok-tab:"))).toHaveLength(1);
  await page.close();
  await expect.poll(async () => (await sessionKeys(context)).filter((key) => key.startsWith("still:tiktok-tab:"))).toEqual([]);
  await other.close();
  await expect.poll(() => sessionKeys(context)).toEqual([]);
});

test("Keep it closed grants nothing and a fresh tab or reload stays blocked", async ({ context }) => {
  test.setTimeout(60_000);
  await serve(context);
  const page = await context.newPage();
  await openBlocked(page);
  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Keep it closed" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open TikTok this time" })).toBeVisible();
  expect((await sessionKeys(context)).filter((key) => key.startsWith("still:tiktok-tab:"))).toEqual([]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Open TikTok this time" })).toBeVisible();
  await expect(page.getByText("Reload this page to open TikTok.")).toHaveCount(0);
});

test("with TikTok turned off, TikTok loads normally and no blocked page appears", async ({ context, extensionId }) => {
  await serve(context);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const reply = await options.evaluate(() =>
    chrome.runtime.sendMessage({ kind: "still:settings-intent", path: "services.tiktok", value: false, updatedAt: Date.now() }),
  );
  expect(reply).toMatchObject({ status: "committed" });
  const page = await context.newPage();
  await page.goto("https://www.tiktok.com/foryou");
  await expect(page.locator("#tiktok-feed")).toBeVisible();
  await page.waitForTimeout(500);
  expect(page.url()).toBe("https://www.tiktok.com/foryou");
  await expect(page.locator("#still-placeholder")).toHaveCount(0);
});

test("Back from the blocked page leaves TikTok without bouncing forward again", async ({ context }) => {
  test.setTimeout(60_000);
  await serve(context);
  const page = await context.newPage();
  await page.goto("https://example.com/start");
  await openBlocked(page);
  await page.goBack({ waitUntil: "commit" });
  // Chromium keeps the TikTok entry: it shows the in-page block instead of re-sending the tab.
  await expect(page.locator("#still-placeholder")).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
  expect(page.url()).toBe("https://www.tiktok.com/foryou");
  await page.goBack({ waitUntil: "commit" });
  await expect(page.locator("#elsewhere")).toBeVisible();
});
