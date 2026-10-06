/* eslint-disable no-empty-pattern -- Playwright requires a destructured first argument, and these tests use none of its fixtures */
import { test, expect } from "@playwright/test";
import { FirefoxEvidence } from "./_qa-evidence.js";
import {
  firstRunTab,
  inExtension,
  savedSettings,
  startFresh,
  storeDump,
} from "./_qa-session.js";
import { EXTENSION_UUID } from "./_bidi.js";
import { fixture, type StillFirefox, type Tab } from "./_session.js";

// J3.FD: the TikTok website is blocked by sending the tab to Still's own page. On real Firefox:
// the page, "Keep it closed", TikTok switched Off, Back without bouncing, nothing written to saved
// choices, and what the dormant one-tab feature does on this Firefox. The existing firefox.spec.ts
// already covers "Open TikTok this time ... only this tab" end to end; this adds the rest.

const BLOCKED = new RegExp(
  `^moz-extension://${EXTENSION_UUID}/tiktok-blocked\\.html\\?r=[A-Za-z0-9-]+$`,
);
const major = (version: string) =>
  Number.parseInt(/(\d+)\./.exec(version)?.[1] ?? "", 10);

let firefox: StillFirefox;
test.beforeEach(async () => {
  firefox = await startFresh((url) => {
    if (url.hostname.endsWith("tiktok.com")) return fixture("tiktok.html");
    if (url.hostname.endsWith("youtube.com")) return fixture("youtube.html");
    return null;
  });
  await (await firstRunTab(firefox)).close();
});
test.afterEach(async () => {
  await firefox?.stop();
});

const sample = <T>(read: () => Promise<T>, fallback: T) =>
  read().catch(() => fallback);
const urlOf = (tab: Tab) => sample(() => tab.url(), "");
const bodyOf = (tab: Tab) =>
  sample(() => tab.evaluate<string>("document.body?.innerText ?? ''"), "");
async function press(tab: Tab, scope: string, name: string): Promise<void> {
  await tab.evaluate(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((x) => x.textContent.trim() === ${JSON.stringify(name)});
    if (!b) throw new Error("no button " + ${JSON.stringify(name)});
    b.click();
    return true;
  })()`);
}
async function blockedPage(): Promise<Tab> {
  const tab = await firefox.openTab("https://www.tiktok.com/foryou");
  await tab.waitFor(
    "the TikTok blocked page",
    () => urlOf(tab),
    (url) => BLOCKED.test(url),
  );
  await tab.waitFor(
    "its heading",
    () =>
      sample(
        () =>
          tab.evaluate<string>(
            "document.querySelector('h1')?.textContent ?? ''",
          ),
        "",
      ),
    (t) => t === "TikTok stays closed.",
  );
  return tab;
}
const toggleTikTok = async (on: boolean) => {
  const popup = await firefox.openExtensionPage("popup.html");
  const sel = `button[role=switch][aria-label="TikTok website"]`;
  await popup.waitFor(
    "the TikTok switch",
    () => popup.count(sel),
    (n) => n === 1,
  );
  const read = () =>
    popup.evaluate<string>(
      `document.querySelector(${JSON.stringify(sel)}).getAttribute("aria-checked")`,
    );
  if ((await read()) !== String(on))
    await popup.evaluate(
      `document.querySelector(${JSON.stringify(sel)}).click()`,
    );
  await popup.waitFor("the switch to settle", read, (v) => v === String(on));
  await popup.close();
};

test("J3.FD the blocked page replaces TikTok, writes no saved choice and sends nothing", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J3.FD", testInfo, firefox);
  const before = await savedSettings(firefox);
  const tab = await blockedPage();
  expect(
    await tab.count("#tiktok-feed"),
    "TikTok's own page never loaded",
  ).toBe(0);
  await ev.shot("tiktok-blocked.html", "tiktok-blocked", {
    width: 600,
    height: 900,
  });
  // Seeing the page changed no saved choice and recorded no analytics event or visit.
  expect(await savedSettings(firefox)).toEqual(before);
  const dump = await ev.storage("after-blocked-page");
  expect(
    Object.keys(dump).filter((k) => k.startsWith("still:analytics")),
  ).toEqual([]);
  await tab.close();
});

test("J3.FD Keep it closed grants nothing, and a fresh visit stays blocked", async ({}, testInfo) => {
  test.skip(
    !(major(firefox.firefoxVersion) >= 153),
    "Opening this time is unavailable below Firefox 153 (no documentId)",
  );
  const ev = new FirefoxEvidence("J3.FD", testInfo, firefox);
  const tab = await blockedPage();
  const open = "main.blocked .blocked-actions";
  await tab.waitFor(
    "Open TikTok this time to be enabled",
    () =>
      sample(
        () =>
          tab.evaluate<string | null>(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(`${open} button`)})].find((x) => x.textContent.trim() === "Open TikTok this time");
    return b ? b.getAttribute("aria-disabled") : "absent";
  })()`),
        "absent" as string | null,
      ),
    (d) => d === null,
  );
  await press(tab, open, "Open TikTok this time");
  await tab.waitFor(
    "the confirmation",
    () => bodyOf(tab),
    (t) => t.includes("Open TikTok in this tab?"),
  );
  await ev.shot("tiktok-blocked.html", "tiktok-confirmation", {
    width: 600,
    height: 900,
  });
  await press(tab, '[role="dialog"]', "Keep it closed");
  await tab.waitFor(
    "the confirmation to close",
    () => tab.count('[role="dialog"]'),
    (n) => n === 0,
  );
  expect(await bodyOf(tab)).not.toContain("Reload this page to open TikTok.");
  // Nothing was granted: no per-tab pass is stored, and the same address is blocked again.
  const dump = await storeDump(firefox);
  expect(
    Object.keys(dump).filter(
      (k) =>
        k.startsWith("still:tiktok-tab") || k.startsWith("still:tiktok-open"),
    ),
  ).toEqual([]);
  await tab.goto("https://www.tiktok.com/foryou");
  await tab.waitFor(
    "the blocked page again",
    () => urlOf(tab),
    (url) => BLOCKED.test(url),
  );
  await tab.close();
});

