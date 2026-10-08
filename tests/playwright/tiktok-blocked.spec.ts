import { test, expect, fixture } from "./_extension.js";
import type { BrowserContext, Page, Worker } from "@playwright/test";

// The TikTok blocked page (D29) in the built Chromium extension: an unconfigured build shows the
// V3 screens, so a blocked TikTok tab goes to the extension's own page. "Open TikTok this time"
// allows that one living tab only, after the confirmation, and never changes saved settings.

const BLOCKED = /^chrome-extension:\/\/[a-p]{32}\/tiktok-blocked\.html\?r=[A-Za-z0-9-]+$/;

// The blocked page is a V3 screen: only builds that show the V3 screens use it. The CI configured
// lane builds a configured 2.x extension, which keeps today's in-page block (last test below).
const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
const V3_ONLY = "The TikTok blocked page is a V3 screen; configured 2.x builds keep the in-page block";

async function serve(context: BrowserContext): Promise<void> {
  // The blocked page acts only on committed settings; wait for this fresh profile's first record.
  await expect
    .poll(async () => (await worker(context)).evaluate(async () => Boolean((await chrome.storage.local.get("still:settings"))["still:settings"])))
    .toBe(true);
  await context.route("**://*.tiktok.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture("tiktok.html") }),
  );
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: "<h1 id='elsewhere'>Elsewhere</h1>" }),
  );
}

async function worker(context: BrowserContext): Promise<Worker> {
  const [sw] = context.serviceWorkers();
  return sw ?? ((await context.waitForEvent("serviceworker")) as Worker);
}

const savedSettings = async (context: BrowserContext) =>
  (await worker(context)).evaluate(async () => (await chrome.storage.local.get("still:settings"))["still:settings"]);
const sessionKeys = async (context: BrowserContext) =>
  (await worker(context)).evaluate(async () => Object.keys(await chrome.storage.session.get(null)).sort());

async function openBlocked(page: Page, url = "https://www.tiktok.com/foryou"): Promise<void> {
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForURL(BLOCKED, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "TikTok stays closed." })).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
}

async function allowThisTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Open TikTok in this tab?");
  await dialog.getByRole("button", { name: "Open TikTok this time" }).click();
  await expect(page.getByText("Reload this page to open TikTok.")).toBeVisible();
  await page.getByRole("button", { name: "Reload page" }).click();
}

test("blocked TikTok opens the extension page; Open TikTok this time allows this one living tab only", async ({ context }) => {
  test.skip(syncConfigured, V3_ONLY);
  test.setTimeout(90_000);
  await serve(context);
  const page = await context.newPage();
  await page.goto("https://example.com/start");
  await openBlocked(page);
  const before = await savedSettings(context);

  await allowThisTab(page);
  await page.waitForURL("https://www.tiktok.com/foryou");
  await expect(page.locator("#tiktok-feed")).toBeVisible();
  await expect(page.locator("#still-placeholder")).toHaveCount(0);

  // Same tab: other TikTok addresses stay open.
  await page.goto("https://www.tiktok.com/@still/video/1");
  await expect(page.locator("#tiktok-feed")).toBeVisible();
  expect(page.url()).toBe("https://www.tiktok.com/@still/video/1");

  // Any other tab is still blocked.
  const other = await context.newPage();
  await openBlocked(other, "https://www.tiktok.com/@still/video/1");

  // The allowance never touched saved (or synced) settings.
  expect(await savedSettings(context)).toEqual(before);

  // Closing the allowed tab clears its allowance; the other tab's binding remains until it closes.
  const keys = await sessionKeys(context);
  expect(keys.filter((key) => key.startsWith("still:tiktok-tab:"))).toHaveLength(1);
  await page.close();
  await expect.poll(async () => (await sessionKeys(context)).filter((key) => key.startsWith("still:tiktok-tab:"))).toEqual([]);
  await other.close();
  await expect.poll(() => sessionKeys(context)).toEqual([]);
});

