import type { BrowserContext, Page, Worker } from "@playwright/test";
import { test, expect } from "./_extension.js";

// U13-P2: the sync invitation card in the popup only. Three lanes, because the card needs a V3
// build that can actually sign someone in:
//   - configured store-style build (STILL_TEST_SYNC_CONFIGURED=true): legacy popup, nothing here
//     exists, and nothing is written;
//   - unconfigured V3 build (the other CI lane): the milestone is counted but there is no sign-in to
//     invite, so no card ever shows;
//   - V3 build with sign-in (placeholder Supabase values plus VITE_MODERN_SETTINGS_SYNC_ENABLED=true,
//     built into a temporary directory): the full card flow. Run it with
//       STILL_CHROMIUM_EXTENSION=/tmp/modern-configured STILL_EXPECT_MODERN_SIGN_IN=1
//     It is skipped everywhere else because CI builds only the first two.

const LEGACY = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
const MODERN_SIGN_IN = process.env.STILL_EXPECT_MODERN_SIGN_IN === "1";
const KEY = "still:invitationLedger";
const CARD = "Use the same settings in every browser";

type Ledger = { milestones: number; sync: string; shown: number; reservation: unknown } | undefined;
type StorageWorker = { chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } } };

async function worker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
}
async function ledger(context: BrowserContext): Promise<Ledger> {
  const w = await worker(context);
  return w.evaluate(async (key) => {
    const raw = await (globalThis as unknown as StorageWorker).chrome.storage.local.get(key);
    return raw[key] as Ledger;
  }, KEY);
}
async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await context.route(/^https?:/, (route) => route.abort());
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole("switch")).toHaveCount(5);
  return page;
}
/** Three real, successful, direct changes in one popup opening: two sites and the global switch. */
async function threeDirectToggles(page: Page): Promise<void> {
  const switches = page.getByRole("switch");
  await switches.nth(1).click();
  await expect(switches.nth(1)).toHaveAttribute("aria-checked", "false");
  await switches.nth(2).click();
  await expect(switches.nth(2)).toHaveAttribute("aria-checked", "false");
  await switches.nth(0).click();
  await expect(switches.nth(0)).toHaveAttribute("aria-checked", "false");
}

test.describe("configured store-style build", () => {
  test.skip(!LEGACY, "Legacy lane only");
  test("shows no invitation and never writes a ledger", async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId);
    await page.getByRole("switch").first().click();
    await page.waitForTimeout(500);
    await page.close();
    const again = await openPopup(context, extensionId);
    await expect(again.getByRole("region", { name: CARD })).toHaveCount(0);
    expect(await ledger(context)).toBeUndefined();
  });
});

test.describe("V3 build without sign-in", () => {
  test.skip(LEGACY || MODERN_SIGN_IN, "Needs the unconfigured V3 build");
  test.use({ settingsProfile: "modern" });
  test("counts the milestone but never shows a card, because there is nothing to sign in to", async ({ context, extensionId }) => {
    const first = await openPopup(context, extensionId);
    await threeDirectToggles(first);
    await expect.poll(async () => (await ledger(context))?.milestones).toBe(3);
    await first.close();
    const later = await openPopup(context, extensionId);
    await later.waitForTimeout(500);
    await expect(later.getByRole("region", { name: CARD })).toHaveCount(0);
    expect(await ledger(context)).toMatchObject({ milestones: 3, sync: "due", shown: 0, reservation: null });
  });
});

test.describe("V3 build with sign-in", () => {
  test.skip(!MODERN_SIGN_IN, "Needs the modern sign-in build (see header)");
  test.use({ settingsProfile: "modern" });

  test("three direct toggles, then a later opening shows the card once; Not now consumes it", async ({ context, extensionId }) => {
    const first = await openPopup(context, extensionId);
    await expect(first.getByRole("region", { name: CARD })).toHaveCount(0);
    await threeDirectToggles(first);
    await expect.poll(async () => (await ledger(context))?.sync).toBe("earned");
    // The opening that earned it never shows it.
    await expect(first.getByRole("region", { name: CARD })).toHaveCount(0);
    await first.close();

    const later = await openPopup(context, extensionId);
    const card = later.getByRole("region", { name: CARD });
    await expect(card).toBeVisible();
    await expect(card.getByText("Sign in for free settings sync. Optional.")).toBeVisible();
    // Consumed the moment it became visible, before anyone chose anything.
    expect(await ledger(context)).toMatchObject({ sync: "consumed", shown: 1, reservation: null });
    await card.getByRole("button", { name: "Not now" }).click();
    await expect(card).toHaveCount(0);
    await later.close();

    const third = await openPopup(context, extensionId);
    await third.waitForTimeout(500);
    await expect(third.getByRole("region", { name: CARD })).toHaveCount(0);
  });

  test("Sign in on the card opens the existing sign-in flow", async ({ context, extensionId }) => {
    const first = await openPopup(context, extensionId);
    await threeDirectToggles(first);
    await expect.poll(async () => (await ledger(context))?.sync).toBe("earned");
    await first.close();
    const later = await openPopup(context, extensionId);
    const card = later.getByRole("region", { name: CARD });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Sign in" }).click();
    await expect(card).toHaveCount(0);
    // The same sign-in sheet the Settings sync row opens: first its email-use notice.
    await expect(later.getByRole("dialog", { name: "Your email is only for sign-in" })).toBeVisible();
  });

  test("two toggles are not enough", async ({ context, extensionId }) => {
    const first = await openPopup(context, extensionId);
    const switches = first.getByRole("switch");
    await switches.nth(1).click();
    await expect(switches.nth(1)).toHaveAttribute("aria-checked", "false");
    await switches.nth(2).click();
    await expect(switches.nth(2)).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await ledger(context))?.milestones).toBe(2);
    await first.close();
    const later = await openPopup(context, extensionId);
    await later.waitForTimeout(500);
    await expect(later.getByRole("region", { name: CARD })).toHaveCount(0);
  });
});
