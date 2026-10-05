import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

test("youtube: Shorts shelves go, ordinary feed content stays", async () => {
  const tab = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await tab.waitFor(
    "Still to mark the page active",
    () => rootClass(tab),
    (c) => c.includes("still-active"),
  );

  expect(await tab.count("#shelf")).toBe(0);
  expect(await tab.count("#rich-shorts-section")).toBe(0);
  expect(await tab.count("#subs-shorts-shelf")).toBe(0);
  expect(await tab.isVisible("#endpoint")).toBe(false);
  expect(await tab.isVisible("#shorts-mini-guide")).toBe(false);
  expect(await tab.isVisible("#shorts-chip")).toBe(false);

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

test("instagram: a Reel post and the Reels link go, an ordinary post stays", async () => {
  const tab = await firefox.openTab("https://www.instagram.com/someuser/");
  await tab.waitFor(
    "Still to mark the page active",
    () => rootClass(tab),
    (c) => c.includes("still-active"),
  );
  expect(await tab.count("#reel-post")).toBe(0);
  expect(await tab.isVisible("#reels-link")).toBe(false);
  expect(await tab.isVisible("#keep-post")).toBe(true);
  await tab.close();
});

test("facebook: a Reel article and the Reels shortcut go, an ordinary post stays", async () => {
  const tab = await firefox.openTab("https://www.facebook.com/");
  await tab.waitFor(
    "Still to mark the page active",
    () => rootClass(tab),
    (c) => c.includes("still-active"),
  );
  expect(await tab.count("#reel-article")).toBe(0);
  expect(await tab.isVisible("#reels-shortcut")).toBe(false);
  expect(await tab.isVisible("#keep-article")).toBe(true);
  expect(await tab.isVisible("#keep-lookalike-article")).toBe(true);
  await tab.close();
});

test("tiktok: the website is replaced by Still's placeholder", async () => {
  const tab = await firefox.openTab("https://www.tiktok.com/foryou");
  await tab.waitFor(
    "the placeholder",
    () => tab.isVisible("#still-placeholder"),
    Boolean,
  );
  expect(await tab.count("#tiktok-feed")).toBe(0);
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

test("the master switch: Off restores every page, On blocks again", async () => {
  const popup = await firefox.openExtensionPage("popup.html");
  try {
    await setSwitch(popup, "Still", false);
    const off = await firefox.openTab(
      "https://www.youtube.com/feed/subscriptions",
    );
    await off.waitFor(
      "the Shorts shelf to be left alone",
      () => off.count("#shelf"),
      (n) => n > 0,
    );
    expect(await off.isVisible("#endpoint")).toBe(true);
    expect(await rootClass(off)).not.toContain("still-active");
    await off.close();

    await setSwitch(popup, "Still", true);
    const on = await firefox.openTab(
      "https://www.youtube.com/feed/subscriptions",
    );
    await on.waitFor(
      "Still to mark the page active",
      () => rootClass(on),
      (c) => c.includes("still-active"),
    );
    expect(await on.count("#shelf")).toBe(0);
    await on.close();
  } finally {
    await setSwitch(popup, "Still", true);
    await popup.close();
  }
});

test("one service switch Off restores only that service", async () => {
  const popup = await firefox.openExtensionPage("popup.html");
  try {
    await setSwitch(popup, "Still on Instagram", false);
    const instagram = await firefox.openTab(
      "https://www.instagram.com/someuser/",
    );
    await instagram.waitFor(
      "the Reel post to be left alone",
      () => instagram.count("#reel-post"),
      (n) => n > 0,
    );
    expect(await instagram.isVisible("#reels-link")).toBe(true);
    await instagram.close();

    const youtube = await firefox.openTab(
      "https://www.youtube.com/feed/subscriptions",
    );
    await youtube.waitFor(
      "Still to mark the page active",
      () => rootClass(youtube),
      (c) => c.includes("still-active"),
    );
    expect(await youtube.count("#shelf")).toBe(0);
    await youtube.close();
  } finally {
    await setSwitch(popup, "Still on Instagram", true);
    await popup.close();
  }
});
