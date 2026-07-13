import { chromium } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = pathToFileURL(resolve(here, "index.html")).href;
const promoSource = pathToFileURL(resolve(here, "promo.html")).href;
const outputRoot = resolve(here, "../v2");
const storeReadyRoot = resolve(here, "../store-ready");

const targets = [
  { platform: "chrome", width: 1280, height: 800, orientation: "landscape" },
  { platform: "firefox", width: 1280, height: 800, orientation: "landscape" },
  { platform: "macos", width: 2880, height: 1800, orientation: "landscape" },
  { platform: "iphone", width: 1290, height: 2796, orientation: "portrait" },
  { platform: "ipad", width: 2064, height: 2752, orientation: "portrait" },
];

const browser = await chromium.launch({ headless: true });
for (const target of targets) {
  const outputDir = resolve(outputRoot, target.platform);
  await mkdir(outputDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: target.width, height: target.height }, deviceScaleFactor: 1 });
  for (let scene = 1; scene <= 6; scene += 1) {
    await page.goto(`${source}?platform=${target.platform}&orientation=${target.orientation}&scene=${scene}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => {
      const image = document.querySelector(".device img");
      return !image || image.complete;
    });
    const name = `still-${target.platform}-v2-${String(scene).padStart(2, "0")}-${target.width}x${target.height}.jpg`;
    const output = resolve(outputDir, name);
    await page.screenshot({ path: output, type: "jpeg", quality: 95, fullPage: false });
    const shouldUpload = target.platform === "chrome" ? scene <= 5 : target.platform !== "firefox";
    if (shouldUpload) {
      const storeOutput = resolve(storeReadyRoot, target.platform, name);
      await mkdir(dirname(storeOutput), { recursive: true });
      await copyFile(output, storeOutput);
    }
  }
  await page.close();
}

{
  const output = resolve(storeReadyRoot, "firefox/still-firefox-store-01-1280x800.jpg");
  await mkdir(dirname(output), { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${source}?platform=firefox&orientation=landscape&scene=1&store=1`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelector(".device img")?.complete);
  await page.screenshot({ path: output, type: "jpeg", quality: 95, fullPage: false });
  await page.close();
}

const promos = [
  { name: "chrome/still-chrome-promo-v2-440x280.jpg", width: 440, height: 280, type: "store-promo", storeReady: true },
  { name: "chrome/still-chrome-marquee-v2-1400x560.jpg", width: 1400, height: 560, type: "store-promo", storeReady: true },
  { name: "web/still-open-graph-v2-1200x630.jpg", width: 1200, height: 630, type: "promo" },
  { name: "apple/still-pro-iap-v2-1024x1024.jpg", width: 1024, height: 1024, type: "iap", storeReady: true },
];
for (const promo of promos) {
  const output = resolve(outputRoot, promo.name);
  await mkdir(dirname(output), { recursive: true });
  const page = await browser.newPage({ viewport: { width: promo.width, height: promo.height }, deviceScaleFactor: 1 });
  await page.goto(`${promoSource}?type=${promo.type}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: output, type: "jpeg", quality: 95, fullPage: false });
  if (promo.storeReady) {
    const storeOutput = resolve(storeReadyRoot, promo.name);
    await mkdir(dirname(storeOutput), { recursive: true });
    await copyFile(output, storeOutput);
  }
  await page.close();
}
await browser.close();
