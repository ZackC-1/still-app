import { test, expect } from "./_extension.js";

// Full-width buttons are 44px tall on the Chrome and Firefox Settings page and 54px in the Apple apps
// (owner ruling; the app side is app-webview-v3-bundle.spec.ts). On the Settings page the .options
// frame narrows the block-button padding, so the 44px minimum sets the height; see the "Full-width
// button heights" note in components.css.

test.skip(process.env.STILL_TEST_SYNC_CONFIGURED === "true", "the V3 settings page; the 2.x lane has its own page");
test.use({ settingsProfile: "modern" });

test("the Settings page: full-width buttons are 44px tall", async ({ context, extensionId }) => {
  await context.route(/^https?:/, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.getByRole("region", { name: "Help" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".primary.block, .secondary.block")]
      .filter((el) => el.offsetParent)
      .map((el) => `${el.textContent!.trim()}: ${Math.round(el.getBoundingClientRect().height)}`),
  );
  expect(heights.length, "a full-width button on the signed-out Settings page").toBeGreaterThan(0);
  for (const entry of heights) expect(entry).toMatch(/: 44$/);
});