test("J3.FD with TikTok turned off, TikTok loads normally and no blocked page appears", async () => {
  await toggleTikTok(false);
  try {
    const tab = await firefox.openTab("https://www.tiktok.com/foryou");
    await tab.waitForVisible("#tiktok-feed", true);
    await tab.holdsFor(
      "TikTok stays",
      async () =>
        (await urlOf(tab)) === "https://www.tiktok.com/foryou" &&
        (await tab.isVisible("#tiktok-feed")),
      1_500,
    );
    await tab.close();
  } finally {
    await toggleTikTok(true);
  }
  // The same visit, with it back On, is blocked: the check above can fail.
  const again = await blockedPage();
  await again.close();
});

test("J3.FD Back from the blocked page leaves TikTok without bouncing forward again", async () => {
  const tab = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await tab.goto("https://www.tiktok.com/foryou");
  await tab.waitFor(
    "the blocked page",
    () => urlOf(tab),
    (url) => BLOCKED.test(url),
  );
  await tab.evaluate("(history.back(), true)");
  await tab.waitFor(
    "the page before TikTok",
    () => urlOf(tab),
    (url) => url.startsWith("https://www.youtube.com/"),
  );
  await tab.holdsFor(
    "no bounce back to the blocked page",
    async () => (await urlOf(tab)).startsWith("https://www.youtube.com/"),
    2_000,
  );
  await tab.close();
});

test("J3.FD the one-tab feature follows the browser: tabs.onReplaced is present here, so it is offered", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J3.FD", testInfo, firefox);
  const facts = await inExtension(firefox, (page) =>
    page.evaluate<{
      onReplaced: string;
      sessionStorage: string;
      getContexts: string;
    }>(
      `({ onReplaced: typeof browser.tabs.onReplaced, sessionStorage: typeof browser.storage.session, getContexts: typeof browser.runtime.getContexts })`,
    ),
  );
  ev.log("browser-capabilities", { firefox: firefox.firefoxVersion, ...facts });
  expect(facts).toEqual({
    onReplaced: "object",
    sessionStorage: "object",
    getContexts: "function",
  });
  // And the product agrees: the button is offered (not disabled) on this Firefox.
  const tab = await blockedPage();
  await tab.waitFor(
    "the button to be offered",
    () =>
      sample(
        () =>
          tab.evaluate<string | null>(`(() => {
    const b = [...document.querySelectorAll("main.blocked .blocked-actions button")].find((x) => x.textContent.trim() === "Open TikTok this time");
    return b ? b.getAttribute("aria-disabled") : "absent";
  })()`),
        "absent" as string | null,
      ),
    (d) => d === null,
  );
  await tab.close();
});

test.fixme("J3.FD where tabs.onReplaced or documentId is missing (Firefox below 153), the one-tab feature reports unavailable", async () => {
  // Needs an older Firefox binary (FIREFOX_BIN). The release build under test supports both, so the
  // unavailable branch cannot be reached here without a product hook; the decision is documented in
  // the U11 capability capsule (floor_gap: documentId starts at 153).
});
