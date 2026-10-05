import { test, expect } from "../shared/fixtures.js";
import { NEEDS_BACKEND, V3_ONLY, syncConfigured } from "../shared/lane.js";
import { FIRST_RUN, serveFixture } from "../shared/serve.js";
import { openExtensionPage, waitForCommittedSettings } from "../shared/launch.mjs";
import type { BrowserContext, Page } from "@playwright/test";

// J1.CH: a brand-new install, as a person sees it. The first-run page opens once, nothing asks them
// to sign in, the saved defaults are what the popup then shows, and blocking never waits for the
// page. V3 build only; a configured 2.x store build keeps its legacy install behaviour (the
// fixtures lane asserts that).

test.skip(syncConfigured, V3_ONLY);

async function firstRunPage(context: BrowserContext): Promise<Page> {
  const open = context.pages().find((page) => FIRST_RUN.test(page.url()));
  if (open) return open;
  return context.waitForEvent("page", { predicate: (page) => FIRST_RUN.test(page.url()), timeout: 15_000 });
}

test("J1.CH a new install opens the first-run page once and saves the defaults", async ({ context, evidence }) => {
  const ev = evidence("J1.CH");
  const page = await firstRunPage(context);
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveTitle("Welcome to Still");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Still is on.");
  await expect(page.getByText("Allowed on YouTube, Instagram, Facebook and TikTok.")).toBeVisible();
  await ev.shot(page, "first-run-just-installed");

  const record = await waitForCommittedSettings(context);
  expect(record.settings).toMatchObject({
    schemaVersion: 2,
    globalOn: true,
    services: { youtube: true, instagram: true, facebook: true, tiktok: true },
    pauses: [],
  });
  expect(record.atomic.ownership).toBe("never-linked");

  const dump = await ev.storage(context, "after-install");
  expect(Object.keys(dump).sort()).toEqual(["still:originalInstall", "still:settings"]);
  // Once: a quiet moment later there is still exactly one first-run page.
  await new Promise((done) => setTimeout(done, 1500));
  expect(context.pages().filter((p) => FIRST_RUN.test(p.url()))).toHaveLength(1);
});

test("J1.CH there is no account wall: sign-in is optional and the pin step is shown", async ({ context, evidence }) => {
  const ev = evidence("J1.CH");
  const page = await firstRunPage(context);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText("Pin Still to your toolbar")).toBeVisible();
  await expect(page.getByText("Click the puzzle piece in the toolbar, then the pin next to Still.")).toBeVisible();
  // The sync step says so in as many words, and nothing on the page is a modal or a required field.
  const sync = page.locator("li, section, div").filter({ hasText: "Settings sync" }).filter({ hasText: "Optional" }).first();
  await expect(sync).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("input:not([type=hidden])")).toHaveCount(0);
  // The combined email-and-usage consent question of earlier drafts is not part of this build.
  await expect(page.getByText("Share your email and usage data with Still?")).toHaveCount(0);
  await ev.shot(page, "first-run-no-account-wall");
});

test("J1.CH after first run the popup shows the saved defaults, and blocking never needed the page", async ({
  context,
  extensionId,
  evidence,
}) => {
  const ev = evidence("J1.CH");
  await (await firstRunPage(context)).close();
  await waitForCommittedSettings(context);

  // Blocking on a fresh install, first-run page closed unread.
  const youtube = await context.newPage();
  await serveFixture(youtube, "**://*.youtube.com/**", "youtube.html");
  await youtube.goto("https://www.youtube.com/feed/subscriptions");
  await expect(youtube.locator("#shelf")).toBeHidden();
  await expect(youtube.locator("#rich-shorts-section")).toBeHidden();
  await expect(youtube.locator("#keep-video")).toBeVisible();
  await ev.shot(youtube, "youtube-fixture-blocked");

  const popup = await openExtensionPage(context, extensionId, "popup", { width: 380, height: 600 });
  await expect(popup.getByRole("heading", { name: "Still is active" })).toBeVisible();
  for (const name of ["Still", "Still on YouTube", "Still on Instagram", "Still on Facebook", "TikTok website"])
    await expect(popup.getByRole("switch", { name, exact: true })).toHaveAttribute("aria-checked", "true");
  await ev.shot(popup, "popup-saved-defaults");
});

test("J1.CH Open Still settings leads from first run to the settings page", async ({ context, extensionId, evidence }) => {
  const ev = evidence("J1.CH");
  const page = await firstRunPage(context);
  const known = new Set(context.pages());
  await page.getByRole("button", { name: "Open Still settings" }).click();
  // Chrome opens an extension's embedded settings through its own extensions page, so the new tab
  // is chrome://extensions/?options=<id> (or the options page itself when Chrome opens it in a tab).
  await expect
    .poll(() => context.pages().filter((p) => !known.has(p)).map((p) => p.url()), { timeout: 10_000 })
    .toContainEqual(expect.stringMatching(new RegExp(`(chrome://extensions/\\?options=${extensionId}|${extensionId}/options\\.html)`)));
  const opened = context.pages().find((p) => !known.has(p))!;
  await ev.shot(opened, "settings-opened-from-first-run");
});

test.fixme(
  "J1.CH optional sign-in from first run: sign-in skipped, then signed in with a code from the local mailbox",
  async () => {
    // NEEDS_BACKEND: the unconfigured build has no live sign-in. Enable with the QA-P7 recipe.
    expect(NEEDS_BACKEND).toBeTruthy();
  },
);
