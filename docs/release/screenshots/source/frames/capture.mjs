// Captures the raw desktop screens used by frames.html, with the release Chrome build loaded where
// noted. Each page is captured twice, without Still and with it; nothing else changes between the two.
// Other people's pictures, faces, names and captions are blurred before capture (annotate.js), and
// the "before" shot carries red marker marks on exactly what Still's rule set removes.
//
// Run from the repo root after `pnpm build` (the Chrome build must be the release candidate):
//   node docs/release/screenshots/source/frames/capture.mjs [youtube|shorts-link|tiktok|instagram|facebook|ui ...]
//   node docs/release/screenshots/source/frames/capture.mjs --login   (one time: sign the test accounts in)
//
// Instagram and Facebook only show Reels to a signed-in viewer. They use the dedicated test accounts,
// signed in once with --login into a local profile outside the repo (~/.still-capture/chromium), so no
// credentials or session data ever reach Git. YouTube and TikTok are captured signed out, in a fresh
// profile, so nobody's history shapes the page.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { annotateLibrary, rulesByService } from "./annotate-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "captures/desktop");
const EXT = resolve(HERE, "../../../../../packages/ext-chromium/dist/chrome-mv3");
const APP = resolve(HERE, "../../../../../packages/app-webview/dist");
const PROFILE = resolve(homedir(), ".still-capture/chromium");
const VIEWPORT = { width: 1280, height: 800 };
const RULES = rulesByService();
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const wanted = (name) => !args.filter((a) => !a.startsWith("--")).length || args.includes(name);

// Draft phone captures only: Chromium dressed as iPhone Safari, to lay out the phone frames before the
// Simulator captures exist. Apple screenshots always come from Safari on the Simulator (SIMULATOR-CAPTURE.md).
const IPHONE = { viewport: { width: 393, height: 852 }, scale: 3, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1" };

async function launch({ ext, signedIn, headless = true, viewport = VIEWPORT, scale = 2, isMobile, hasTouch, userAgent }) {
  return chromium.launchPersistentContext(signedIn ? PROFILE : "", {
    channel: "chromium", headless, viewport, deviceScaleFactor: scale, locale: "en-US", bypassCSP: true, isMobile, hasTouch, userAgent,
    args: ext ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : [],
    ignoreDefaultArgs: ["--enable-automation"],
  });
}

// Loads `url`, lets the page settle, blurs, marks the "before" shot, and saves it.
async function shoot(ctx, url, file, { mark, settle = 6000, scroll = 0, labels, prepare } = {}) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(settle);
  if (scroll) { await page.mouse.wheel(0, scroll); await page.waitForTimeout(1500); }
  if (prepare) await prepare(page);
  await page.addScriptTag({ content: annotateLibrary() });
  // First pass closes any "open the app" nag and blurs; the marks are drawn once the page is still.
  await page.evaluate(() => globalThis.StillAnnotate.run({ mark: false }));
  await page.waitForTimeout(1200);
  const result = await page.evaluate((cfg) => globalThis.StillAnnotate.run(cfg), { rules: RULES, mark, labels });
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(OUT, file) });
  console.log(file, JSON.stringify(result));
  return page;
}

// Same page, without Still then with it.
async function pair(name, url, { signedIn = false, headless = true, device = {}, dir = "", ...opts } = {}) {
  for (const on of [false, true]) {
    const ctx = await launch({ ext: on, signedIn, headless, ...device });
    await shoot(ctx, url, `${dir}${name}-${on ? "after" : "before"}.png`, { ...opts, mark: !on });
    await ctx.close();
  }
}

if (args.includes("--login")) {
  // Headed, no extension: the owner signs in to the Instagram and Facebook test accounts, then closes the window.
  const ctx = await launch({ ext: false, signedIn: true, headless: false, scale: 1 });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.instagram.com/accounts/login/");
  await (await ctx.newPage()).goto("https://www.facebook.com/login/");
  console.log("Sign in to the test accounts in the browser window, then close it.");
  await new Promise((r) => ctx.on("close", r));
  process.exit(0);
}

// 1. YouTube search, signed out: shelves of Shorts, the Shorts chip and the Shorts tab, then none of them.
if (wanted("youtube")) await pair("youtube", "https://www.youtube.com/results?search_query=pasta+recipe");

// 2. A Shorts link opens as a normal video with Still on (the address bar would read /watch).
if (wanted("shorts-link")) {
  const ctx = await launch({ ext: false, signedIn: false });
  const page = await ctx.newPage();
  await page.goto("https://www.youtube.com/results?search_query=pasta+recipe", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const href = await page.evaluate(() => document.querySelector('a[href^="/shorts/"]')?.getAttribute("href"));
  await ctx.close();
  if (href) {
    const shorts = `https://www.youtube.com${href.split("?")[0]}`;
    for (const on of [false, true]) {
      const c = await launch({ ext: on, signedIn: false });
      const p = await shoot(c, shorts, `shorts-link-${on ? "after" : "before"}.png`, { mark: false, settle: 3500 });
      console.log("  landed on", p.url());
      await c.close();
    }
  }
}

// 3. The TikTok website: the For You feed, then Still's blocked page.
if (wanted("tiktok")) await pair("tiktok", "https://www.tiktok.com/", { settle: 9000, headless: false });

// 4. Instagram, signed in to the test account: home feed, and the Reels page itself.
if (wanted("instagram")) {
  await pair("instagram", "https://www.instagram.com/", { signedIn: true, settle: 7000 });
  await pair("instagram-reels", "https://www.instagram.com/reels/", { signedIn: true, settle: 7000 });
}

// 5. Facebook, signed in to the test account: home feed, and the Reels page itself.
if (wanted("facebook")) {
  await pair("facebook", "https://www.facebook.com/", { signedIn: true, settle: 8000 });
  await pair("facebook-reels", "https://www.facebook.com/reel/", { signedIn: true, settle: 8000 });
}

// 6. Draft phone captures (layout only, never uploaded to Apple): m.youtube.com and the TikTok website.
if (wanted("mobile-draft")) {
  mkdirSync(resolve(OUT, "../mobile-draft"), { recursive: true });
  const draft = { device: IPHONE, dir: "../mobile-draft/" };
  await pair("youtube", "https://m.youtube.com/results?search_query=pasta+recipe", { ...draft, settle: 7000 });
  await pair("tiktok", "https://www.tiktok.com/", { ...draft, settle: 9000, headless: false });
}

// 7. Still's own UI: the Chrome popup (signed out, defaults) and the Apple app's web UI at iPhone size.
if (wanted("ui")) {
  const ctx = await launch({ ext: true, signedIn: false, viewport: { width: 380, height: 700 }, scale: 3 });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`); await pop.waitForTimeout(2000);
  await pop.screenshot({ path: resolve(OUT, "popup.png"), fullPage: true });
  await ctx.close();

  const server = spawn("python3", ["-m", "http.server", "8766"], { cwd: APP, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const b = await chromium.launch();
  const phone = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await phone.goto("http://localhost:8766/index.html"); await phone.waitForTimeout(2500);
  await phone.screenshot({ path: resolve(OUT, "app-iphone.png"), fullPage: true });
  await b.close(); server.kill();
}
