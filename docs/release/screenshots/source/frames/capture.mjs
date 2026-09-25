// Captures the raw desktop screens used by frames.html, with the release Chrome build loaded where
// noted. Each page is captured twice, without Still and with it; nothing else changes between the two.
// Pages are captured as they really look, unblurred (owner decision); pick queries and accounts so the
// content is safe for a store listing, and review every capture before use. The "before" shot carries
// red marker marks on exactly what Still's rule set removes (annotate.js).
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
import { SOURCES } from "./sources.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "captures/desktop");
const EXT = resolve(HERE, "../../../../../packages/ext-chromium/dist/chrome-mv3");
const APP = resolve(HERE, "../../../../../packages/app-webview/dist");
const PROFILE = resolve(homedir(), ".still-capture/chromium");
const VIEWPORT = { width: 1280, height: 800 };
const RULES = rulesByService();
// Names to cover on signed-in pages (the account's own name), passed at run time and never stored:
// REDACT="First Last,Other Name" node capture.mjs facebook
const REDACT = (process.env.REDACT || "").split(",").map((n) => n.trim()).filter(Boolean);
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

// Loads `url`, lets the page settle, marks the "before" shot, and saves it.
async function shoot(ctx, url, file, { mark, settle = 6000, scroll = 0, labels, prepare } = {}) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(settle);
  if (scroll) { await page.mouse.wheel(0, scroll); await page.waitForTimeout(1500); }
  if (prepare) await prepare(page);
  await page.addScriptTag({ content: annotateLibrary() });
  // First pass closes any "open the app" nag; the marks are drawn once the page is still.
  await page.evaluate((redact) => globalThis.StillAnnotate.run({ mark: false, redact }), REDACT);
  await page.waitForTimeout(1200);
  const result = await page.evaluate((cfg) => globalThis.StillAnnotate.run(cfg), { rules: RULES, mark, labels, redact: REDACT });
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(OUT, file) });
  console.log(file, JSON.stringify(result));
  return page;
}

// Same page, without Still then with it.
async function pair(name, url, { signedIn = false, headless = true, device = {}, dir = "", marks = true, ...opts } = {}) {
  for (const on of [false, true]) {
    const ctx = await launch({ ext: on, signedIn, headless, ...device });
    await shoot(ctx, url, `${dir}${name}-${on ? "after" : "before"}.png`, { ...opts, mark: on ? false : marks });
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
if (wanted("youtube")) await pair("youtube", SOURCES.youtube);

// 2. A Shorts link opens as a normal video with Still on (the address bar would read /watch).
if (wanted("shorts-link")) {
  const ctx = await launch({ ext: false, signedIn: false });
  const page = await ctx.newPage();
  await page.goto(SOURCES.youtube, { waitUntil: "domcontentloaded" });
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

// 3. The TikTok website: a public hashtag page (not the For You feed, whose videos are random), then
// Still's blocked page.
const TIKTOK = SOURCES.tiktok;
if (wanted("tiktok")) await pair("tiktok", TIKTOK, { settle: 9000, headless: false });

// 4. Instagram, signed in to the test account: home feed, and the Reels page itself.
if (wanted("instagram")) {
  await feedPair("instagram", SOURCES.instagramFeed, () => {
    const reel = [...document.querySelectorAll('article a[href*="/reel/"], article video')].map((e) => e.closest("article")).find(Boolean);
    return reel ? Math.max(1, reel.getBoundingClientRect().top + scrollY - 20) : 0;
  });
  await pair("instagram-reels", SOURCES.instagramReels, { signedIn: true, settle: 7000,
    marks: { circle: ['a[href="/reels/"]'], largestMedia: true } });
}

// A feed captured at its first short-form post: the "before" shot scrolls until one is in view, and
// the "after" shot keeps the same scroll, so the post is simply gone.
async function feedPair(name, url, find) {
  let offset = 0;
  for (const on of [false, true]) {
    const ctx = await launch({ ext: on, signedIn: true });
    await shoot(ctx, url, `${name}-${on ? "after" : "before"}.png`, {
      mark: !on, settle: 8000,
      prepare: async (page) => {
        for (let i = 0; i < 14 && !offset && !on; i++) {
          const y = await page.evaluate(find);
          if (y) { offset = y; break; }
          await page.mouse.wheel(0, 900); await page.waitForTimeout(1300);
        }
        await page.evaluate((y) => scrollTo(0, y), offset);
        await page.waitForTimeout(1500);
      },
    });
    await ctx.close();
  }
}

// 4b. A public profile's Reels grid (signed in): every Reel tile crossed out, then Still's cleared page.
if (wanted("instagram-profile")) {
  await pair("instagram-profile-reels", SOURCES.instagramProfileReels, { signedIn: true, settle: 8000, scroll: 420,
    marks: { circle: ['a[href="/reels/"]', 'a[href$="/reels/"][role="tab"]', 'a[href$="/reels/"]'], x: ['main a[href*="/reel/"]'] } });
  // The same profile with Still on: its posts stay and the Reels tab is gone.
  const ctx = await launch({ ext: true, signedIn: true });
  await shoot(ctx, SOURCES.instagramProfile, "instagram-profile-after.png", { mark: false, settle: 8000, scroll: 420 });
  await ctx.close();
}

// 5. Facebook, signed in to the test account. Only the Page Reels tab is used in images: the home
// feed is random and shows private people, so feedPair here is for checking behaviour, not for stores.
if (wanted("facebook")) {
  await feedPair("facebook", SOURCES.facebookFeed, () => {
    // The feed's Reels shelf if there is one, otherwise the first Reel post; a little of the post above
    // stays in view so the "after" reads as the same feed with the Reels gone.
    const shelf = document.querySelector('div[role="grid"][aria-label="Reels"]');
    const reel = shelf ?? document.querySelector('[role="feed"] a[href*="/reel/"], [role="main"] a[href*="/reel/"]');
    const post = shelf ?? reel?.closest('[role="article"]') ?? reel?.closest("[aria-posinset]") ?? reel;
    return post ? Math.max(1, post.getBoundingClientRect().top + scrollY - 260) : 0;
  });
}

if (wanted("facebook") || wanted("facebook-reels")) {
  // A public Page's Reels tab.
  await pair(process.env.FB_NAME || "facebook-reels", SOURCES.facebookReels, { signedIn: true, settle: 8000 });
}

// 6. Draft phone captures (layout only, never uploaded to Apple): m.youtube.com and the TikTok website.
if (wanted("mobile-draft")) {
  mkdirSync(resolve(OUT, "../mobile-draft"), { recursive: true });
  const draft = { device: IPHONE, dir: "../mobile-draft/" };
  await pair("youtube", SOURCES.youtubeMobile, { ...draft, settle: 7000 });
  await pair("tiktok", TIKTOK, { ...draft, settle: 9000, headless: false });
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
