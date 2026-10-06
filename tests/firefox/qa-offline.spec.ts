/* eslint-disable no-empty-pattern -- Playwright requires a destructured first argument, and these tests use none of its fixtures */
import { test, expect } from "@playwright/test";
import { FirefoxEvidence } from "./_qa-evidence.js";
import { waitWorking } from "./_qa-assert.js";
import { FirefoxChrome } from "./_qa-capture.js";
import {
  NEEDS_BACKEND,
  firstRunTab,
  recordRequests,
  savedSettings,
  startFresh,
} from "./_qa-session.js";
import type { StillFirefox } from "./_session.js";

// J9.FD: no network at all. Firefox is put into its own offline mode (Services.io.offline, the
// "Work Offline" switch), recorded pages are still answered from disk by the harness, and the
// extension's own pages load from the install. The person still gets blocking and working switches
// with no error state. BiDi cannot see the background script's own requests; the lane's unconfigured
// build check (no server address compiled in) is what proves the background has nowhere to send.

let firefox: StillFirefox;
let chrome: FirefoxChrome;
test.beforeEach(async () => {
  firefox = await startFresh();
  await (await firstRunTab(firefox)).close();
  chrome = await FirefoxChrome.attach(firefox.bidi);
});
test.afterEach(async () => {
  await chrome
    ?.eval("(Services.io.offline = false, true)")
    .catch(() => undefined);
  await firefox?.stop();
});

const goOffline = async (offline: boolean) => {
  await chrome.eval(`(Services.io.offline = ${offline}, true)`);
  expect(await chrome.eval<boolean>("Services.io.offline")).toBe(offline);
};

test("J9.FD blocking works offline and a settings edit is saved on the device", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J9.FD", testInfo, firefox);
  const requests = recordRequests(firefox);
  await goOffline(true);

  const youtube = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await waitWorking(youtube, "youtube");
  await youtube.waitForVisible("#shelf", false);
  await youtube.waitForVisible("#rich-shorts-section", false);
  expect(await youtube.isVisible("#keep-video")).toBe(true);

  const popup = await firefox.openExtensionPage("popup.html");
  const sel = 'button[role=switch][aria-label="Still on YouTube"]';
  await popup.waitFor(
    "the switch",
    () => popup.count(sel),
    (n) => n === 1,
  );
  expect(
    await popup.evaluate<string>("document.querySelector('h1').textContent"),
  ).toBe("Still is active");
  await popup.evaluate(
    `document.querySelector(${JSON.stringify(sel)}).click()`,
  );
  await popup.waitFor(
    "saved",
    async () => (await savedSettings(firefox)).settings.services.youtube,
    (v) => v === false,
  );
  await youtube.waitForVisible("#shelf", true);

  // No error state anywhere: nothing here is signed in, so there is no sync line to fail.
  const text = await popup.evaluate<string>(
    "document.body.innerText.replace(/\\s+/g, ' ')",
  );
  expect(text).not.toMatch(
    /couldn.t|failed|offline|error|try again|no connection/i,
  );
  await popup.close();
  await ev.popupShot("popup-offline-no-error");
  await ev.storage("offline-edit-saved");

  // Nothing left the machine: the only requests are the recorded pages the harness answered.
  ev.log("page-requests", requests.entries);
  expect(requests.external()).toEqual([]);

  await goOffline(false);
  const back = await firefox.openExtensionPage("popup.html");
  await back.waitFor(
    "the switch",
    () => back.count(sel),
    (n) => n === 1,
  );
  await back.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await back.waitFor(
    "saved on",
    async () => (await savedSettings(firefox)).settings.services.youtube,
    (v) => v === true,
  );
  await youtube.waitForVisible("#shelf", false);
});

test("J9.FD the extension's own pages open offline", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J9.FD", testInfo, firefox);
  await goOffline(true);
  for (const name of ["options.html", "first-run.html"] as const) {
    const page = await firefox.openExtensionPage(name);
    expect(
      await page.waitFor(
        `${name} heading`,
        () => page.count("h1"),
        (n) => n >= 1,
      ),
    ).toBeGreaterThanOrEqual(1);
    await ev.shot(name, `${name.replace(".html", "")}-offline`, {
      width: 600,
      height: 900,
    });
    await page.close();
  }
});

test.fixme("J9.FD a settings edit made offline syncs when the connection returns", async () => {
  expect(NEEDS_BACKEND).toBeTruthy();
});
