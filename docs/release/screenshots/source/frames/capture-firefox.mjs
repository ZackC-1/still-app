// Firefox captures for the AMO listing, taken in Firefox (Gecko) with the real Firefox build of Still
// installed as a temporary add-on over Firefox's remote debugging protocol, the same way
// about:debugging loads one. Run from the repo root after `pnpm build`:
//   node docs/release/screenshots/source/frames/capture-firefox.mjs [youtube|tiktok|popup ...]
// Writes captures/firefox/. Instagram and Facebook need a signed-in session, which lives only in the
// Chromium capture profile, so the Firefox frames reuse those two desktop captures (the page is the
// same; frames show no browser chrome).
import { firefox } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { annotateLibrary, rulesByService } from "./annotate-source.mjs";
import { installStill } from "./firefox-rdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "captures/firefox");
const EXT = resolve(HERE, "../../../../../packages/ext-chromium/dist/firefox-mv3");
const ADDON_ID = "still@chartash.com";
const UUID = "5b1e7d0c-51a1-4c6b-9d2e-7a11f0c0ffee"; // fixed, so the popup has a known moz-extension:// URL
const RDP_PORT = 12346;
const RULES = rulesByService();
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const wanted = (name) => !args.length || args.includes(name);

async function launch(withStill) {
  const browser = await firefox.launch({
    headless: true,
    args: ["-start-debugger-server", String(RDP_PORT)],
    firefoxUserPrefs: {
      "devtools.debugger.remote-enabled": true,
      "devtools.debugger.prompt-connection": false,
      "extensions.webextensions.uuids": JSON.stringify({ [ADDON_ID]: UUID }),
    },
  });
  if (withStill) await installStill(RDP_PORT, EXT);
  return browser;
}

async function pair(name, url, settle = 7000) {
  for (const on of [false, true]) {
    const browser = await launch(on);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: "en-US" });
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(settle);
    // Evaluated rather than added as a script tag: YouTube's Trusted Types policy blocks script text in Firefox.
    await page.evaluate(`${annotateLibrary()}; void 0`);
    await page.evaluate(() => globalThis.StillAnnotate.run({ mark: false }));
    await page.waitForTimeout(1200);
    const result = await page.evaluate((cfg) => globalThis.StillAnnotate.run(cfg), { rules: RULES, mark: !on });
    await page.waitForTimeout(600);
    const file = `${name}-${on ? "after" : "before"}.png`;
    await page.screenshot({ path: resolve(OUT, file) });
    console.log(file, JSON.stringify(result));
    await browser.close();
  }
}

if (wanted("youtube")) await pair("youtube", "https://www.youtube.com/results?search_query=pasta+recipe");
if (wanted("tiktok")) await pair("tiktok", "https://www.tiktok.com/tag/pastarecipe", 9000);

// The real Firefox popup document, opened as a page at the toolbar popup's width.
if (wanted("popup")) {
  const browser = await launch(true);
  const page = await browser.newPage({ viewport: { width: 380, height: 700 }, deviceScaleFactor: 3 });
  // Add-on pages never fire Playwright's load wait in Firefox, so wait for the first paint instead.
  await page.goto(`moz-extension://${UUID}/popup.html`, { waitUntil: "commit", timeout: 15000 }).catch((e) => console.log("goto:", e.message.split("\n")[0]));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: resolve(OUT, "popup.png"), fullPage: true });
  console.log("popup.png");
  await browser.close();
}
