import { test, expect } from "../shared/fixtures.js";
import { NEEDS_BACKEND, V3_ONLY, syncConfigured } from "../shared/lane.js";
import { FIRST_RUN, serveFixture } from "../shared/serve.js";
import { openExtensionPage, readStore, waitForCommittedSettings, writeStore } from "../shared/launch.mjs";
import type { BrowserContext, Page } from "@playwright/test";

// J4.CH (settings: popup and options) and J10.CH (pause: global Still Off, choices kept), through
// real clicks and key presses, real storage, and a recorded YouTube page that must react without a
// reload. V3 build only.

test.skip(syncConfigured, V3_ONLY);

const SWITCH = {
  global: "Still",
  youtube: "Still on YouTube",
  instagram: "Still on Instagram",
  facebook: "Still on Facebook",
  tiktok: "TikTok website",
} as const;

type Saved = { settings: { globalOn: boolean; services: Record<string, boolean>; pauses: string[] } };
const saved = async (context: BrowserContext) => (await readStore(context, "still:settings")) as Saved;
const toggle = (page: Page, name: string) => page.getByRole("switch", { name, exact: true });

async function ready(context: BrowserContext): Promise<void> {
  await waitForCommittedSettings(context);
  // The install opens the first-run page; the journeys below start from settings, not from it.
  await Promise.all(context.pages().filter((p) => FIRST_RUN.test(p.url())).map((p) => p.close()));
}

test("J4.CH a service switch in the popup changes storage and an open YouTube page without a reload", async ({
  context,
  extensionId,
  evidence,
}) => {
  const ev = evidence("J4.CH");
  await ready(context);
  const youtube = await context.newPage();
  await serveFixture(youtube, "**://*.youtube.com/**", "youtube.html");
  await youtube.goto("https://www.youtube.com/feed/subscriptions");
  await expect(youtube.locator("#shelf")).toBeHidden();

  const popup = await openExtensionPage(context, extensionId, "popup", { width: 380, height: 600 });
  await toggle(popup, SWITCH.youtube).click();
  await expect(toggle(popup, SWITCH.youtube)).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await saved(context)).settings.services.youtube).toBe(false);
  // The page that was already open reflects it with no reload.
  await expect(youtube.locator("#shelf")).toBeVisible();
  await ev.shot(youtube, "youtube-off-no-reload");
  await ev.shot(popup, "popup-youtube-off");

  await toggle(popup, SWITCH.youtube).click();
  await expect.poll(async () => (await saved(context)).settings.services.youtube).toBe(true);
  await expect(youtube.locator("#shelf")).toBeHidden();
  await ev.storage(context, "youtube-back-on");
});

test("J4.CH popup and options stay consistent in both directions", async ({ context, extensionId, evidence }) => {
  const ev = evidence("J4.CH");
  await ready(context);
  const options = await openExtensionPage(context, extensionId, "options", { width: 560, height: 900 });
  await toggle(options, SWITCH.instagram).click();
  await expect.poll(async () => (await saved(context)).settings.services.instagram).toBe(false);

  const popup = await openExtensionPage(context, extensionId, "popup", { width: 380, height: 600 });
  await expect(toggle(popup, SWITCH.instagram)).toHaveAttribute("aria-checked", "false");
  await expect(toggle(popup, SWITCH.youtube)).toHaveAttribute("aria-checked", "true");

  await toggle(popup, SWITCH.instagram).click();
  await expect.poll(async () => (await saved(context)).settings.services.instagram).toBe(true);
  await options.reload();
  await expect(toggle(options, SWITCH.instagram)).toHaveAttribute("aria-checked", "true");
  await ev.shot(options, "options-consistent");
});

test("J4.CH every service switch saves its own choice and nothing else", async ({ context, extensionId, evidence }) => {
  const ev = evidence("J4.CH");
  await ready(context);
  const popup = await openExtensionPage(context, extensionId, "popup", { width: 380, height: 600 });
  for (const service of ["youtube", "instagram", "facebook", "tiktok"] as const) {
    await toggle(popup, SWITCH[service]).click();
    await expect.poll(async () => (await saved(context)).settings.services[service]).toBe(false);
    const { services, globalOn } = (await saved(context)).settings;
    expect(globalOn).toBe(true);
    expect(Object.entries(services).filter(([, on]) => !on).map(([name]) => name)).toEqual([service]);
    await toggle(popup, SWITCH[service]).click();
    await expect.poll(async () => (await saved(context)).settings.services[service]).toBe(true);
  }
  await ev.storage(context, "all-services-back-on");
});