test("the installed page retires a delayed reopen reply on pagehide", async ({ context }, testInfo) => {
  test.skip(syncConfigured, V3_ONLY);
  await serve(context);
  const page = await context.newPage();
  await openBlocked(page);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("d29-blocked.png") });
  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("d29-confirmation.png") });
  await dialog.getByRole("button", { name: "Open TikTok this time" }).click();
  await expect(page.getByText("Reload this page to open TikTok.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("d29-reload.png") });
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    const w = window as unknown as { __releaseReopen?: () => void };
    chrome.runtime.sendMessage = ((message: { kind?: string }) => {
      if (message.kind !== "still:tiktok-open") return send(message);
      return new Promise((resolve) => {
        void send(message).then((reply: unknown) => { w.__releaseReopen = () => resolve(reply); });
      });
    }) as typeof chrome.runtime.sendMessage;
  });
  await page.getByRole("button", { name: "Reload page" }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __releaseReopen?: unknown }).__releaseReopen)).toBe("function");
  // Deliver pagehide while this native document is still inspectable, then release the genuine
  // background reply. This checks the actual installed entrypoint's disposal, not a fixture port.
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    (window as unknown as { __releaseReopen?: () => void }).__releaseReopen?.();
  });
  await page.waitForTimeout(250);
  expect(page.url()).toMatch(BLOCKED);
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
});

test("forged destination and another tab's blocked URL cannot confirm an allowance", async ({ context }) => {
  test.skip(syncConfigured, V3_ONLY);
  await serve(context);
  const page = await context.newPage();
  await openBlocked(page);
  const before = await savedSettings(context);
  // An extension-owned document alone is insufficient: no real confirmation has been requested.
  expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: "still:tiktok-confirm" }))).toEqual({ status: "failed" });
  const forged = await page.evaluate(async () => {
    try {
      return await chrome.runtime.sendMessage({ kind: "still:tiktok-request", url: "https://www.tiktok.com/@forged" });
    } catch { return null; }
  });
  expect(forged?.status).not.toBe("confirming");
  expect((await sessionKeys(context)).filter((key) => key.startsWith("still:tiktok-tab:"))).toEqual([]);

  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const duplicate = await context.newPage();
  await duplicate.goto(page.url());
  await expect(duplicate.getByRole("button", { name: "Open TikTok this time" })).toHaveAttribute("aria-disabled", "true");
  expect(await duplicate.evaluate(() => chrome.runtime.sendMessage({ kind: "still:tiktok-confirm" }))).toEqual({ status: "failed" });
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Keep it closed" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await sessionKeys(context)).filter((key) => key.startsWith("still:tiktok-tab:"))).toEqual([]);
  expect(await savedSettings(context)).toEqual(before);
});

test("Keep it closed grants nothing and a fresh tab or reload stays blocked", async ({ context }) => {
  test.skip(syncConfigured, V3_ONLY);
  test.setTimeout(60_000);
  await serve(context);
  const page = await context.newPage();
  await openBlocked(page);
  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Keep it closed" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open TikTok this time" })).toBeVisible();
  expect((await sessionKeys(context)).filter((key) => key.startsWith("still:tiktok-tab:"))).toEqual([]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Open TikTok this time" })).toBeVisible();
  await expect(page.getByText("Reload this page to open TikTok.")).toHaveCount(0);
});

