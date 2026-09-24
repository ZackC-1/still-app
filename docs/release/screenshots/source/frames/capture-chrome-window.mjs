// Still's own interface in Chrome, for the Chrome Web Store: the toolbar popup open in a real browser
// window, and the settings page. Uses Playwright's Chromium (Chrome for Testing) with the release build
// loaded and pinned to the toolbar, opens the popup with chrome.action.openPopup(), and captures the
// window with macOS screencapture. Run from the repo root after `pnpm build`:
//   node docs/release/screenshots/source/frames/capture-chrome-window.mjs
// Needs Screen Recording permission for the terminal. Writes captures/chrome-ui/.
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "../../../../../packages/ext-chromium/dist/chrome-mv3");
const OUT = resolve(HERE, "captures/chrome-ui");
const WINLIST = resolve(tmpdir(), "still-winlist");
const START = "https://www.youtube.com/results?search_query=pasta+recipe";
const CDP_PORT = 9337;
mkdirSync(OUT, { recursive: true });
execFileSync("swiftc", ["-O", resolve(HERE, "tools/winlist.swift"), "-o", WINLIST]);

// An unpacked extension's ID is the SHA-256 of its path, first 32 hex digits spelled a–p.
const ID = [...createHash("sha256").update(EXT).digest("hex").slice(0, 32)].map((c) => "abcdefghijklmnop"[parseInt(c, 16)]).join("");

// Pin Still next to the address bar, as a user would, by seeding the profile's preferences.
const profile = mkdtempSync(resolve(tmpdir(), "still-chrome-ui-"));
mkdirSync(resolve(profile, "Default"), { recursive: true });
writeFileSync(resolve(profile, "Default/Preferences"), JSON.stringify({ extensions: { pinned_extensions: [ID] }, browser: { has_seen_welcome_page: true } }));

const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: null, locale: "en-US",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--window-position=60,60", "--window-size=1440,900", "--hide-crash-restore-bubble", `--remote-debugging-port=${CDP_PORT}`],
  ignoreDefaultArgs: ["--enable-automation"],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(START, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
await page.bringToFront();

const windows = () => execFileSync(WINLIST, ["Google Chrome for Testing"]).toString().trim().split("\n").filter(Boolean)
  .map((l) => { const [id, layer, x, y, w, h] = l.split(" ").map(Number); return { id, layer, x, y, w, h }; });

// 1. The popup, opened from the toolbar icon. Chrome draws an action popup in its own small window,
// which a window capture of the browser leaves out, so the popup's pixels come from Chrome itself (its
// DevTools protocol) and are laid over the window capture exactly where the popup sits on screen.
async function popupPng() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const t = targets.find((x) => x.url.endsWith("/popup.html"));
  if (!t) throw new Error("no popup target: " + targets.map((x) => x.url).join(", "));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const data = await new Promise((r) => {
    ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result.data); });
    ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
  });
  ws.close();
  return Buffer.from(data, "base64");
}

await sw.evaluate(() => chrome.action.openPopup());
await page.waitForTimeout(2500);
const all = windows().sort((a, b) => b.w * b.h - a.w * a.h);
const main = all[0], popup = all.find((w) => w !== main && w.w < 520 && w.h > 250);
if (!popup) throw new Error("the popup did not open: " + JSON.stringify(all));
const mainPng = resolve(tmpdir(), "still-chrome-main.png"), popPng = resolve(tmpdir(), "still-chrome-popup.png");
writeFileSync(popPng, await popupPng());
execFileSync("screencapture", ["-x", "-o", `-l${main.id}`, mainPng]);
// Chrome's popup frame: rounded corners and a soft shadow, as macOS draws it.
execFileSync("python3", ["-c", `
from PIL import Image, ImageDraw, ImageFilter
m = Image.open(${JSON.stringify(mainPng)}).convert("RGBA"); p = Image.open(${JSON.stringify(popPng)}).convert("RGBA")
k = m.width / ${main.w}
p = p.resize((round(${popup.w} * k), round(${popup.h} * k)))
r = round(10 * k)
mask = Image.new("L", p.size, 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, p.width - 1, p.height - 1], r, fill=255)
x, y = round((${popup.x} - ${main.x}) * k), round((${popup.y} - ${main.y}) * k)
sh = Image.new("RGBA", m.size, (0, 0, 0, 0)); sm = Image.new("L", m.size, 0)
sm.paste(mask, (x, y + round(6 * k))); sh.putalpha(sm.filter(ImageFilter.GaussianBlur(round(14 * k))).point(lambda v: v * 0.35))
m = Image.alpha_composite(m, sh); m.paste(p, (x, y), mask)
m.convert("RGB").save(${JSON.stringify(resolve(OUT, "window-popup.png"))})`]);
console.log("window-popup.png", JSON.stringify({ main, popup }));

// 2. The settings page, as the popup's "Open settings" link shows it.
const opts = await ctx.newPage();
await opts.setViewportSize({ width: 900, height: 1100 });
await opts.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
await opts.waitForTimeout(2000);
await opts.screenshot({ path: resolve(OUT, "options.png"), fullPage: true, scale: "device" });
console.log("options.png");
await ctx.close();
