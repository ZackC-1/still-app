import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Contract test for the promoted-IAP promotional image source (Guideline 2.3.2 recurrence guard).
// Apple rejected this asset's lineage twice: an app screenshot with small/price text (v1) and a
// small-subline risk (v2). The canonical compliance rules live in
// docs/release/screenshots/store-ready/README.md; these assertions pin the ones a DOM render can
// prove. Final visual sign-off of the rendered JPEG stays human (see runbook §7).
//
// Plain @playwright/test on the file:// page — deliberately NOT the ./_extension.js fixture,
// which launches a persistent context loading the built extension from gitignored dist/.

const IAP_CANVAS = 1024;
// Internal convention (Apple publishes no figure): the bottom-left 30% × 30% of the canvas stays
// content-free because App Store search placements composite the real app icon there.
const SAFE_ZONE_FRACTION = 0.3;
// Headline floor: ≥ 12% of the canvas so the sole text survives thumbnail scaling.
const MIN_HEADLINE_PX = IAP_CANVAS * 0.12;

const promoUrl = `${pathToFileURL(resolve("docs/release/screenshots/source/promo.html")).href}?type=iap`;

test.use({ viewport: { width: IAP_CANVAS, height: IAP_CANVAS } });

test.beforeEach(async ({ page }) => {
  await page.goto(promoUrl);
  await page.evaluate(() => document.fonts.ready);
});

test("iap promo: no price-shaped text", async ({ page }) => {
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\$|\d+[.,]\d{2}|price/i);
});

test("iap promo: the sole text is the product name — no sentence-length copy", async ({ page }) => {
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
  expect(text).toBe("Still Pro");
});

test("iap promo: headline is large enough to survive thumbnail scaling", async ({ page }) => {
  const size = await page
    .locator("h1")
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeGreaterThanOrEqual(MIN_HEADLINE_PX);
});

test("iap promo: lower-left safe zone is content-free (Apple composites the app icon there)", async ({ page }) => {
  const boxes = await page.evaluate(() => {
    const rects: { x: number; y: number; w: number; h: number; what: string }[] = [];
    const push = (r: DOMRect, what: string) => {
      if (r.width > 0 && r.height > 0) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height, what });
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) push(r, `text "${node.textContent.trim()}"`);
    }
    for (const el of document.querySelectorAll<HTMLElement>(".mark, .screen")) {
      if (getComputedStyle(el).display !== "none") push(el.getBoundingClientRect(), `element .${el.className}`);
    }
    return rects;
  });
  const zone = {
    right: IAP_CANVAS * SAFE_ZONE_FRACTION,
    top: IAP_CANVAS * (1 - SAFE_ZONE_FRACTION),
  };
  for (const b of boxes) {
    const intersects = b.x < zone.right && b.y + b.h > zone.top;
    expect(intersects, `${b.what} intersects the lower-left safe zone`).toBe(false);
  }
});
