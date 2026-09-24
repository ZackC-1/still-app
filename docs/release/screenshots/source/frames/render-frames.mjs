// Renders the showcase images described in frames.json through frames.html, at each store's exact size.
// Usage: node docs/release/screenshots/source/frames/render-frames.mjs [id-or-canvas ...]
// Writes store-ready/<canvas out>/<id>-<W>x<H>.<png|jpg> and a contact sheet (contact-sheet.html) for review.
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../store-ready");
const { canvases, frames } = JSON.parse(readFileSync(resolve(HERE, "frames.json"), "utf8"));
const args = process.argv.slice(2);
const chosen = frames.filter((f) => !args.length || args.includes(f.id) || args.includes(f.canvas));

const browser = await chromium.launch();
const made = [];
for (const f of chosen) {
  const c = canvases[f.canvas];
  const missing = f.captures.map((x) => x.src).filter((src) => !existsSync(resolve(HERE, src)));
  if (missing.length) { console.log(`skip ${f.id}: missing ${missing.join(", ")}`); continue; }
  const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: c.scale });
  await page.goto(pathToFileURL(resolve(HERE, "frames.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((e) => window.render(e), f);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.style.width));
  await page.waitForTimeout(200);
  const dir = resolve(OUT, c.out);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${f.draft ? "DRAFT-" : ""}${f.id}-${c.w * c.scale}x${c.h * c.scale}.${c.format}`);
  // Apple and the browser stores want flat RGB with no transparency.
  await page.screenshot({ path: file, type: c.format === "jpg" ? "jpeg" : "png", quality: c.format === "jpg" ? 92 : undefined, omitBackground: false });
  await page.close();
  made.push({ ...f, file, size: `${c.w * c.scale}×${c.h * c.scale}` });
  console.log(relative(process.cwd(), file) + (f.draft ? `  (DRAFT: ${f.draft})` : ""));
}
await browser.close();

// Contact sheet: every image at a store-thumbnail width and at a larger size, drafts flagged.
const sheet = resolve(HERE, "contact-sheet.html");
writeFileSync(sheet, `<!doctype html><meta charset="utf-8"><title>Still showcase contact sheet</title>
<style>body{font:14px Inter,system-ui;background:#eef0f6;margin:24px;color:#0b1430}h2{margin:28px 0 8px}
.row{display:flex;gap:18px;align-items:flex-end;flex-wrap:wrap}figure{margin:0}img{display:block;box-shadow:0 6px 20px #0002;border-radius:6px}
.thumb img{height:150px}.big img{height:520px}figcaption{margin-top:6px;max-width:520px}.draft{color:#c2410c;font-weight:600}</style>
${made.map((m) => `<h2>${m.id} <small>${m.size}</small></h2>${m.draft ? `<p class="draft">Draft: ${m.draft}</p>` : ""}
<div class="row"><figure class="big"><img src="${pathToFileURL(m.file).href}"></figure><figure class="thumb"><img src="${pathToFileURL(m.file).href}"><figcaption>thumbnail</figcaption></figure></div>`).join("\n")}`);
console.log("contact sheet:", relative(process.cwd(), sheet));
