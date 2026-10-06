/* eslint-disable no-empty-pattern -- Playwright requires a destructured first argument, and these tests use none of its fixtures */
import { test, expect } from "@playwright/test";
import { EXTENSION_UUID } from "./_bidi.js";
import { FirefoxEvidence } from "./_qa-evidence.js";
import { waitWorking } from "./_qa-assert.js";
import {
  FIRST_RUN_URL,
  NEEDS_BACKEND,
  firstRunTab,
  readStore,
  savedSettings,
  startFresh,
  tabsWith,
  writeStore,
} from "./_qa-session.js";
import type { StillFirefox, Tab } from "./_session.js";

// J4.FD (settings: popup and options) and J10.FD (pause: global Still Off, choices kept) on real
// Firefox. BiDi has no input on extension pages, so a "click" is the element's own click() and key
// order is read from the page; the real toolbar panel is photographed from Firefox's chrome scope.

const SWITCH = {
  global: "Still",
  youtube: "Still on YouTube",
  instagram: "Still on Instagram",
  facebook: "Still on Facebook",
  tiktok: "TikTok website",
} as const;

let firefox: StillFirefox;
test.beforeEach(async () => {
  firefox = await startFresh();
  await (await firstRunTab(firefox)).close();
});
test.afterEach(async () => {
  await firefox?.stop();
});

const selector = (label: string) =>
  `button[role=switch][aria-label=${JSON.stringify(label)}]`;
const state = (page: Tab, label: string) =>
  page.evaluate<string | null>(
    `document.querySelector(${JSON.stringify(selector(label))})?.getAttribute("aria-checked") ?? null`,
  );
async function ready(page: Tab, label = SWITCH.global): Promise<void> {
  await page.waitFor(
    `the ${label} switch`,
    () => state(page, label),
    (s) => s !== null,
  );
}
async function flip(page: Tab, label: string): Promise<void> {
  await ready(page, label);
  await page.evaluate(
    `document.querySelector(${JSON.stringify(selector(label))}).click()`,
  );
}
const saved = () => savedSettings(firefox);

test("J4.FD a service switch in the popup changes storage and an open YouTube page without a reload", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J4.FD", testInfo, firefox);
  const youtube = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await waitWorking(youtube, "youtube");
  await youtube.waitForVisible("#shelf", false);

  const popup = await firefox.openExtensionPage("popup.html");
  await flip(popup, SWITCH.youtube);
  await popup.waitFor(
    "the switch to read off",
    () => state(popup, SWITCH.youtube),
    (s) => s === "false",
  );
  expect((await saved()).settings.services.youtube).toBe(false);
  // The page that was already open reflects it with no reload.
  await youtube.waitForVisible("#shelf", true);
  await ev.shot("feed/subscriptions", "youtube-off-no-reload", {
    width: 600,
    height: 700,
  });
  await flip(popup, SWITCH.youtube);
  await youtube.waitForVisible("#shelf", false);
  expect((await saved()).settings.services.youtube).toBe(true);
  await popup.close();
  await ev.popupShot("popup-youtube-back-on");
  await ev.storage("youtube-back-on");
});

test("J4.FD popup and options stay consistent in both directions", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J4.FD", testInfo, firefox);
  const options = await firefox.openExtensionPage("options.html");
  await flip(options, SWITCH.instagram);
  await options.waitFor(
    "saved",
    async () => (await saved()).settings.services.instagram,
    (v) => v === false,
  );

  const popup = await firefox.openExtensionPage("popup.html");
  await ready(popup, SWITCH.instagram);
  expect(await state(popup, SWITCH.instagram)).toBe("false");
  expect(await state(popup, SWITCH.youtube)).toBe("true");

  await flip(popup, SWITCH.instagram);
  await popup.waitFor(
    "saved",
    async () => (await saved()).settings.services.instagram,
    (v) => v === true,
  );
  await options.goto(`moz-extension://${EXTENSION_UUID}/options.html`);
  await ready(options, SWITCH.instagram);
  expect(await state(options, SWITCH.instagram)).toBe("true");
  await ev.shot("options.html", "options-consistent", {
    width: 560,
    height: 900,
  });
});

test("J4.FD every service switch saves its own choice and nothing else", async () => {
  const popup = await firefox.openExtensionPage("popup.html");
  for (const service of [
    "youtube",
    "instagram",
    "facebook",
    "tiktok",
  ] as const) {
    await flip(popup, SWITCH[service]);
    await popup.waitFor(
      `${service} saved off`,
      async () => (await saved()).settings.services[service],
      (v) => v === false,
    );
    const { services, globalOn } = (await saved()).settings;
    expect(globalOn).toBe(true);
    expect(
      Object.entries(services)
        .filter(([, on]) => !on)
        .map(([name]) => name),
    ).toEqual([service]);
    await flip(popup, SWITCH[service]);
    await popup.waitFor(
      `${service} saved on`,
      async () => (await saved()).settings.services[service],
      (v) => v === true,
    );
  }
});

