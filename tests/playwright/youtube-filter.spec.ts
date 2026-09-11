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
