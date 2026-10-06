/* eslint-disable no-empty-pattern -- Playwright requires a destructured first argument, and these tests use none of its fixtures */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FirefoxEvidence } from "./_qa-evidence.js";
import {
  FIRST_RUN_URL,
  NEEDS_BACKEND,
  firstRunTab,
  inExtension,
  recordRequests,
  savedSettings,
  startFresh,
  storeDump,
  tabsWith,
} from "./_qa-session.js";
import { FIREFOX_EXTENSION, type StillFirefox } from "./_session.js";
import { waitWorking } from "./_qa-assert.js";

// J1.FD (install and first run) and J11.FD (permissions) on real Firefox, over WebDriver BiDi.
// Every test starts a fresh profile with the built extension installed, as a person's first run.
// BiDi cannot press real keys or take screenshots on extension pages, so "clicks" are the page's own
// element.click() and pictures come from Firefox's window snapshot (see _qa-capture.ts).

const FOUR_HOSTS = [
  "*://*.youtube.com/*",
  "*://*.instagram.com/*",
  "*://*.facebook.com/*",
  "*://*.tiktok.com/*",
];

let firefox: StillFirefox;
test.beforeEach(async () => {
  firefox = await startFresh();
});
test.afterEach(async () => {
  await firefox?.stop();
});

const text = (tab: { evaluate<T>(e: string): Promise<T> }) =>
  tab.evaluate<string>("document.body.innerText.replace(/\\s+/g, ' ')");

test("J1.FD a new install opens the first-run page once and saves the defaults", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J1.FD", testInfo, firefox);
  const page = await firstRunTab(firefox);
  expect(await page.evaluate<string>("document.title")).toBe(
    "Welcome to Still",
  );
  expect(
    await page.evaluate<string>("document.querySelector('h1').textContent"),
  ).toBe("Still is on.");
  // Firefox grants the four sites at install, so the permission step reads as done.
  expect(await text(page)).toContain(
    "Allowed on YouTube, Instagram, Facebook and TikTok.",
  );
  await ev.shot("first-run", "first-run-just-installed");

  const record = await savedSettings(firefox);
  expect(record.settings).toMatchObject({
    schemaVersion: 2,
    globalOn: true,
    services: { youtube: true, instagram: true, facebook: true, tiktok: true },
    pauses: [],
  });
  expect(record.atomic?.ownership).toBe("never-linked");
  const dump = await ev.storage("after-install");
  expect(Object.keys(dump).sort()).toEqual([
    "still:originalInstall",
    "still:settings",
  ]);

  await new Promise((done) => setTimeout(done, 1500));
  expect(
    await tabsWith(firefox, FIRST_RUN_URL),
    "first-run opens once",
  ).toHaveLength(1);
});

test("J1.FD there is no account wall: the pin step, an optional sync step, and analytics stay quiet", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J1.FD", testInfo, firefox);
  const requests = recordRequests(firefox);
  const page = await firstRunTab(firefox);
  const body = await text(page);
  expect(body).toContain("Pin Still to your toolbar");
  // Firefox's own wording: the gear menu, not Chrome's pin button.
  expect(body).toContain(
    "Click the puzzle piece in the toolbar, then the gear next to Still, then Pin to toolbar.",
  );
  expect(body).toContain("Settings sync");
  expect(body).toContain("Optional");
  expect(await page.count("[role=dialog], dialog[open]")).toBe(0);
  expect(await page.count("input:not([type=hidden])")).toBe(0);
  expect(body).not.toContain("Share your email and usage data with Still?");
  await ev.shot("first-run", "first-run-no-account-wall");

  // Analytics stay off until a person opts in: nothing is switched on and nothing is sent.
  const dump = await storeDump(firefox);
  expect(
    Object.keys(dump).filter((key) => key.startsWith("still:analytics")),
  ).toEqual([]);
  await new Promise((done) => setTimeout(done, 1500));
  ev.log("page-requests", requests.entries);
  expect(requests.external(), "no request left the supported sites").toEqual(
    [],
  );
});

test("J1.FD after first run the popup shows the saved defaults, and blocking never needed the page", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J1.FD", testInfo, firefox);
  await (await firstRunTab(firefox)).close();

  const youtube = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await waitWorking(youtube, "youtube");
  await youtube.waitForVisible("#shelf", false);
  expect(await youtube.isVisible("#keep-video")).toBe(true);

  // The popup, as a page (for its state) and as the real toolbar panel (for the picture).
  const popup = await firefox.openExtensionPage("popup.html");
  await popup.waitFor(
    "the popup",
    () => popup.count("button[role=switch]"),
    (n) => n >= 5,
  );
  expect(
    await popup.evaluate<string>("document.querySelector('h1').textContent"),
  ).toBe("Still is active");
  const switches = await popup.evaluate<Record<string, string>>(
    `Object.fromEntries([...document.querySelectorAll("button[role=switch]")].map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-checked")]))`,
  );
  expect(switches).toEqual({
    Still: "true",
    "Still on YouTube": "true",
    "Still on Instagram": "true",
    "Still on Facebook": "true",
    "TikTok website": "true",
  });
  await popup.close();
  await ev.popupShot("popup-saved-defaults");
});

