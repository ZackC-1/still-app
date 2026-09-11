import type { BrowserContext } from "@playwright/test";
import { test, expect, fixture } from "./_extension.js";

async function checkFilter(context: BrowserContext, extensionId: string): Promise<void> {
  await context.route(/^https?:/, (route) => route.request().url().startsWith("https://www.youtube.com/")
    ? route.fulfill({ contentType: "text/html", body: fixture("youtube-shorts-filter.html") })
    : route.abort());
  const page = await context.newPage();
  await page.goto("https://www.youtube.com/results?search_query=example");
  await expect(page.locator("#shorts")).toBeHidden();
  await expect(page.locator("#all button")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#videos")).toBeVisible();
  await expect(page.locator("#ordinary")).toBeVisible();
  await expect(page.locator("#search")).toHaveValue("example search");
  await page.waitForTimeout(300);
  const state = () => page.evaluate(() => (window as unknown as {
    filterProbe: { requests: number; allClicks: number; shortsSelected: boolean };
  }).filterProbe);
  expect((await state()).allClicks).toBe(1);
  expect((await state()).requests).toBeLessThanOrEqual(2);

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByRole("switch", { name: "Still on/off", exact: true }).click();
  await expect(page.locator("#shorts")).toBeVisible();
  await page.reload();
  await expect(page.locator("#shorts")).toBeVisible();
  await expect(page.locator("#shorts button")).toHaveAttribute("aria-selected", "true");
  expect((await state()).allClicks).toBe(0);

  await options.getByRole("switch", { name: "Still on/off", exact: true }).click();
  await expect(page.locator("#shorts")).toBeHidden();
  await expect(page.locator("#ordinary")).toBeVisible();
  expect((await state()).allClicks).toBe(1);
}

test("Chromium build leaves Shorts-only search without continuation churn and restores off controls", async ({ context, extensionId }) => {
  await checkFilter(context, extensionId);
});

test("Safari build leaves Shorts-only search without continuation churn and restores off controls", async ({ safariContext, safariExtensionId }) => {
  await checkFilter(safariContext, safariExtensionId);
});

async function checkMobileTopics(context: BrowserContext, extensionId: string, enabled = true): Promise<void> {
  await context.route(/^https?:/, (route) => route.request().url().startsWith("https://m.youtube.com/")
    ? route.fulfill({ contentType: "text/html", body: fixture("youtube-mobile-topics.html") })
    : route.abort());
  const page = await context.newPage();
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  if (!enabled) {
    await options.getByRole("switch", { name: "Still on/off", exact: true }).click();
  }
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("https://m.youtube.com/");
  if (!enabled) await expect(page.locator("#shorts-shelf")).toBeVisible();
  else await expect(page.locator("#shorts-shelf")).toBeHidden();
  await page.getByRole("tab", { name: "Music", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Music", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#topic-video")).toBeVisible();
  await expect(page.locator("#topic-video")).toHaveText("Music ordinary video");
  await page.getByRole("tab", { name: "Boat building", exact: true }).click();
  await expect(page.locator("#topic-video")).toHaveText("Boat building ordinary video");
  expect(await page.evaluate(() => (window as unknown as { topicErrors: string[] }).topicErrors)).toEqual([]);
  if (enabled) {
    await expect(page.locator("#reused-card")).toBeHidden();
    await options.getByRole("switch", { name: "Still on/off", exact: true }).click();
    await expect(page.locator("#reused-card")).toBeVisible();
    await options.getByRole("switch", { name: "Still on/off", exact: true }).click();
    await expect(page.locator("#reused-card")).toBeHidden();
    // Mobile renderers can also reuse a card, changing only its existing thumbnail destination.
    // No new elements are added: CSS must stop matching without waiting for a content-script sweep.
    await page.locator("#reused-card a").evaluate((anchor) => anchor.setAttribute("href", "/watch?v=reused"));
    await expect(page.locator("#reused-card")).toBeVisible();
    await expect(page.locator("#topic-video")).toBeVisible();
  }
}

test("Chromium build preserves mobile Home topic results through renderer-owned updates", async ({ context, extensionId }) => {
  await checkMobileTopics(context, extensionId);
});

test("Safari build preserves mobile Home topic results through renderer-owned updates", async ({ safariContext, safariExtensionId }) => {
  await checkMobileTopics(safariContext, safariExtensionId);
});

test("mobile Home topic control works with Still disabled", async ({ context, extensionId }) => {
  await checkMobileTopics(context, extensionId, false);
});
