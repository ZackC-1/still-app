import type { Page } from "@playwright/test";
import { test, expect } from "./_extension.js";

// Owner rulings R1 and R2 on the 22 Oct canvas fidelity check, measured in the real popup: the
// hero's title and switch sit 16px inside the blue card (canvas P-Hero: padding 12px 16px), and the
// footer's two links are 14px with 4px above and below (canvas P-PopupFooter: padding 4px 16px).
// The Safari popups use the same compact hero and footer rules.
//
// V3 only: a configured 2.x build shows the legacy popup.
const configured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
test.use({ settingsProfile: configured ? "fresh" : "modern" });

async function openPopup(page: Page, extensionId: string) {
  await page.setViewportSize({ width: 380, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('.app[data-density="compact"]')).toBeVisible();
}

const box = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
  });

test.describe("popup canvas insets (R1, R2)", () => {
  test.skip(configured, "The V3 popup runs in unconfigured builds only");

  test("the hero's title and switch sit 16px inside the blue card", async ({ page, extensionId }) => {
    await openPopup(page, extensionId);
    const hero = await box(page, ".hero.compact");
    const title = await page.locator(".hero.compact h1").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().left;
    });
    const toggle = await box(page, '.hero.compact [role="switch"]');
    expect(title - hero.left).toBeCloseTo(16, 0);
    expect(hero.right - toggle.right).toBeCloseTo(16, 0);
    expect(hero.height).toBeCloseTo(55, 0);
  });

  test("the footer links are 14px with 4px above and below", async ({ page, extensionId }) => {
    await openPopup(page, extensionId);
    const footer = page.locator(".popup-footer");
    const style = await footer.evaluate((element) => {
      const s = getComputedStyle(element);
      return { top: s.paddingTop, bottom: s.paddingBottom, size: s.fontSize };
    });
    expect(style).toEqual({ top: "4px", bottom: "4px", size: "14px" });
    for (const link of [footer.locator(".open-options"), footer.locator("a.link")])
      expect(await link.evaluate((element) => getComputedStyle(element).fontSize)).toBe("14px");
    const outer = await box(page, ".popup-footer");
    const link = await box(page, ".popup-footer a.link");
    expect(link.top - outer.top).toBeCloseTo(4, 0);
    expect(outer.bottom - link.bottom).toBeCloseTo(4, 0);
  });
});
