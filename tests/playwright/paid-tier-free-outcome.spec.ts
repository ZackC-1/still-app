import { existsSync, readFileSync } from "node:fs";
import { test, expect, fixture } from "./_extension.js";
import type { BrowserContext, Page, Worker } from "@playwright/test";

// ISS-0036: the free TikTok block with the paid tier compiled on. Every shipped 2.x build has
// PAID_TIER_ENABLED off, so the ordinary fixture lanes never exercise the tier gate that V3 Pro
// builds and paid sandbox QA builds run. In the paid sandbox Chrome build a fresh, signed-out
// profile without Still Pro let tiktok.com, /@tiktok, /explore and /messages load and play.
//
// This spec runs only against the paid-tier-on builds from `node scripts/qa/paid-tier-extension.mjs`
// (CI's third Playwright step), loaded through STILL_CHROMIUM_EXTENSION / STILL_SAFARI_EXTENSION.
// It checks the build's marker first, so it can never pass against a paid-off build. TikTok is a
// recorded fixture (route interception); nothing here touches the network.
const PAID = process.env.STILL_TEST_PAID_TIER === "true";
test.skip(!PAID, "Runs only in the paid-tier-on Playwright step (STILL_TEST_PAID_TIER=true)");

const BLOCKED = /^chrome-extension:\/\/[a-p]{32}\/tiktok-blocked\.html\?r=[A-Za-z0-9-]+$/;
const TIKTOK_PAGES = [
  "https://www.tiktok.com/",
  "https://www.tiktok.com/@tiktok",
  "https://www.tiktok.com/explore",
  "https://www.tiktok.com/messages",
  "https://www.tiktok.com/foryou",
];

function expectPaidBuild(variable: "STILL_CHROMIUM_EXTENSION" | "STILL_SAFARI_EXTENSION"): void {
  const path = process.env[variable];
  expect(path, `${variable} must name the paid-tier-on build`).toBeTruthy();
  const marker = `${path}.paid-tier.json`;
  expect(existsSync(marker), `${marker} is missing: build with scripts/qa/paid-tier-extension.mjs`).toBe(true);
  expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ paidTierEnabled: true });
}

async function worker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? ((await context.waitForEvent("serviceworker")) as Worker);
}

async function serveTiktok(context: BrowserContext): Promise<void> {
  await context.route("**://*.tiktok.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture("tiktok.html") }),
  );
}

async function expectBlocked(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForURL(BLOCKED, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "TikTok stays closed." })).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
}

test("Chrome, paid tier on, signed out without Still Pro: every TikTok page shows the blocked page", async ({ context }) => {
  expectPaidBuild("STILL_CHROMIUM_EXTENSION");
  test.setTimeout(90_000);
  const sw = await worker(context);
  // A fresh profile, exactly as the owner's: the background commits its first settings record,
  // TikTok Blocker on, and holds no Still Pro access.
  await expect
    .poll(() => sw.evaluate(async () => {
      const record = (await chrome.storage.local.get("still:settings"))["still:settings"] as
        { settings?: { schemaVersion?: number; services?: { tiktok?: boolean } } } | undefined;
      return record?.settings?.schemaVersion === 2 && record.settings.services?.tiktok === true;
    }))
    .toBe(true);
  await serveTiktok(context);
  const page = await context.newPage();
  for (const url of TIKTOK_PAGES) await expectBlocked(page, url);

  // "Open TikTok this time" still opens this one tab, and only this tab.
  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Open TikTok this time" }).click();
  await expect(page.getByText("Reload this page to open TikTok.")).toBeVisible();
  await page.getByRole("button", { name: "Reload page" }).click();
  await page.waitForURL("https://www.tiktok.com/foryou");
  await expect(page.locator("#tiktok-feed")).toBeVisible();
  await expectBlocked(await context.newPage(), "https://www.tiktok.com/");
});

test("Safari bundle, paid tier on, without Still Pro: TikTok shows the blocked page", async ({ safariContext }) => {
  test.skip(!process.env.STILL_SAFARI_EXTENSION, "The paid-tier-on Safari bundle was not supplied");
  expectPaidBuild("STILL_SAFARI_EXTENSION");
  const sw = await worker(safariContext);
  // The Safari background reads committed settings from its native host; this Blink fixture
  // answers that read with a fresh TikTok-on record (as safari-tiktok-blocked.spec.ts does).
  await sw.evaluate(async () => {
    const record = { settings: { globalOn: true, services: { youtube: true, instagram: true, facebook: true, tiktok: true }, pauses: [], updatedAt: 1 }, syncMetadata: null };
    chrome.runtime.sendNativeMessage = (async (_app: string, message: { kind?: string }) =>
      message.kind === "get" ? { settings: JSON.stringify(record) } : { settings: "" }) as typeof chrome.runtime.sendNativeMessage;
    await chrome.storage.local.set({ "still:settings": record });
  });
  await serveTiktok(safariContext);
  const page = await safariContext.newPage();
  for (const url of TIKTOK_PAGES) {
    await page.goto(url, { waitUntil: "commit" });
    await page.waitForURL(/\/tiktok-blocked\.html\?r=/, { waitUntil: "commit" });
    await expect(page.getByRole("heading", { name: "TikTok stays closed." })).toBeVisible();
  }
});
