import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./_extension.js";

// ISS-0114: the sign-in sheet's backdrop is announced as a "Close sign-in" button, so a pointer
// (and Playwright's ordinary click, which aims at the middle of the element) must be able to reach
// it. Measured in the real built extension because jsdom has no layout or hit testing.
//
// Lane-aware: only builds with a sign-in server show the sheet. The configured CI lane
// (STILL_TEST_SYNC_CONFIGURED=true) runs it; the unconfigured lane has no Sign in button at all.
// The opt-in V3 sign-in build (STILL_EXPECT_MODERN_SIGN_IN=1, see settings-restore.spec.ts) runs it
// too, since its Settings page opens the same sheet.
const SIGN_IN_BUILT =
  process.env.STILL_TEST_SYNC_CONFIGURED === "true" || process.env.STILL_EXPECT_MODERN_SIGN_IN === "1";

const SURFACES = [
  { name: "Settings page", path: "options.html", viewport: { width: 1280, height: 720 } },
  // Chrome's embedded Settings dialog can be short, which makes the panel nearly fill the page.
  { name: "short Settings page", path: "options.html", viewport: { width: 700, height: 420 } },
  { name: "popup", path: "popup.html", viewport: { width: 380, height: 600 } },
  // So short that the panel reaches its height limit and the strip above it is at its 12px minimum.
  { name: "very short popup", path: "popup.html", viewport: { width: 380, height: 260 } },
] as const;

async function openSheet(
  context: BrowserContext,
  extensionId: string,
  surface: (typeof SURFACES)[number],
): Promise<Page> {
  await context.route(/^https?:/, (route) => route.abort());
  const page = await context.newPage();
  await page.setViewportSize(surface.viewport);
  await page.goto(`chrome-extension://${extensionId}/${surface.path}`);
  await page.getByRole("button", { name: /^Sign in/ }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return page;
}

test.describe("sign-in sheet backdrop", () => {
  test.skip(!SIGN_IN_BUILT, "Needs a build with sign-in (the configured lane)");

  for (const surface of SURFACES) {
    test(`${surface.name}: the Dismiss backdrop takes an ordinary click and closes the sheet`, async ({
      context,
      extensionId,
    }) => {
      const page = await openSheet(context, extensionId, surface);
      const backdrop = page.getByRole("button", { name: "Dismiss" });
      await expect(backdrop).toHaveCount(1);
      // The backdrop button sits beside the panel, never underneath it.
      const button = (await backdrop.boundingBox())!;
      const panel = (await page.getByRole("dialog").boundingBox())!;
      // At least the 12px minimum, and the full page width (a scrollbar, when one shows, is not page).
      expect(button.height).toBeGreaterThanOrEqual(12);
      const pageWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(button.width).toBeGreaterThanOrEqual(pageWidth - 0.5);
      if (surface.name === "very short popup") expect(button.height).toBeLessThan(13);
      expect(button.y + button.height).toBeLessThanOrEqual(panel.y + 0.5);
      // A click inside the panel keeps it open.
      await page.getByRole("dialog").getByRole("heading").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      // Default actionability checks: visible, stable, enabled and not covered by the panel.
      await backdrop.click({ timeout: 5_000 });
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test(`${surface.name}: Escape and Cancel still close the sheet`, async ({ context, extensionId }) => {
      const page = await openSheet(context, extensionId, surface);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: /^Sign in/ }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: /^(Cancel|Not now)$/ }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  }

  test("wide Settings page: a click on the dimming beside the panel still closes the sheet", async ({
    context,
    extensionId,
  }) => {
    const page = await openSheet(context, extensionId, SURFACES[0]);
    const panel = (await page.getByRole("dialog").boundingBox())!;
    expect(panel.x).toBeGreaterThan(40);
    await page.mouse.click(20, panel.y + panel.height / 2);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  // A drag that starts on one side of the panel's edge and ends on the other is delivered as a
  // click on the dimmed layer; it must not close the sheet (and lose a typed address).
  for (const surface of [SURFACES[0], SURFACES[2]]) {
    test(`${surface.name}: a drag across the panel's edge keeps the sheet open`, async ({ context, extensionId }) => {
      const page = await openSheet(context, extensionId, surface);
      const dialog = page.getByRole("dialog");
      const consent = dialog.getByRole("button", { name: "Continue" });
      if (await consent.count()) await consent.click();
      const field = page.getByLabel("Email address");
      await field.fill("drag-check@still.test");
      const box = (await field.boundingBox())!;

      // Press in the field (as when selecting the address), release on the dimming at the top.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(10, 4, { steps: 5 });
      await page.mouse.up();
      await expect(dialog).toBeVisible();
      await expect(field).toHaveValue("drag-check@still.test");

      // The reverse: press on the dimming strip, release inside the panel.
      await page.mouse.move(10, 4);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect(dialog).toBeVisible();
      await expect(field).toHaveValue("drag-check@still.test");

      // An ordinary click on the dimming still closes it.
      await page.mouse.click(10, 4);
      await expect(dialog).toHaveCount(0);
    });
  }

  test("wide Settings page: a drag on the dimming beside the panel that ends inside it keeps the sheet open", async ({
    context,
    extensionId,
  }) => {
    const page = await openSheet(context, extensionId, SURFACES[0]);
    const dialog = page.getByRole("dialog");
    const panel = (await dialog.boundingBox())!;
    await page.mouse.move(20, panel.y + panel.height / 2);
    await page.mouse.down();
    await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(dialog).toBeVisible();
  });
});
