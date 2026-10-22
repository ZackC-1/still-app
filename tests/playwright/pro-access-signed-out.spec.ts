import { test, expect } from "./_extension.js";
import type { Page } from "@playwright/test";
import { PAID_TIER_ENABLED } from "../../packages/shared-types/src/entitlement.js";

// ISS-0030 on the built Chromium extension: a fresh, signed-out, never-bought install must never
// sit in "verify again". Lane-aware:
// - Paid tier compiled ON (QA builds; not either CI lane today): every supported Still Pro row is
//   locked with the "Still Pro" lock action, and no row or card asks to verify again.
// - Paid tier compiled OFF (both CI lanes): Still Pro rows are dormant (shown locked, no action),
//   and still nothing asks to verify again or shows the checking spinner once the page settles.
//   In CI this is a dormancy guard only: the ISS-0030 regression lives in paid-on builds, so its
//   gating coverage is the unit and host suites (signed-out-access, background-scoped-access,
//   browser-pro-host). Run this spec against a paid-on build to check the real states.
// Rows need committed schema-2 settings (the V3 popup and settings), so they run only in the
// unconfigured lane, as the dormancy spec does. The page-wide check runs in BOTH lanes.

const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
const VERIFY_AGAIN = "Still Pro needs to be verified again.";
const ROWS_BY_SERVICE = {
  YouTube: ["Related videos", "End-of-video suggestions", "Autoplay prevention", "Comments", "Live chat"],
  Instagram: ["Explore recommendations", "Stories and Highlights", "Suggested accounts", "Threads links"],
  Facebook: ["Stories", "Video tab", "Desktop sidebar ads"],
} as const;

async function openSection(page: Page, service: keyof typeof ROWS_BY_SERVICE) {
  const header = page.getByRole("button", { name: new RegExp(`^${service} Blocker`) });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

test.describe("signed-out Still Pro rows (schema-2 lane)", () => {
  test.skip(syncConfigured, "Format-2 lane needs committed schema-2 settings; configured builds stay on the legacy lane");
  test.use({ settingsProfile: "modern" });

  for (const surface of ["popup", "options"] as const)
    test(`${surface}: every Still Pro row is locked, none asks to verify`, async ({ context, extensionId }) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${surface}.html`);
      await expect(page.locator("body")).toContainText("Still is");

      let inspected = 0;
      for (const [service, names] of Object.entries(ROWS_BY_SERVICE) as [keyof typeof ROWS_BY_SERVICE, readonly string[]][]) {
        await openSection(page, service);
        for (const name of names) {
          const row = page.locator(".option-row").filter({ has: page.locator(".label", { hasText: new RegExp(`^${name}$`) }) });
          await expect(row, `${name} is shown once`).toHaveCount(1);
          // The background answers after first paint; a locked answer must arrive and stay.
          await expect(row, `${name} is locked`).toHaveAttribute("data-access", "locked");
          await expect(row.getByText("Still Pro", { exact: true }), `${name} carries the Still Pro lock`).toBeVisible();
          if (PAID_TIER_ENABLED) {
            await expect(row.getByRole("button", { name: new RegExp(`^${name}\\. Included in Still Pro`) })).toBeVisible();
          }
          await expect(row.getByRole("switch"), `${name} is not a switch`).toHaveCount(0);
          inspected++;
        }
      }
      expect(inspected, "every Still Pro row was inspected").toBe(12);
      await expect(page.locator('[data-access="verify"], [data-access="checking"]')).toHaveCount(0);
    });
});

// Both lanes: nothing on a fresh signed-out install's popup or settings asks to verify again.
for (const surface of ["popup", "options"] as const)
  test(`${surface}: a fresh signed-out install never says Still Pro needs verifying`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${surface}.html`);
    await expect(page.getByRole("switch").first()).toBeVisible();
    // The V3 pages seed Still Pro rows as checking until the background answers; wait for that
    // answer (legacy configured pages have no such rows and pass straight through).
    await expect(page.locator('[data-access="checking"]')).toHaveCount(0);
    await expect(page.getByText(VERIFY_AGAIN)).toHaveCount(0);
    await expect(page.locator('[data-access="verify"]')).toHaveCount(0);
    if (PAID_TIER_ENABLED && surface === "options" && syncConfigured) {
      // Paid builds with sign-in offer Get Still Pro to a signed-out install (the V3 card's own
      // states are covered by entrypoints/options/__tests__/browser-pro-host.test.ts).
      await expect(page.getByRole("button", { name: "Get Still Pro" })).toBeVisible();
    }
  });
