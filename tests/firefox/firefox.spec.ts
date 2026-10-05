import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PAID_TIER_ENABLED } from "../../packages/shared-types/src/entitlement.js";
import {
  expectInstagramLeftAlone,
  expectYoutubeLeftAlone,
  stillIsActive,
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
});

test.afterAll(async () => {
  await firefox?.stop();
});

const rootClass = (tab: Tab) =>
  tab.evaluate<string>("document.documentElement.className");
const waitActive = (tab: Tab) =>
  tab.waitFor(
    "Still to mark the page active",
    () => stillIsActive(tab),
    Boolean,
  );

test("youtube: Shorts shelves go, ordinary feed content stays", async () => {
  const tab = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await waitActive(tab);

  await tab.waitForCount("#shelf", 0);
  await tab.waitForCount("#rich-shorts-section", 0);
  await tab.waitForCount("#subs-shorts-shelf", 0);
  await tab.waitForVisible("#endpoint", false);
  await tab.waitForVisible("#shorts-mini-guide", false);
  await tab.waitForVisible("#shorts-chip", false);

  expect(await tab.isVisible("#keep-video")).toBe(true);
  expect(await tab.isVisible("#keep-subs-video")).toBe(true);
  expect(await tab.isVisible("#keep-guide-home")).toBe(true);
  expect(await tab.isVisible("#keep-chip-all")).toBe(true);
  expect(await tab.isVisible("#keep-mixed-section")).toBe(true);
  expect(await tab.isVisible("#keep-reels-titled-video")).toBe(true);
  expect(await rootClass(tab)).toContain("still-service-youtube");
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
    await waitActive(tab);
    await tab.waitForCount("#reel-post", 0);
    await tab.waitForVisible("#reels-link", false);
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
        (await tab.count("#reel-article")) > 0 &&
        (await tab.isVisible("#reels-shortcut")) &&
        !(await stillIsActive(tab)),
    );
  } else {
    await waitActive(tab);
    await tab.waitForCount("#reel-article", 0);
    await tab.waitForVisible("#reels-shortcut", false);
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
//  2. Reload: a fresh page must then stay whole for a full second, so removed parts really return.
test("the master switch: Off restores every page, On blocks again", async () => {
  const popup = await firefox.openExtensionPage("popup.html");
  try {
    const url = "https://www.youtube.com/feed/subscriptions";
    const tab = await firefox.openTab(url);
    await waitActive(tab);
    await tab.waitForCount("#shelf", 0);

    await setSwitch(popup, "Still", false);
    await tab.waitFor(
      "Still to take its marker away",
      () => stillIsActive(tab),
      (active) => !active,
    );
    await tab.waitForVisible("#endpoint", true);

    await tab.goto(url);
    await expectYoutubeLeftAlone(tab);
    await tab.close();

    await setSwitch(popup, "Still", true);
    const on = await firefox.openTab(url);
    await waitActive(on);
    await on.waitForCount("#shelf", 0);
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
    await waitActive(instagram);
    await instagram.waitForCount("#reel-post", 0);

    await setSwitch(popup, "Still on Instagram", false);
    await instagram.waitFor(
      "Still to take its marker away",
      () => stillIsActive(instagram),
      (active) => !active,
    );
    await instagram.waitForVisible("#reels-link", true);

    await instagram.goto(url);
    await expectInstagramLeftAlone(instagram);
    await instagram.close();

    const youtube = await firefox.openTab(
      "https://www.youtube.com/feed/subscriptions",
    );
    await waitActive(youtube);
    await youtube.waitForCount("#shelf", 0);
    await youtube.close();
  } finally {
    await setSwitch(popup, "Still on Instagram", true);
    await popup.close();
  }
});
