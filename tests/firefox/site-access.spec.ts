import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findFirefox } from "./_bidi.js";
import { FIREFOX_EXTENSION, StillFirefox, type Tab } from "./_session.js";

// ISS-0037 (retest FX-36) in a real Firefox. Firefox lets a person turn off Still's access to a site
// (Add-ons and themes, Still, Permissions), and lets the add-on remove its own host access, so this
// lane withholds access for real: youtube.com is removed exactly as FX-36 does. The popup and
// settings page must then say plainly that Still can't work on YouTube, at the top, with Allow;
// an open settings page must notice the removal without a reload.
//
// Not covered here: pressing Allow. Firefox only shows its prompt for a trusted click, and BiDi has
// no input on extension pages (see qa-first-run.spec.ts); the request itself, its four origins and
// its timing inside the click are covered by the component tests and the Chromium lane.

const firefoxBinary = findFirefox();
const built = existsSync(resolve(FIREFOX_EXTENSION, "manifest.json"));
test.skip(!firefoxBinary, "Firefox is not installed (set FIREFOX_BIN to point at it)");
test.skip(!built, "Firefox build missing: run `pnpm --filter @still/ext-chromium build:firefox` first");
test.describe.configure({ mode: "serial" });

// Only youtube.com is turned off, so the card names only YouTube.
const TITLE = "Still can't work on this site";
const BODY = "Still needs permission to work on YouTube.";

let firefox: StillFirefox;
test.beforeAll(async () => {
  firefox = await StillFirefox.start();
  await firefox.waitForModernSettings();
});
test.afterAll(async () => {
  await firefox?.stop();
});

const text = (tab: Tab) => tab.evaluate<string>("document.body.innerText.replace(/\\s+/g, ' ')");
const hasAllow = (tab: Tab) =>
  tab.evaluate<boolean>(
    `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Allow")`,
  );

async function siteListShown(tab: Tab): Promise<string> {
  return await tab.waitFor("the site list", () => text(tab), (body) => body.includes("Instagram Blocker"), 15_000);
}

/** The warning is above the site list: its heading comes before the first site in reading order. */
function expectWarningAboveSites(body: string) {
  expect(body).toContain(TITLE);
  expect(body).toContain(BODY);
  expect(body.indexOf(TITLE)).toBeLessThan(body.indexOf("Instagram Blocker"));
  expect(body).not.toMatch(/everywhere/i);
  expect(body).not.toContain("Instagram, Facebook");
}

test("with all four sites allowed, the popup and settings page show no warning", async () => {
  for (const name of ["popup.html", "options.html"]) {
    const page = await firefox.openExtensionPage(name);
    try {
      const body = await siteListShown(page);
      await page.holdsFor(`${name} has no warning`, async () => !(await text(page)).includes("Still can't work on"), 500);
      expect(body).not.toContain("Still can't work on");
    } finally {
      await page.close();
    }
  }
});

test("turning off youtube.com warns at the top of an open settings page, then the popup", async () => {
  const settings = await firefox.openExtensionPage("options.html");
  await siteListShown(settings);
  const remover = await firefox.openExtensionPage("options.html");
  expect(
    await remover.evaluate<boolean>(`browser.permissions.remove({ origins: ["*://*.youtube.com/*"] })`),
  ).toBe(true);
  await remover.close();

  // The open page follows Firefox's removal event; nobody reloads it.
  const body = await settings.waitFor("the settings warning", () => text(settings), (b) => b.includes(TITLE));
  expectWarningAboveSites(body);
  expect(await hasAllow(settings)).toBe(true);
  await settings.close();

  const popup = await firefox.openExtensionPage("popup.html");
  const popupBody = await popup.waitFor("the popup warning", () => text(popup), (b) => b.includes(TITLE), 15_000);
  expectWarningAboveSites(popupBody);
  expect(await hasAllow(popup)).toBe(true);
  await popup.close();
});
