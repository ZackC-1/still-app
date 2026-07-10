import { test, expect } from "./_extension.js";

test("the background service worker registers and yields an extension id", async ({
  extensionId,
}) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test("the options page renders the four service cards", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator("[data-service]")).toHaveCount(4);
});

test("the popup keeps every primary control visible without scaling or overflow", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => document.fonts.ready);

  const layout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    zoom: getComputedStyle(document.documentElement).zoom,
  }));

  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight);
  expect(layout.zoom).toBe("1");
  await expect(
    page.getByRole("button", { name: "Open settings" }),
  ).toBeInViewport();
});

test("the manifest limits host permissions to the four services (no <all_urls>)", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manifest.json`);
  const manifest = JSON.parse(await page.locator("body").innerText()) as {
    host_permissions: string[];
  };
  expect(manifest.host_permissions).toHaveLength(4);
  expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
});