test("J10.CH global Off keeps the choices and Off to On restores exactly the prior choices", async ({
  context,
  extensionId,
  evidence,
}) => {
  const ev = evidence("J10.CH");
  await ready(context);
  const youtube = await context.newPage();
  await serveFixture(youtube, "**://*.youtube.com/**", "youtube.html");
  await youtube.goto("https://www.youtube.com/feed/subscriptions");
  await expect(youtube.locator("#shelf")).toBeHidden();

  const popup = await openExtensionPage(context, extensionId, "popup", { width: 380, height: 600 });
  await toggle(popup, SWITCH.instagram).click();
  await expect.poll(async () => (await saved(context)).settings.services.instagram).toBe(false);

  await toggle(popup, SWITCH.global).click();
  await expect.poll(async () => (await saved(context)).settings.globalOn).toBe(false);
  // Off hides nothing, and the saved per-service choices are kept as they were.
  const off = (await saved(context)).settings;
  expect(off.services).toEqual({ youtube: true, instagram: false, facebook: true, tiktok: true });
  await expect(youtube.locator("#shelf")).toBeVisible();
  await expect(popup.getByRole("heading", { name: "Still is active" })).toHaveCount(0);
  await ev.shot(popup, "popup-still-off");
  await ev.shot(youtube, "youtube-still-off");

  await toggle(popup, SWITCH.global).click();
  await expect.poll(async () => (await saved(context)).settings.globalOn).toBe(true);
  expect((await saved(context)).settings.services).toEqual({ youtube: true, instagram: false, facebook: true, tiktok: true });
  await expect(youtube.locator("#shelf")).toBeHidden();
  await ev.shot(popup, "popup-restored");
});

test("J10.CH a seeded legacy pause record is ignored", async ({ context, evidence }) => {
  const ev = evidence("J10.CH");
  await ready(context);
  const record = (await readStore(context, "still:settings")) as { settings: Record<string, unknown> };
  await writeStore(context, {
    "still:settings": { ...record, settings: { ...record.settings, pauses: ["youtube.com"] } },
  });
  expect(((await saved(context)).settings.pauses)).toEqual(["youtube.com"]);
  const youtube = await context.newPage();
  await serveFixture(youtube, "**://*.youtube.com/**", "youtube.html");
  await youtube.goto("https://www.youtube.com/feed/subscriptions");
  // A host listed in the old per-site pause list is still blocked: that list is not read.
  await expect(youtube.locator("#shelf")).toBeHidden();
  await expect(youtube.locator("#keep-video")).toBeVisible();
  await ev.shot(youtube, "youtube-with-legacy-pause-record");
});

test("J4.CH the popup can be used with the keyboard alone", async ({ context, extensionId, evidence }) => {
  const ev = evidence("J4.CH");
  await ready(context);
  const popup = await openExtensionPage(context, extensionId, "popup", { width: 380, height: 600 });
  const order: string[] = [];
  for (let i = 0; i < 9; i++) {
    await popup.keyboard.press("Tab");
    order.push(
      await popup.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return "(none)";
        const ring = getComputedStyle(el);
        const visible = ring.outlineStyle !== "none" && parseFloat(ring.outlineWidth) > 0;
        return `${el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName}${visible ? "" : " [NO FOCUS RING]"}`;
      }),
    );
  }
  ev.log("tab-order", order);
  // First stops: the master switch, then each service's expander and switch, in reading order.
  expect(order.slice(0, 7)).toEqual([
    "Still",
    "YouTube Blocker",
    "Still on YouTube",
    "Instagram Blocker",
    "Still on Instagram",
    "Facebook Blocker",
    "Still on Facebook",
  ]);
  expect(order.filter((stop) => stop.includes("NO FOCUS RING"))).toEqual([]);

  // Space flips the focused switch, with real key presses: walk back to Instagram's switch.
  for (let i = 0; i < 12; i++) {
    const label = await popup.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    if (label === SWITCH.instagram) break;
    await popup.keyboard.press("Shift+Tab");
  }
  await popup.keyboard.press("Space");
  await expect.poll(async () => (await saved(context)).settings.services.instagram).toBe(false);
  await ev.shot(popup, "popup-keyboard-toggled");
});

test("J4.CH Setup guide in the settings reopens the first-run page", async ({ context, extensionId }) => {
  await ready(context);
  const options = await openExtensionPage(context, extensionId, "options", { width: 560, height: 900 });
  const reopened = context.waitForEvent("page", { predicate: (p) => FIRST_RUN.test(p.url()), timeout: 10_000 });
  await options.getByRole("button", { name: "Setup guide" }).click();
  const page = await reopened;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Still is on.");
});

test.fixme("J4.CH Contact support opens a mail to the support address", async () => {
  // The button sets window.location.href = "mailto:<SUPPORT_EMAIL>"; headless Chromium hands that
  // to the operating system and exposes no request or navigation to assert on, and the product
  // cannot grow a test hook for it. Verified by the owner-device pass, or by a unit test of the
  // handler.
});

test.fixme("J4.CH settings while signed in: sign-out keeps blocking and sync-failed states", async () => {
  // NEEDS_BACKEND: these need the QA-P7 local backend recipe.
  expect(NEEDS_BACKEND).toBeTruthy();
});
