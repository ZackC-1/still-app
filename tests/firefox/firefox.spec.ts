import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PAID_TIER_ENABLED } from "../../packages/shared-types/src/entitlement.js";
import {
  expectInstagramLeftAlone,
  expectYoutubeLeftAlone,
  noStillMarker,
  stillIsWorking,
  type Format2Service,
} from "./_assertions.js";
import { findFirefox } from "./_bidi.js";
import {
  FIREFOX_EXTENSION,
  StillFirefox,
  fixture,
  type Tab,
} from "./_session.js";

// The same hand-written fixture pages the Chromium lane uses, but with the built Firefox extension
// loaded into a real Firefox. They answer one question the Chromium lane cannot: does the Firefox
// build, with no declarativeNetRequest and Firefox's own content-script and storage behaviour, still
// do the job on every supported surface?
//
// This unconfigured build runs the format-2 engine on YouTube, Instagram and Facebook once its
// background has committed schema-2 settings: an owned feature marker on <html>, targets hidden by
// a scoped stylesheet but left in the page, ordinary content untouched. TikTok keeps the legacy
// engine's site block.
//
// Not covered here: sign-in and sync, the options page, popup sizing, mobile pages, and
// Firefox for Android (the product is desktop Firefox only).

const firefoxBinary = findFirefox();
const built = existsSync(resolve(FIREFOX_EXTENSION, "manifest.json"));

test.skip(
  !firefoxBinary,
  "Firefox is not installed (set FIREFOX_BIN to point at it)",
);
test.skip(
  !built,
  "Firefox build missing: run `pnpm --filter @still/ext-chromium build:firefox` first",
);

test.describe.configure({ mode: "serial" });

let firefox: StillFirefox;

test.beforeAll(async () => {
  firefox = await StillFirefox.start();
  // Every service URL answers with the fixture for its service. A Shorts URL has no page of its own,
  // so a /watch address (where the redirect must end up) is answered with a stub.
  firefox.serve((url) => {
    if (url.pathname.startsWith("/watch"))
      return "<!doctype html><title>watch</title>watch";
    const host = url.hostname;
    if (host.endsWith("youtube.com")) return fixture("youtube.html");
    if (host.endsWith("instagram.com")) return fixture("instagram.html");
    if (host.endsWith("facebook.com")) return fixture("facebook.html");
    if (host.endsWith("tiktok.com")) return fixture("tiktok.html");
    return null;
  });
  // Pages pick their engine from saved settings; wait for the install-time schema-2 settings.
  await firefox.waitForModernSettings();
});

test.afterAll(async () => {
  await firefox?.stop();
});

const rootClass = (tab: Tab) =>
  tab.evaluate<string>("document.documentElement.className");
const waitWorking = (tab: Tab, service: Format2Service) =>
  tab.waitFor(
    `Still to mark the ${service} page with its feature marker`,
    () => stillIsWorking(tab, service),
    Boolean,
  );
/** Hidden by Still, yet still in the page (the engine never removes renderer-owned nodes). */
async function waitHiddenPresent(tab: Tab, selector: string): Promise<void> {
  await tab.waitForVisible(selector, false);
  expect(await tab.count(selector), `${selector} stays in the page`).toBe(1);
}

test("youtube: Shorts shelves go, ordinary feed content stays", async () => {
  const tab = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await waitWorking(tab, "youtube");

  await waitHiddenPresent(tab, "#shelf");
  await waitHiddenPresent(tab, "#rich-shorts-section");
  await waitHiddenPresent(tab, "#subs-shorts-shelf");
  await waitHiddenPresent(tab, "#endpoint");
  await waitHiddenPresent(tab, "#shorts-mini-guide");
  await waitHiddenPresent(tab, "#shorts-chip");

  expect(await tab.isVisible("#keep-video")).toBe(true);
  expect(await tab.isVisible("#keep-subs-video")).toBe(true);
  expect(await tab.isVisible("#keep-guide-home")).toBe(true);
  expect(await tab.isVisible("#keep-chip-all")).toBe(true);
  expect(await tab.isVisible("#keep-mixed-section")).toBe(true);
  expect(await tab.isVisible("#keep-reels-titled-video")).toBe(true);
  // The format-2 lane never raises the legacy engine's page markers, so the two never stack.
  expect(await rootClass(tab)).not.toMatch(/still-(active|service-)/);
  await tab.close();
});

// Firefox has no declarativeNetRequest redirect here, so this is the content-script path alone.
test("youtube: a Shorts address ends up on the watch page", async () => {
  const tab = await firefox.openTab("https://www.youtube.com/shorts/abc123");
  const url = await tab.waitFor(
    "the redirect",
    () => tab.url(),
    (u) => u.includes("/watch"),
  );
  expect(url).toMatch(/\/watch\?v=abc123/);
  await tab.close();
});

