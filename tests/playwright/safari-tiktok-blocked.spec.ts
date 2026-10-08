import { test, expect, fixture } from "./_extension.js";
import type { BrowserContext, Worker } from "@playwright/test";

// Loads the actual Safari V3 JavaScript bundle in the existing Blink fixture. The native settings
// read is controlled; this proves composition and page disposal, not Safari sender/Port behavior.
test.skip(process.env.STILL_TEST_SAFARI_V3 !== "true", "Requires the explicitly built Safari V3 artifact; Blink bundle fixture only");
async function worker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
}
async function prepare(context: BrowserContext): Promise<Worker> {
  const sw = await worker(context);
  await sw.evaluate(async () => {
    const record = { settings: { globalOn: true, services: { youtube: true, instagram: true, facebook: true, tiktok: true }, pauses: [], updatedAt: 1 }, syncMetadata: null };
    const state = globalThis as unknown as { __nativeReads: number; __nativeUnavailable: boolean };
    state.__nativeReads = 0; state.__nativeUnavailable = false;
    chrome.runtime.sendNativeMessage = (async (_app: string, message: { kind?: string }) => {
      if (message.kind === "get") {
        state.__nativeReads++;
        if (state.__nativeUnavailable) throw new Error("Controlled native authority unavailable");
        return { settings: JSON.stringify(record) };
      }
      return { settings: "" };
    }) as typeof chrome.runtime.sendNativeMessage;
    await chrome.storage.local.set({ "still:settings": record });
  });
  await context.route("**://*.tiktok.com/**", (route) => route.fulfill({ contentType: "text/html", body: fixture("tiktok.html") }));
  return sw;
}
const blocked = /\/tiktok-blocked\.html\?r=/;

test("Safari V3 bundle uses native committed reads and a live document connection for the same-tab journey", async ({ safariContext }) => {
  const sw = await prepare(safariContext);
  const page = await safariContext.newPage(); await page.goto("https://www.tiktok.com/foryou", { waitUntil: "commit" });
  await page.waitForURL(blocked);
  await expect(page.getByRole("heading", { name: "TikTok stays closed." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open TikTok this time" })).not.toHaveAttribute("aria-disabled", "true");
  expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: "still:tiktok-confirm" }))).toEqual({ status: "failed" });
  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Open TikTok this time" }).click();
  await expect(page.getByText("Reload this page to open TikTok.")).toBeVisible();
  await page.getByRole("button", { name: "Reload page" }).click();
  await page.waitForURL("https://www.tiktok.com/foryou"); await expect(page.locator("#tiktok-feed")).toBeVisible();
  expect(await sw.evaluate(() => (globalThis as unknown as { __nativeReads: number }).__nativeReads)).toBeGreaterThan(1);
  const other = await safariContext.newPage(); await other.goto("https://www.tiktok.com/foryou", { waitUntil: "commit" }); await other.waitForURL(blocked);
  await page.close();
  await expect.poll(() => sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter(k => k.startsWith("still:tiktok-tab:")))).toEqual([]);
});

test("Safari V3 bundle retires the host and live connection on pagehide before a delayed reopen reply", async ({ safariContext }) => {
  await prepare(safariContext);
  const page = await safariContext.newPage(); await page.goto("https://www.tiktok.com/foryou", { waitUntil: "commit" }); await page.waitForURL(blocked);
  await page.getByRole("button", { name: "Open TikTok this time" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Open TikTok this time" }).click();
  await expect(page.getByText("Reload this page to open TikTok.")).toBeVisible();
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((message: { kind?: string }) => message.kind === "still:tiktok-open"
      ? new Promise(resolve => { void send(message).then(reply => { (window as unknown as { __release?: () => void }).__release = () => resolve(reply); }); })
      : send(message)) as typeof chrome.runtime.sendMessage;
  });
  await page.getByRole("button", { name: "Reload page" }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __release?: unknown }).__release)).toBe("function");
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide")); (window as unknown as { __release?: () => void }).__release?.(); });
  await page.waitForTimeout(250); expect(page.url()).toMatch(blocked);
  await expect(page.locator("#tiktok-feed")).toHaveCount(0);
});

test("Safari V3 bundle refuses a stale projection when the native confirmation read fails", async ({ safariContext }) => {
  const sw = await prepare(safariContext);
  const page = await safariContext.newPage(); await page.goto("https://www.tiktok.com/foryou", { waitUntil: "commit" }); await page.waitForURL(blocked);
  await page.getByRole("button", { name: "Open TikTok this time" }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  await sw.evaluate(() => { (globalThis as unknown as { __nativeUnavailable: boolean }).__nativeUnavailable = true; });
  await page.getByRole("dialog").getByRole("button", { name: "Open TikTok this time" }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't open TikTok.");
  expect(await sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter(k => k.startsWith("still:tiktok-tab:")))).toEqual([]);
});
