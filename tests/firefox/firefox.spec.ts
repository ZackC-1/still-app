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
import { EXTENSION_UUID, findFirefox } from "./_bidi.js";
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
// Firefox for Android (covered by the optional emulator spike in tests/firefox-android).

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
    const host = url.hostname;
    // Facebook's own server answers a typed /reels or /watch/reels with its /reel/ feed entry,
    // whose script at once hands the address over to the first Reel (ISS-0039, recorded 12 Oct).
    if (host.endsWith("facebook.com") && /^\/(?:watch\/)?reels\/?$/.test(url.pathname)) return { redirect: `${url.origin}/reel/` };
    if (host.endsWith("facebook.com") && url.pathname === "/reel/")
      return '<!doctype html><title>Reels</title><script>history.replaceState(null, "", "/reel/1234567890123456/")</script><p id="reels-player">a Reel</p>';
    if (url.pathname.startsWith("/watch"))
      return "<!doctype html><title>watch</title>watch";
    if (host.endsWith("youtube.com")) return fixture("youtube.html");
    // A profile in Instagram's current desktop markup (ISS-0033, ISS-0034).
    if (host.endsWith("instagram.com") && url.pathname.startsWith("/profileuser/")) return fixture("instagram-profile.html");
    // Explore in Instagram's current desktop markup (ISS-0038).
    if (host.endsWith("instagram.com") && url.pathname === "/explore/") return fixture("instagram-explore.html");
    if (host.endsWith("instagram.com")) return fixture("instagram.html");
    // Facebook's current navigation and Reels player markup (ISS-0035) answers one group's pages.
    if (host.endsWith("facebook.com") && url.pathname.startsWith("/groups/chosen")) return fixture("facebook-nav.html");
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

// End-state checks only: each core Reels address finally lands on its destination in real
// Firefox. They cannot tell an early (document_start) redirect from a late one; the early timing
// is proven by the round-based tests in packages/core (modern-shipping-entry.test.ts).
for (const [from, to] of [
  ["https://www.instagram.com/reels/", "https://www.instagram.com/"],
  ["https://www.instagram.com/reels/C0de12/", "https://www.instagram.com/reel/C0de12/"],
  ["https://www.instagram.com/profileuser/reels/", "https://www.instagram.com/profileuser/"],
  ["https://www.facebook.com/watch/reels/", "https://www.facebook.com/"],
  // The top-menu Reels tab's feed entry (ISS-0035).
  ["https://www.facebook.com/reel/?s=tab", "https://www.facebook.com/"],
  // Typed feeds that Facebook's server answers with /reel/, which hands over to a Reel (ISS-0039).
  ["https://www.facebook.com/reels", "https://www.facebook.com/"],
  ["https://www.facebook.com/reels/", "https://www.facebook.com/"],
  ["https://www.facebook.com/watch/reels", "https://www.facebook.com/"],
  ["https://m.facebook.com/reels/", "https://m.facebook.com/"],
  // Instagram's typed feeds and a profile's Reels tab (ISS-0034).
  ["https://www.instagram.com/reels", "https://www.instagram.com/"],
  ["https://www.instagram.com/someuser/reels/", "https://www.instagram.com/someuser/"],
] as const) {
  test(`a Reels address ${from} ends up on ${to}`, async () => {
    const tab = await firefox.openTab(from);
    const url = await tab.waitFor("the redirect", () => tab.url(), (u) => u === to);
    expect(url).toBe(to);
    await tab.close();
  });
}

