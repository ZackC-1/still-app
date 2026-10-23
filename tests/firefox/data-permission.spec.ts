import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { stillIsWorking } from "./_assertions.js";
import { EXTENSION_UUID, findFirefox } from "./_bidi.js";
import { FIREFOX_EXTENSION, StillFirefox, fixture, type Tab } from "./_session.js";

// Firefox's optional data-collection permissions in a real Firefox (owner decision, 22 Oct 2026):
// installing Still never grants the email address ("personallyIdentifyingInfo") or Still Pro
// purchase data ("financialAndPaymentInfo"), and free blocking works with neither.
//
// It also pins the Firefox rule the click handlers are built on: permissions.request for a data
// type is refused outside the handling of a user action, so the ask has to be the first thing a
// click handler does (lib/data-permission.ts).
//
// Not covered here: accepting or declining Firefox's prompt. BiDi has no input on extension pages
// (qa-settings.spec.ts), and script.evaluate's `userActivation: true` does not count as a user input
// handler for permissions.request (checked 22 Oct 2026, with the optional-permission prompt pref
// off), so there is no trusted click that could raise it. This lane's build also has
// no server, so it has no Sign in or Get Still Pro. The click handlers (ask first, nothing sent when
// declined, re-check before each send, withdrawn grant) are covered by the unit tests with a mocked
// permissions API: core controller-data-permission.test.ts; ext-chromium data-permission.test.ts,
// purchase-wiring.permission.test.ts,
// browser-pro.permission.test.ts, firefox-data-guard.test.ts and free-blocking-data-permission.test.ts.

const firefoxBinary = findFirefox();
const built = existsSync(resolve(FIREFOX_EXTENSION, "manifest.json"));
test.skip(!firefoxBinary, "Firefox is not installed (set FIREFOX_BIN to point at it)");
test.skip(!built, "Firefox build missing: run `pnpm --filter @still/ext-chromium build:firefox` first");
test.describe.configure({ mode: "serial" });

const EMAIL = "personallyIdentifyingInfo";
const PURCHASE = "financialAndPaymentInfo";

let firefox: StillFirefox;
test.beforeAll(async () => {
  firefox = await StillFirefox.start();
  firefox.serve((url) => (url.hostname.endsWith("youtube.com") ? fixture("youtube.html") : null));
  await firefox.waitForModernSettings();
});
test.afterAll(async () => {
  await firefox?.stop();
});

const granted = (page: Tab) =>
  page.evaluate<string[] | null>("browser.permissions.getAll().then((all) => all.data_collection ?? null)");

test("installing grants neither the email address nor purchase data", async () => {
  const page = await firefox.openExtensionPage("options.html");
  try {
    const list = await granted(page);
    // Firefox 140+ lists data-collection grants; a missing list would mean no built-in consent.
    expect(Array.isArray(list)).toBe(true);
    expect(list).not.toContain(EMAIL);
    expect(list).not.toContain(PURCHASE);
    expect(await page.evaluate<boolean>(`browser.permissions.contains({ data_collection: ["${EMAIL}"] })`)).toBe(false);
    expect(await page.evaluate<boolean>(`browser.permissions.contains({ data_collection: ["${PURCHASE}"] })`)).toBe(false);
    // The installed manifest is the one declaring them optional.
    const declared = await page.evaluate<{ required: string[]; optional: string[] }>(
      "browser.runtime.getManifest().browser_specific_settings.gecko.data_collection_permissions",
    );
    // (Firefox adds its own normalized `has_previous_consent: false`.)
    expect({ required: declared.required, optional: declared.optional }).toEqual({
      required: ["authenticationInfo"],
      optional: [EMAIL, PURCHASE, "technicalAndInteraction"],
    });
  } finally {
    await page.close();
  }
});

test("Firefox refuses to ask outside a click, and nothing is granted by trying", async () => {
  const page = await firefox.openExtensionPage("options.html");
  try {
    const outcome = await page.evaluate<string>(`browser.permissions
      .request({ data_collection: ["${EMAIL}"] })
      .then((answer) => "answered " + answer, (error) => "refused: " + error.message)`);
    expect(outcome).toMatch(/^refused: .*user input handler/);
    expect(await granted(page)).not.toContain(EMAIL);
  } finally {
    await page.close();
  }
});

test("free blocking works with no data permission granted", async () => {
  const tab = await firefox.openTab("https://www.youtube.com/");
  try {
    await tab.waitFor("Still to mark the YouTube page", () => stillIsWorking(tab, "youtube"), Boolean);
  } finally {
    await tab.close();
  }
  const page = await firefox.openExtensionPage("options.html");
  try {
    expect(await granted(page)).not.toContain(EMAIL);
    expect(await granted(page)).not.toContain(PURCHASE);
    expect(await page.url()).toBe(`moz-extension://${EXTENSION_UUID}/options.html`);
  } finally {
    await page.close();
  }
});
