import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const promoSource = pathToFileURL(resolve(here, "promo.html")).href;
const storeReadyRoot = resolve(here, "../store-ready");

// Render brand assets only. Functional screenshots come from the actual release build;
// this script must never regenerate them from an old UI capture. Scope reruns to what changed.
const only = process.argv[2];

const promos = [
  { name: "chrome/still-chrome-promo-v2-440x280.jpg", width: 440, height: 280, type: "store-promo", storeReady: true },
  { name: "chrome/still-chrome-marquee-v2-1400x560.jpg", width: 1400, height: 560, type: "store-promo", storeReady: true },
  { name: "web/still-open-graph-v2-1200x630.jpg", width: 1200, height: 630, type: "promo", storeReady: true },
  { name: "apple/still-pro-iap-v3-1024x1024.jpg", width: 1024, height: 1024, type: "iap", storeReady: true },
];

// A typo'd filter must fail loudly BEFORE any rendering: a silent zero-match run exits 0 and
// leaves the previously rendered JPEGs in place looking freshly regenerated.
const knownTypes = new Set(promos.map((p) => p.type));
if (only && !knownTypes.has(only)) {
  console.error(`Unknown filter "${only}" — valid types: ${[...knownTypes].join(", ")}`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const selectedPromos = only ? promos.filter((p) => p.type === only) : promos;
for (const promo of selectedPromos) {
  const output = resolve(storeReadyRoot, promo.name);
  await mkdir(dirname(output), { recursive: true });
  const page = await browser.newPage({ viewport: { width: promo.width, height: promo.height }, deviceScaleFactor: 1 });
  await page.goto(`${promoSource}?type=${promo.type}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: output, type: "jpeg", quality: 95, fullPage: false });
  await page.close();
}
await browser.close();
if (only) console.log(`Rendered ${selectedPromos.length} "${only}" promo(s).`);