test("facebook: the top-menu Reels tab and the sidebar shortcut are hidden; other entries stay (ISS-0035)", async () => {
  test.skip(PAID_TIER_ENABLED, "Mirrors the Chromium fixtures: with the paid tier on, this lane's profile is not blocking");
  const tab = await firefox.openTab("https://www.facebook.com/groups/chosen/");
  await waitWorking(tab, "facebook");
  await waitHiddenPresent(tab, "#top-reels-item");
  await waitHiddenPresent(tab, "#sidebar-reels-item");
  for (const id of ["#keep-top-home", "#keep-top-friends", "#keep-side-groups", "#keep-side-marketplace", "#keep-side-reel-group"])
    expect(await tab.isVisible(id), id).toBe(true);
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

test("instagram current desktop markup: the Reels menu item, the profile Reels tab and grid Reels go without holes", async () => {
  const tab = await firefox.openTab("https://www.instagram.com/profileuser/");
  await waitWorking(tab, "instagram");
  for (const id of ["#menu-reels", "#profile-reels-tab-slot", "#grid-reel-1", "#grid-reel-4", "#grid-reel-6"])
    await waitHiddenPresent(tab, id);
  for (const id of ["#keep-menu-home", "#keep-menu-messages", "#keep-tab-posts", "#keep-tab-tagged", "#keep-tile-1", "#keep-tile-6"])
    expect(await tab.isVisible(id), id).toBe(true);
  // Six posts, three to a line, all the same size: no hole and no stretched tile.
  const boxes = await tab.evaluate<Array<[number, number, number]>>(`[...document.querySelectorAll("#profile-grid > div > div")]
    .map((tile) => tile.getBoundingClientRect()).filter((box) => box.width > 0)
    .map((box) => [Math.round(box.x), Math.round(box.y), Math.round(box.width)])`);
  expect(boxes).toHaveLength(6);
  expect(new Set(boxes.map((box) => box[2])).size).toBe(1);
  expect(new Set(boxes.map((box) => box[0])).size).toBe(3);
  expect(new Set(boxes.map((box) => box[1])).size).toBe(2);
  await tab.close();
});

test("instagram explore: Reel tiles go and the other posts close up four to a line", async () => {
  const tab = await firefox.openTab("https://www.instagram.com/explore/");
  await waitWorking(tab, "instagram");
  for (const id of ["#explore-reel-1", "#explore-reel-7", "#explore-reel-10"]) await waitHiddenPresent(tab, id);
  for (const id of ["#keep-explore-1", "#keep-explore-6"]) expect(await tab.isVisible(id), id).toBe(true);
  const boxes = await tab.evaluate<Array<[number, number, number]>>(`[...document.querySelectorAll("#explore-grid > div > div")]
    .map((tile) => tile.getBoundingClientRect()).filter((box) => box.width > 0)
    .map((box) => [Math.round(box.x), Math.round(box.y), Math.round(box.width)])`);
  expect(boxes).toHaveLength(6);
  expect(new Set(boxes.map((box) => box[2])).size).toBe(1);
  expect(new Set(boxes.map((box) => box[0])).size).toBe(4);
  expect(new Set(boxes.map((box) => box[1])).size).toBe(2);
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

// TikTok: this lane always runs the unconfigured build (StillFirefox.start refuses a build with a
// server compiled in), which shows the V3 screens, so a blocked TikTok tab goes to the extension's
// own blocked page instead of the old in-page block.
const TIKTOK_BLOCKED = new RegExp(
  `^moz-extension://${EXTENSION_UUID}/tiktok-blocked\\.html\\?r=[A-Za-z0-9-]+$`,
);
// The tab may be mid-navigation when sampled; an unreadable sample is simply "not yet".
const tiktokSample = <T>(read: () => Promise<T>, fallback: T) => read().catch(() => fallback);
const tiktokUrl = (tab: Tab) => tiktokSample(() => tab.url(), "");
const tiktokText = (tab: Tab) =>
  tiktokSample(() => tab.evaluate<string>("document.body?.innerText ?? ''"), "");
async function tiktokClick(tab: Tab, scope: string, name: string): Promise<void> {
  await tab.evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})]
      .find((b) => b.textContent.trim() === ${JSON.stringify(name)});
    if (!button) throw new Error("no button " + ${JSON.stringify(name)});
    button.click();
    return true;
  })()`);
}
async function expectTiktokBlockedPage(tab: Tab): Promise<void> {
  await tab.waitFor("the TikTok blocked page", () => tiktokUrl(tab), (url) => TIKTOK_BLOCKED.test(url));
  await tab.waitFor(
    "the TikTok blocked heading",
    () => tiktokSample(() => tab.evaluate<string>("document.querySelector('h1')?.textContent ?? ''"), ""),
    (text) => text === "TikTok stays closed.",
  );
  expect(await tab.count("#tiktok-feed")).toBe(0);
}

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
    await expectTiktokBlockedPage(tab);
  }
  await tab.close();
});

test("tiktok: Open TikTok this time allows only this tab after the confirmation", async () => {
  test.skip(PAID_TIER_ENABLED, "TikTok is left alone for free users while the paid tier is on");
  // documentId, which proves the exact blocked page, arrived in Firefox 153.
  // firefoxVersion is the raw "Mozilla Firefox 156.0.1" line; an unreadable version skips too.
  const major = Number.parseInt(/(\d+)\./.exec(firefox.firefoxVersion)?.[1] ?? "", 10);
  test.skip(
    !(major >= 153),
    `Firefox ${firefox.firefoxVersion} lacks MessageSender.documentId, so opening stays unavailable`,
  );
  const tab = await firefox.openTab("https://www.tiktok.com/foryou");
  const other = await firefox.openTab("about:blank");
  try {
    await expectTiktokBlockedPage(tab);
    const open = "main.blocked .blocked-actions";
    await tab.waitFor(
      "Open TikTok this time to be enabled",
      () =>
        tiktokSample(
          () =>
            tab.evaluate<string | null>(`(() => {
              const button = [...document.querySelectorAll(${JSON.stringify(`${open} button`)})]
                .find((b) => b.textContent.trim() === "Open TikTok this time");
              return button ? button.getAttribute("aria-disabled") : "absent";
            })()`),
          "absent" as string | null,
        ),
      (disabled) => disabled === null,
    );
    await tiktokClick(tab, open, "Open TikTok this time");
    await tab.waitFor("the confirmation", () => tiktokText(tab), (text) => text.includes("Open TikTok in this tab?"));
    await tiktokClick(tab, '[role="dialog"]', "Open TikTok this time");
    await tab.waitFor("the reload step", () => tiktokText(tab), (text) => text.includes("Reload this page to open TikTok."));
    await tiktokClick(tab, open, "Reload page");
    await tab.waitFor("TikTok in this tab", () => tiktokUrl(tab), (url) => url === "https://www.tiktok.com/foryou");
    await tab.waitForVisible("#tiktok-feed", true);
    await tab.holdsFor("this tab stays on TikTok", async () =>
      (await tiktokUrl(tab)) === "https://www.tiktok.com/foryou" && (await tab.isVisible("#tiktok-feed")),
    );
    // A second tab is still closed.
    await other.goto("https://www.tiktok.com/foryou");
    await expectTiktokBlockedPage(other);
    // The first tab keeps its pass until it is closed: it can open TikTok again.
    await tab.goto("https://www.tiktok.com/foryou");
    await tab.waitFor("TikTok again in this tab", () => tiktokUrl(tab), (url) => url === "https://www.tiktok.com/foryou");
    await tab.waitForVisible("#tiktok-feed", true);
  } finally {
    await other.close();
    await tab.close();
  }
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
