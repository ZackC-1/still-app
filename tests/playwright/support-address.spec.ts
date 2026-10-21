import { test, expect } from "./_extension.js";
import { SUPPORT_EMAIL } from "../../packages/core/src/ui/config.js";

// ISS-0112 (owner, 20 Oct): the support address under "Contact support" is a plain line people can
// select and copy, with no Copy button. It is one unit: a click or a double-click takes the whole
// address. Without that, Chrome's word rule stops at "@" and ".", and a click beside the text (the
// line spans the card) selects only a line break. The Mac and iPhone app side of the same rule is
// checked in WebKit by app-webview-v3-bundle.spec.ts.

test.skip(process.env.STILL_TEST_SYNC_CONFIGURED === "true", "the V3 settings page; the 2.x lane has its own page");
test.use({ settingsProfile: "modern" });

test("the Settings page: a click or a double-click selects the whole support address", async ({ context, extensionId }) => {
  await context.route(/^https?:/, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const help = page.getByRole("region", { name: "Help" });
  const address = help.getByText(SUPPORT_EMAIL, { exact: true });
  await expect(address).toBeVisible();
  expect(await address.evaluate((el) => getComputedStyle(el).userSelect)).toBe("all");
  // Scoped to the address: the card around it keeps ordinary selection.
  expect(await help.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("all");

  const selection = () => page.evaluate(() => String(getSelection()).trim());
  await address.click();
  expect(await selection()).toBe(SUPPORT_EMAIL);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await address.dblclick();
  expect(await selection()).toBe(SUPPORT_EMAIL);
});
