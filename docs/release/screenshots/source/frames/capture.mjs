// Captures the raw screens used by frames.html, with the release Chrome build loaded where noted.
// Other people's pictures, faces, names, titles and descriptions on YouTube are blurred before
// capture; Still's own UI and YouTube's navigation stay sharp. Run from the repo root after
// `pnpm build` (the Chrome build must be the release candidate), then render-frames.mjs.
import { chromium } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "captures") + "/";
const EXT = resolve(HERE, "../../../../../packages/ext-chromium/dist/chrome-mv3");
const APP = resolve(HERE, "../../../../../packages/app-webview/dist");
const BLUR = `
  ytd-thumbnail, yt-thumbnail-view-model, .ytThumbnailViewModelImage, yt-image, img.yt-core-image,
  #avatar, yt-img-shadow, yt-avatar-shape { filter: blur(9px) !important; }
  ytd-video-renderer .text-wrapper, ytd-video-renderer #meta, ytd-video-renderer #dismissible > div:not(ytd-thumbnail),
  ytm-shorts-lockup-view-model h3, .shortsLockupViewModelHostOutsideMetadata, .shortsLockupViewModelHostMetadata,
  yt-lockup-metadata-view-model, ytd-channel-renderer, ytd-universal-watch-card-renderer, ytd-horizontal-card-list-renderer #items
  { filter: blur(5px) !important; }`;
const withExt = (on) => (on ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : []);

// 1. YouTube search results, signed out, without and with Still.
for (const [on, name] of [[false, "yt-before"], [true, "yt-after"]]) {
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, args: withExt(on), locale: "en-US" });
  const p = await ctx.newPage();
  await p.goto("https://www.youtube.com/results?search_query=pasta+recipe", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(6000);
  await p.addStyleTag({ content: BLUR });
  // Without Still, circle every Shorts entry point in red so it's clear how much of the page they take.
  if (!on) {
    await p.evaluate(() => {
      const mark = (el, label, pad = 8, below = false) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const box = document.createElement("div");
        Object.assign(box.style, { position: "absolute", left: `${r.left + scrollX - pad}px`, top: `${r.top + scrollY - pad}px`,
          width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`, border: "6px solid #ff2d2d", borderRadius: "22px",
          boxShadow: "0 0 0 3px rgba(255,45,45,.25)", zIndex: 99999, pointerEvents: "none" });
        if (label) {
          const tag = document.createElement("span");
          tag.textContent = label;
          Object.assign(tag.style, { position: "absolute", right: below ? "auto" : "10px", left: below ? "-4px" : "auto",
            top: below ? "calc(100% + 8px)" : "-15px", whiteSpace: "nowrap", background: "#ff2d2d", color: "white",
            font: "700 13px/1 Roboto, Arial, sans-serif", padding: "6px 10px", borderRadius: "999px", letterSpacing: ".02em" });
          box.appendChild(tag);
        }
        document.body.appendChild(box);
      };
      const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text);
      mark(byText("yt-chip-cloud-chip-renderer, chip-view-model, yt-chip-cloud-chip-renderer button", "Shorts"), "", 5);
      const tab = [...document.querySelectorAll('ytd-mini-guide-entry-renderer, ytd-guide-entry-renderer, a[title="Shorts"]')]
        .find((e) => /^\s*Shorts\s*$/.test(e.textContent) || e.getAttribute("title") === "Shorts" || e.querySelector('[title="Shorts"]'));
      mark(tab?.closest("ytd-mini-guide-entry-renderer, ytd-guide-entry-renderer") ?? tab, "", 4);
      const shelves = [...document.querySelectorAll("grid-shelf-view-model, ytd-reel-shelf-renderer")].filter((e) => e.getBoundingClientRect().height > 50);
      shelves.forEach((s, i) => mark(s, i === 0 ? "Shorts shelf" : "More Shorts", 6));
    });
  }
  await p.waitForTimeout(800);
  await p.screenshot({ path: OUT + name + ".png" });
  await ctx.close();
}

// 2. Still's popup (signed out, defaults) and the TikTok website with Still on.
const ctx = await chromium.launchPersistentContext("", { channel: "chromium", viewport: { width: 380, height: 700 }, deviceScaleFactor: 3, args: withExt(true), locale: "en-US" });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`); await pop.waitForTimeout(2000);
await pop.screenshot({ path: OUT + "popup.png", fullPage: true });
const tt = await ctx.newPage(); await tt.setViewportSize({ width: 1280, height: 800 });
await tt.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
await tt.waitForTimeout(3000);
await tt.screenshot({ path: OUT + "tiktok.png" });
await ctx.close();

// 3. The Still app's screen at iPhone size (the Apple app's own web UI, outside the native shell).
const server = spawn("python3", ["-m", "http.server", "8766"], { cwd: APP, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const b = await chromium.launch();
const phone = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await phone.goto("http://localhost:8766/index.html"); await phone.waitForTimeout(2500);
await phone.screenshot({ path: OUT + "app-iphone.png", fullPage: true });
await b.close(); server.kill();