test("J10.FD global Off keeps the choices and Off to On restores exactly the prior choices", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J10.FD", testInfo, firefox);
  const youtube = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await waitWorking(youtube, "youtube");
  await youtube.waitForVisible("#shelf", false);

  const popup = await firefox.openExtensionPage("popup.html");
  await flip(popup, SWITCH.instagram);
  await popup.waitFor(
    "instagram off",
    async () => (await saved()).settings.services.instagram,
    (v) => v === false,
  );

  await flip(popup, SWITCH.global);
  await popup.waitFor(
    "global off",
    async () => (await saved()).settings.globalOn,
    (v) => v === false,
  );
  expect((await saved()).settings.services).toEqual({
    youtube: true,
    instagram: false,
    facebook: true,
    tiktok: true,
  });
  await youtube.waitForVisible("#shelf", true);
  expect(
    await popup.evaluate<string>(
      "document.querySelector('h1')?.textContent ?? ''",
    ),
  ).not.toBe("Still is active");
  await ev.popupShot("popup-still-off");

  await flip(popup, SWITCH.global);
  await popup.waitFor(
    "global on",
    async () => (await saved()).settings.globalOn,
    (v) => v === true,
  );
  expect((await saved()).settings.services).toEqual({
    youtube: true,
    instagram: false,
    facebook: true,
    tiktok: true,
  });
  await youtube.waitForVisible("#shelf", false);
  expect(
    await popup.evaluate<string>("document.querySelector('h1').textContent"),
  ).toBe("Still is active");
});

test("J10.FD a seeded legacy pause record is ignored", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J10.FD", testInfo, firefox);
  const record = (await readStore<{ settings: Record<string, unknown> }>(
    firefox,
    "still:settings",
  ))!;
  await writeStore(firefox, {
    "still:settings": {
      ...record,
      settings: { ...record.settings, pauses: ["youtube.com"] },
    },
  });
  expect((await saved()).settings.pauses).toEqual(["youtube.com"]);
  const youtube = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await waitWorking(youtube, "youtube");
  await youtube.waitForVisible("#shelf", false);
  expect(await youtube.isVisible("#keep-video")).toBe(true);
  ev.log("pauses-after", (await saved()).settings.pauses);
});

test("J4.FD the popup's keyboard order is master, then each service's expander and switch", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J4.FD", testInfo, firefox);
  const popup = await firefox.openExtensionPage("popup.html");
  await ready(popup);
  // BiDi cannot press Tab on an extension page, so the order is read from the page: every control
  // a Tab press would reach, in document order (no tabindex above 0 is used).
  const order = await popup.evaluate<string[]>(`(() => {
    const els = [...document.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")];
    return els.map((el) => el.getAttribute("aria-label") ?? el.textContent.trim());
  })()`);
  ev.log("tab-order", order);
  expect(order.slice(0, 7)).toEqual([
    "Still",
    "YouTube Blocker",
    "Still on YouTube",
    "Instagram Blocker",
    "Still on Instagram",
    "Facebook Blocker",
    "Still on Facebook",
  ]);
  const positive = await popup.evaluate<number>(
    `document.querySelectorAll("[tabindex]:not([tabindex='0']):not([tabindex^='-'])").length`,
  );
  expect(positive, "no positive tabindex reorders the keyboard path").toBe(0);
});

test("J4.FD Setup guide in the settings reopens the first-run page", async () => {
  const options = await firefox.openExtensionPage("options.html");
  await options.waitFor(
    "Setup guide",
    () =>
      options.evaluate<boolean>(
        `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Setup guide")`,
      ),
    Boolean,
  );
  expect(await tabsWith(firefox, FIRST_RUN_URL)).toHaveLength(0);
  await options.evaluate(
    `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Setup guide").click()`,
  );
  const opened = await options.waitFor(
    "the first-run page",
    () => tabsWith(firefox, FIRST_RUN_URL),
    (tabs) => tabs.length === 1,
  );
  expect(
    await opened[0]!.evaluate<string>(
      "document.querySelector('h1').textContent",
    ),
  ).toBe("Still is on.");
});

test("J4.FD D01-08 has no product state to reach: no Firefox 'Autoplay unavailable' branch exists", async ({}, testInfo) => {
  // The reference frame D01-08 shows an Autoplay row marked unavailable on Firefox. The V3 popup
  // renders Autoplay prevention as a locked Pro row like every other extra, on every browser.
  const ev = new FirefoxEvidence("J4.FD", testInfo, firefox);
  const popup = await firefox.openExtensionPage("popup.html");
  await ready(popup);
  await popup.evaluate(
    `[...document.querySelectorAll("button[aria-expanded]")].find((b) => /^YouTube/.test(b.textContent.trim())).click()`,
  );
  await popup.waitFor(
    "Autoplay prevention",
    () => popup.evaluate<string>("document.body.innerText"),
    (t) => t.includes("Autoplay prevention"),
  );
  const body = await popup.evaluate<string>(
    "document.body.innerText.replace(/\\s+/g, ' ')",
  );
  ev.log("youtube-expanded-text", body);
  expect(body).not.toMatch(/unavailable|isn.t available|not available/i);
  expect(body).toContain("Still Pro");
  await popup.close();
  await ev.popupShot("popup-youtube-expanded-locked-rows");
});

test.fixme("J4.FD Tab and Space operate the popup with real key presses", async () => {
  // Real keys need trusted input, which BiDi refuses on extension pages and release Firefox's chrome
  // scope cannot synthesize (QA-P0 item 2). The component test (D01-11) and the Chrome lane cover it.
});

test.fixme("J4.FD settings while signed in: sign-out keeps blocking and sync-failed states", async () => {
  expect(NEEDS_BACKEND).toBeTruthy();
});
