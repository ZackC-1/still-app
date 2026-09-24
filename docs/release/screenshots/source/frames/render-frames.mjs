// Renders the captioned store screenshots from frames.html (1280x800 PNG, RGB).
// Usage: node docs/release/screenshots/source/frames/render-frames.mjs [frame ...]
import { chromium } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../store-ready/browser-v3");
const FRAMES = ["youtube", "switches", "sync", "tiktok"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : FRAMES;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
for (const [i, frame] of FRAMES.entries()) {
  if (!wanted.includes(frame)) continue;
  await page.goto(`${pathToFileURL(resolve(HERE, "frames.html")).href}?frame=${frame}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const file = resolve(OUT, `still-${String(i + 1).padStart(2, "0")}-${frame}-1280x800.png`);
  await page.screenshot({ path: file, omitBackground: false });
  console.log(file);
}
await browser.close();
