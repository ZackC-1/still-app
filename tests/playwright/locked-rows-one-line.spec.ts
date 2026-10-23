import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./_extension.js";
import { expectLockedRowsOnOneLine, measureOptionRows } from "./_locked-rows.js";

// ISS-0122 (owner, 22 Oct; evidence: the Chrome popup signed out without Still Pro, every locked
// YouTube row wrapped to two lines): a locked row shows no switch, only its name and the Still Pro
// chip, on one line, as tall as a free row: 40px in the popups, 46px on the Settings page. Measured
// at 1x in the built extensions:
// - both lanes' paid-off builds (the dormant rows, an inert chip), on the Chrome popup and Settings;
// - the paid-tier-on build (CI's third step, STILL_TEST_PAID_TIER), where the bug lived: the Chrome
//   popup and Settings with chips that open Still Pro.
// The Safari popups (DesktopPopup on the Mac, MobilePopup on iPhone) draw the same compact rows
// from the same stylesheet; the Safari build shows its V3 popup only beside the Still app's App
// Group, so in Blink it is covered by the Chrome popup at 375px and 380px plus the unit suites
// (locked-row-no-switch*.test.ts). The Apple app's rows are measured in app-webview-v3-bundle.spec.ts.
// V3 only: a configured 2.x build shows the legacy popup.

const configured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
const paidOn = process.env.STILL_TEST_PAID_TIER === "true";
test.use({ settingsProfile: "modern" });

async function open(context: BrowserContext, extensionId: string, path: string, width: number): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  await expect(page.locator(".option-row, button.expander").first()).toBeVisible();
  // The background answers access after first paint; wait until no row is still checking.
  await expect(page.locator('[data-access="checking"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

test.describe("ISS-0122: locked rows are one line, as tall as a free row", () => {
  test.skip(configured, "The V3 popup and Settings run in unconfigured builds only");

  // A Chrome or Firefox Settings tab at 375px (narrower than a desktop browser window gets) leaves
  // the two longest names no room beside the chip; at the canvas width (432px) every name fits.
  for (const [path, width, height, nameWraps] of [
    ["popup.html", 380, 40, []],
    ["popup.html", 375, 40, []],
    ["options.html", 432, 46, []],
    ["options.html", 375, 46, ["Explore recommendations", "End-of-video suggestions"]],
  ] as const)
    test(`Chrome ${path} at ${width}px: no switch, name and chip on one ${height}px line`, async ({ context, extensionId }) => {
      const page = await open(context, extensionId, path, width);
      const rows = await measureOptionRows(page);
      expectLockedRowsOnOneLine(rows, height, `${path} ${width}px`, nameWraps);
      // Paid off, every locked (dormant) chip is inert; paid on, each has its destination.
      for (const chip of await page.locator(".lock-pro").all())
        if (paidOn) await expect(chip).not.toHaveAttribute("aria-disabled");
        else await expect(chip).toHaveAttribute("aria-disabled", "true");
      await page.close();
    });
});