test("J1.FD Open Still settings leads from first run to the settings page", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J1.FD", testInfo, firefox);
  const page = await firstRunTab(firefox);
  const before = await firefox.bidi.send("browsingContext.getTree", {});
  const known = new Set(
    (before.contexts as { context: string }[]).map((c) => c.context),
  );
  await page.evaluate(
    `[...document.querySelectorAll("button, a")].find((b) => b.textContent.trim() === "Open Still settings").click()`,
  );
  // Firefox opens an add-on's embedded settings inside about:addons.
  const urls = await page.waitFor(
    "a new tab for the settings",
    async () => {
      const tree = await firefox.bidi.send("browsingContext.getTree", {});
      return (tree.contexts as { context: string; url: string }[])
        .filter((c) => !known.has(c.context))
        .map((c) => c.url);
    },
    (found) => found.some((url) => /about:addons|options\.html/.test(url)),
  );
  ev.log("opened-from-first-run", urls);
  expect(urls.join(" ")).toMatch(/about:addons|options\.html/);
});

test.fixme("J1.FD optional sign-in from first run: sign-in skipped, then signed in with a code from the local mailbox", async () => {
  // NEEDS_BACKEND: the unconfigured build has no live sign-in. Enable with the QA-P7 recipe.
  expect(NEEDS_BACKEND).toBeTruthy();
});

// ---- J11.FD ---------------------------------------------------------------------------------

const builtManifest = () =>
  JSON.parse(
    readFileSync(join(FIREFOX_EXTENSION, "manifest.json"), "utf8"),
  ) as Record<string, any>;

test("J11.FD the built Firefox manifest asks for exactly storage and alarms, on four hosts", async () => {
  const manifest = builtManifest();
  expect([...manifest.permissions].sort()).toEqual(["alarms", "storage"]);
  expect([...manifest.host_permissions].sort()).toEqual([...FOUR_HOSTS].sort());
  expect(manifest.optional_permissions).toBeUndefined();
  expect(manifest.optional_host_permissions).toBeUndefined();
  // Firefox's own data-collection declaration: sign-in needs an identity, analytics is optional.
  expect(
    manifest.browser_specific_settings.gecko.data_collection_permissions,
  ).toEqual({
    required: ["authenticationInfo"],
    optional: ["technicalAndInteraction"],
  });
  expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe(
    "140.0",
  );
});

test("J11.FD nothing in the built manifest reaches beyond the four services", async () => {
  const manifest = builtManifest();
  const all = JSON.stringify(manifest);
  expect(all).not.toContain("<all_urls>");
  expect(all).not.toMatch(
    /"(tabs|history|webRequest|cookies|activeTab|scripting|webNavigation|bookmarks|downloads)"/,
  );
  for (const script of manifest.content_scripts as { matches: string[] }[])
    expect([...script.matches].sort()).toEqual([...FOUR_HOSTS].sort());
  expect(manifest.externally_connectable).toBeUndefined();
});

test("J11.FD the running extension holds exactly what the manifest declares, granted at install", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J11.FD", testInfo, firefox);
  const granted = await inExtension(firefox, (page) =>
    page.evaluate<{ permissions: string[]; origins: string[] }>(
      `browser.permissions.getAll()`,
    ),
  );
  ev.log("granted-permissions", granted);
  expect([...granted.permissions].sort()).toEqual(["alarms", "storage"]);
  expect([...granted.origins].sort()).toEqual([...FOUR_HOSTS].sort());
});

test("J11.FD site access withdrawn shows the one-step permission-needed state (D14-03)", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J11.FD", testInfo, firefox);
  await (await firstRunTab(firefox)).close();
  const removed = await inExtension(firefox, (page) =>
    page.evaluate<boolean>(
      `browser.permissions.remove({ origins: ${JSON.stringify(FOUR_HOSTS)} })`,
    ),
  );
  expect(removed).toBe(true);
  const page = await firefox.openExtensionPage("first-run.html");
  await page.waitFor(
    "the permission step",
    () => text(page),
    (body) => body.includes("One step to finish setup"),
  );
  const body = await text(page);
  expect(body).toContain(
    "Firefox asks once. Still only runs on these four sites.",
  );
  expect(
    await page.evaluate<boolean>(
      `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Allow")`,
    ),
  ).toBe(true);
  expect(body).not.toContain(
    "Allowed on YouTube, Instagram, Facebook and TikTok.",
  );
  await ev.shot("first-run.html", "first-run-permission-needed", {
    width: 420,
    height: 960,
  });
});

test.fixme("J11.FD Allow opens Firefox's prompt (D14-04 waiting) and Don't allow leaves the not-allowed state (D14-05)", async () => {
  // Needs a trusted click. Release Firefox 156 gives BiDi no input on extension pages and chrome
  // scope no click synthesis, and no preference auto-denies a prompt (QA-P0 item 2). Owner-assisted
  // capture in QA checklist session 1, or these two frames stay component-only (owner question Q9).
});