// With the paid tier off every surface is blocked for everyone; the branch mirrors the Chromium
// fixtures so flipping the switch later changes both lanes the same way.
test("instagram: a Reel post and the Reels link follow the paid-tier switch, an ordinary post stays", async () => {
  const tab = await firefox.openTab("https://www.instagram.com/someuser/");
  if (PAID_TIER_ENABLED) {
    await expectInstagramLeftAlone(tab);
  } else {
    await waitWorking(tab, "instagram");
    await waitHiddenPresent(tab, "#reel-post");
    await waitHiddenPresent(tab, "#reels-link");
  }
  expect(await tab.isVisible("#keep-post")).toBe(true);
  await tab.close();
});

test("facebook: a Reel article and the Reels shortcut follow the paid-tier switch, an ordinary post stays", async () => {
  const tab = await firefox.openTab("https://www.facebook.com/");
  if (PAID_TIER_ENABLED) {
    await tab.holdsFor(
      "Facebook left alone",
      async () =>
        (await tab.isVisible("#reel-article")) &&
        (await tab.isVisible("#reels-shortcut")) &&
        (await noStillMarker(tab)),
    );
  } else {
    await waitWorking(tab, "facebook");
    await waitHiddenPresent(tab, "#reel-article");
    await waitHiddenPresent(tab, "#reels-shortcut");
  }
  expect(await tab.isVisible("#keep-article")).toBe(true);
  expect(await tab.isVisible("#keep-lookalike-article")).toBe(true);
  await tab.close();
});

test("tiktok: the website follows the paid-tier switch", async () => {
  const tab = await firefox.openTab("https://www.tiktok.com/foryou");
  if (PAID_TIER_ENABLED) {
    await tab.holdsFor(
      "TikTok left alone",
      async () =>
        (await tab.isVisible("#tiktok-feed")) &&
        (await tab.count("#still-placeholder")) === 0,
    );
  } else {
    await tab.waitForVisible("#still-placeholder", true);
    await tab.waitForCount("#tiktok-feed", 0);
  }
  await tab.close();
});

// Settings are changed the way a person changes them: by pressing the real switches in the popup.
// Each test puts the switch back in a finally block so a failure cannot poison the next test.
async function setSwitch(
  popup: Tab,
  label: string,
  on: boolean,
): Promise<void> {
  const selector = `button[role=switch][aria-label=${JSON.stringify(label)}]`;
  const state = () =>
    popup.evaluate<string | null>(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-checked") ?? null`,
    );
  await popup.waitFor(
    `the "${label}" switch to appear`,
    state,
    (s) => s !== null,
  );
  if ((await state()) === String(on)) return;
  await popup.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  );
  await popup.waitFor(
    `the "${label}" switch to read ${on}`,
    state,
    (s) => s === String(on),
  );
}

// Off is proved in two steps, each starting from a page where Still was seen working:
//  1. Live: with the page open and blocked, switching Off must make Still take its marker away and
//     un-hide the hidden parts. That marker change is the positive sign Still ran and chose to stop.
//  2. Reload: a fresh page must then stay whole for a full second, so hidden parts really return.
test("the master switch: Off restores every page, On blocks again", async () => {
  const popup = await firefox.openExtensionPage("popup.html");
  try {
    const url = "https://www.youtube.com/feed/subscriptions";
    const tab = await firefox.openTab(url);
    await waitWorking(tab, "youtube");
    await waitHiddenPresent(tab, "#shelf");

    await setSwitch(popup, "Still", false);
    await tab.waitFor(
      "Still to take its marker away",
      () => stillIsWorking(tab, "youtube"),
      (working) => !working,
    );
    await tab.waitForVisible("#endpoint", true);
    await tab.waitForVisible("#shelf", true);

    await tab.goto(url);
    await expectYoutubeLeftAlone(tab);
    await tab.close();

    await setSwitch(popup, "Still", true);
    const on = await firefox.openTab(url);
    await waitWorking(on, "youtube");
    await waitHiddenPresent(on, "#shelf");
    await on.close();
  } finally {
    await setSwitch(popup, "Still", true);
    await popup.close();
  }
});

test("one service switch Off restores only that service", async () => {
  test.skip(
    PAID_TIER_ENABLED,
    "with the paid tier on, free Instagram is not blocked, so there is nothing to switch off",
  );
  const popup = await firefox.openExtensionPage("popup.html");
  try {
    const url = "https://www.instagram.com/someuser/";
    const instagram = await firefox.openTab(url);
    await waitWorking(instagram, "instagram");
    await waitHiddenPresent(instagram, "#reel-post");

    await setSwitch(popup, "Still on Instagram", false);
    await instagram.waitFor(
      "Still to take its marker away",
      () => stillIsWorking(instagram, "instagram"),
      (working) => !working,
    );
    await instagram.waitForVisible("#reels-link", true);
    await instagram.waitForVisible("#reel-post", true);

    await instagram.goto(url);
    await expectInstagramLeftAlone(instagram);
    await instagram.close();

    const youtube = await firefox.openTab(
      "https://www.youtube.com/feed/subscriptions",
    );
    await waitWorking(youtube, "youtube");
    await waitHiddenPresent(youtube, "#shelf");
    await youtube.close();
  } finally {
    await setSwitch(popup, "Still on Instagram", true);
    await popup.close();
  }
});
