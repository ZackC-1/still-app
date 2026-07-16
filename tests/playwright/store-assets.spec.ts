import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Contract test for the promoted-IAP promotional image source (Guideline 2.3.2 recurrence guard).
// Apple rejected this asset's lineage twice: an app screenshot with small/price text (v1) and a
// small-subline risk (v2). The canonical compliance rules live in
// docs/release/screenshots/store-ready/README.md; these assertions pin the ones a DOM render can
// prove, plus the committed JPEG's existence and dimensions. Final visual sign-off of the rendered
// JPEG stays human (see runbook §7) — DOM-level checks cannot see raster drift.
//
// Plain @playwright/test on the file:// page — deliberately NOT the ./_extension.js fixture,
// which launches a persistent context loading the built extension from gitignored dist/.

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_HTML = resolve(HERE, "../../docs/release/screenshots/source/promo.html");
const RENDER_MJS = resolve(HERE, "../../docs/release/screenshots/source/render.mjs");
const STORE_READY_JPEG = resolve(
  HERE,
  "../../docs/release/screenshots/store-ready/apple/still-pro-iap-v3-1024x1024.jpg",
);

const IAP_CANVAS = 1024;
// Internal convention (Apple publishes no figure): the bottom-left 30% × 30% of the canvas stays
// content-free because App Store search placements composite the real app icon there.
const SAFE_ZONE_FRACTION = 0.3;
// Headline floor: ≥ 12% of the canvas so the sole text survives thumbnail scaling.
const MIN_HEADLINE_PX = IAP_CANVAS * 0.12;

const promoUrl = `${pathToFileURL(SOURCE_HTML).href}?type=iap`;

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
  // Generic sweep: every text rect plus every visibly-styled element smaller than half the canvas
  // (full-bleed containers are the background itself, not content). No class allowlist, so future
  // motifs/badges/images are caught without editing this test. Known limitation: pseudo-element
  // geometry (::before/::after) is not directly measurable; today's only pseudo (the decorative
  // circle) is anchored top-right by the source CSS.
  const boxes = await page.evaluate((canvas) => {
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
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const styled =
        (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") ||
        style.backgroundImage !== "none" ||
        Number.parseFloat(style.borderTopWidth) > 0 ||
        style.boxShadow !== "none";
      if (!styled) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= canvas * canvas * 0.5) continue; // full-bleed background, not content
      push(r, `element <${el.tagName.toLowerCase()} class="${el.className}">`);
    }
    return rects;
  }, IAP_CANVAS);
  // Sanity: the sweep must see at least the headline — an empty list means the probe broke, not
  // that the design is clean.
  expect(boxes.length).toBeGreaterThan(0);
  const zone = {
    right: IAP_CANVAS * SAFE_ZONE_FRACTION,
    top: IAP_CANVAS * (1 - SAFE_ZONE_FRACTION),
  };
  for (const b of boxes) {
    const intersects = b.x < zone.right && b.y + b.h > zone.top;
    expect(intersects, `${b.what} intersects the lower-left safe zone`).toBe(false);
  }
});

test("committed store-ready v3 JPEG exists at 1024x1024", () => {
  const buf = readFileSync(STORE_READY_JPEG);
  expect(jpegDimensions(buf)).toEqual({ width: IAP_CANVAS, height: IAP_CANVAS });
});

test("render.mjs rejects an unknown filter argument before rendering anything", () => {
  const result = spawnSync(process.execPath, [RENDER_MJS, "bogus"], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Unknown filter "bogus"');
});

// Minimal JPEG SOF scan: find the start-of-frame marker and read the encoded height/width.
function jpegDimensions(buf: Buffer): { width: number; height: number } {
  expect(buf.readUInt16BE(0)).toBe(0xffd8); // SOI
  let offset = 2;
  while (offset < buf.length - 9) {
    if (buf[offset] !== 0xff) throw new Error(`JPEG marker expected at ${offset}`);
    const marker = buf[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + buf.readUInt16BE(offset + 2);
  }
  throw new Error("no SOF marker found");
}
