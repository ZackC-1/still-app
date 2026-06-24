import { test, expect } from "./_extension.js";

test("the background service worker registers and yields an extension id", async ({ extensionId }) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test("the options page renders the four service cards", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator("[data-service]")).toHaveCount(4);
});

test("the manifest limits host permissions to the four services (no <all_urls>)", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manifest.json`);
  const manifest = JSON.parse(await page.locator("body").innerText()) as {
    host_permissions: string[];
  };
  expect(manifest.host_permissions).toHaveLength(4);
  expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
});