test("a failed open shows Couldn't open TikTok, and Try again asks again before anything opens", async ({ context }) => {
  test.skip(syncConfigured, V3_ONLY);
  test.setTimeout(90_000);
  await serve(context);
  const page = await context.newPage();
  await openBlocked(page);
  const before = await savedSettings(context);
  const tabKeys = async () => (await sessionKeys(context)).filter((key) => key.startsWith("still:tiktok-tab:"));

  // The confirm answer is lost on its way from this page (owner decision 34's failure case). The
  // page's own messenger is wrapped, so the background never receives the confirm at all.
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    const w = window as unknown as { __stillRestoreSend?: () => void };
    w.__stillRestoreSend = () => {
      chrome.runtime.sendMessage = send;
    };
    chrome.runtime.sendMessage = ((message: { kind?: string }) =>
      message?.kind === "still:tiktok-confirm" ? Promise.resolve({ status: "failed" }) : send(message)) as typeof chrome.runtime.sendMessage;
  });
  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Open TikTok this time" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Couldn't open TikTok.");
  await expect(dialog).toHaveCount(0);
  expect(await tabKeys()).toEqual([]);
  expect(await savedSettings(context)).toEqual(before);

  await page.evaluate(() => (window as unknown as { __stillRestoreSend: () => void }).__stillRestoreSend());
  await alert.getByRole("button", { name: "Try again" }).click();
  // Try again only asks again: the confirmation returns and nothing is allowed yet.
  await expect(dialog).toContainText("Open TikTok in this tab?");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await tabKeys()).toEqual([]);
  await dialog.getByRole("button", { name: "Open TikTok this time" }).click();
  await expect(page.getByText("Reload this page to open TikTok.")).toBeVisible();
  await page.getByRole("button", { name: "Reload page" }).click();
  await page.waitForURL("https://www.tiktok.com/foryou");
  await expect(page.locator("#tiktok-feed")).toBeVisible();
  expect(await savedSettings(context)).toEqual(before);
});

test("with TikTok turned off, TikTok loads normally and no blocked page appears", async ({ context, extensionId }) => {
  test.skip(syncConfigured, V3_ONLY);
  await serve(context);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const reply = await options.evaluate(() =>
    chrome.runtime.sendMessage({ kind: "still:settings-intent", path: "services.tiktok", value: false, updatedAt: Date.now() }),
  );
  expect(reply).toMatchObject({ status: "committed" });
  const page = await context.newPage();
  await page.goto("https://www.tiktok.com/foryou");
  await expect(page.locator("#tiktok-feed")).toBeVisible();
  await page.waitForTimeout(500);
  expect(page.url()).toBe("https://www.tiktok.com/foryou");
  await expect(page.locator("#still-placeholder")).toHaveCount(0);
});

test("Back from the blocked page leaves TikTok without bouncing forward again", async ({ context }) => {
  test.skip(syncConfigured, V3_ONLY);
  test.setTimeout(60_000);
  await serve(context);
  const page = await context.newPage();
  await page.goto("https://example.com/start");
  await openBlocked(page);
  await page.goBack({ waitUntil: "commit" });
  // Chromium keeps the TikTok entry: it shows the in-page block instead of re-sending the tab.
  await expect(page.locator("#still-placeholder")).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
  expect(page.url()).toBe("https://www.tiktok.com/foryou");
  await page.goBack({ waitUntil: "commit" });
  await expect(page.locator("#elsewhere")).toBeVisible();
});

test("configured 2.x build: TikTok keeps the in-page block and is never sent to the blocked page", async ({ context }) => {
  test.skip(!syncConfigured, "Requires the independently declared configured build");
  // Give this profile a readable saved record with TikTok on, so a wrongly enabled gate would
  // really redirect: without one, the background fails closed and the in-page block hides it.
  await (await worker(context)).evaluate(async () => {
    await chrome.storage.local.set({
      "still:settings": {
        settings: {
          globalOn: true,
          services: { youtube: true, instagram: true, facebook: true, tiktok: true },
          pauses: [],
          updatedAt: 1,
        },
        syncMetadata: null,
      },
    });
  });
  await context.route("**://*.tiktok.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture("tiktok.html") }),
  );
  const page = await context.newPage();
  const visited: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) visited.push(frame.url());
  });
  await page.goto("https://www.tiktok.com/foryou");
  await expect(page.locator("#still-placeholder")).toBeVisible();
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
  // Give a (wrongly wired) background time to answer a redirect request before checking.
  await page.waitForTimeout(1_500);
  expect(page.url()).toBe("https://www.tiktok.com/foryou");
  expect(visited.filter((url) => url.includes("tiktok-blocked.html"))).toEqual([]);
});
