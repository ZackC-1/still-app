import type { BrowserContext, Page, Worker } from "@playwright/test";
import { test, expect } from "./_extension.js";

// The shipped Chromium build's network-layer copy of the format-2 navigation redirects. Builds that
// run the format-2 engine (the unconfigured fixture build) mirror the free redirects as
// declarativeNetRequest session rules, so the redirected address is the only one the network ever
// sees and the original page never commits. Configured (2.x store-style) builds keep the legacy
// static Shorts ruleset and never write a session rule; the configured lane asserts exactly that.

const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
const STATIC = "youtube-shorts-redirect";

type DnrWorker = {
  chrome: {
    declarativeNetRequest: {
      getSessionRules(): Promise<Array<{ id: number; condition: { requestDomains?: string[] } }>>;
      getEnabledRulesets(): Promise<string[]>;
    };
  };
};

async function backgroundOf(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? ((await context.waitForEvent("serviceworker")) as Worker);
}

async function dnrState(context: BrowserContext): Promise<{ domains: string[]; staticOn: boolean }> {
  const worker = await backgroundOf(context);
  return worker.evaluate(async (staticId) => {
    const dnr = (globalThis as unknown as DnrWorker).chrome.declarativeNetRequest;
    const rules = await dnr.getSessionRules();
    const domains = [...new Set(rules.flatMap((rule) => rule.condition.requestDomains ?? []))].sort();
    return { domains, staticOn: (await dnr.getEnabledRulesets()).includes(staticId) };
  }, STATIC);
}

/** Commits one saved choice through the real settings router, from a real extension page. */
async function commit(context: BrowserContext, extensionId: string, path: string, value: boolean) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const reply = await options.evaluate(
    ({ path, value }) =>
      (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } } }).chrome.runtime
        .sendMessage({ kind: "still:settings-intent", path, value, updatedAt: Date.now() }),
    { path, value },
  );
  expect(reply).toMatchObject({ status: "committed" });
  await options.close();
}

/** Serves a page for every request on the service and records what reached the network/commit. */
async function watch(page: Page, service: string) {
  const requested: string[] = [];
  const committed: string[] = [];
  await page.route(`**://*.${service}.com/**`, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><title>page</title><main id=page>page</main>" });
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) committed.push(frame.url());
  });
  return { requested, committed };
}

test.describe("configured build", () => {
  test.skip(!syncConfigured, "Configured builds only: the legacy lane keeps the static Shorts ruleset");

  test("keeps the static Shorts ruleset and writes no session rule", async ({ context }) => {
    await expect.poll(async () => (await dnrState(context)).staticOn).toBe(true);
    expect((await dnrState(context)).domains).toEqual([]);
  });
});

test.describe("format-2 build", () => {
  test.skip(syncConfigured, "Format-2 session rules need committed schema-2 settings; configured builds stay legacy");
  test.use({ settingsProfile: "modern" });

  test.beforeEach(async ({ context }) => {
    await expect.poll(async () => (await dnrState(context)).domains).toEqual(["facebook.com", "instagram.com", "youtube.com"]);
  });

  test("the fresh defaults retire the static ruleset for session rules", async ({ context }) => {
    expect(await dnrState(context)).toEqual({ domains: ["facebook.com", "instagram.com", "youtube.com"], staticOn: false });
    // Every compiled rule was accepted (Chrome rejects the whole update if one regex is refused).
    const worker = await backgroundOf(context);
    const ids = await worker.evaluate(async () =>
      (await (globalThis as unknown as DnrWorker).chrome.declarativeNetRequest.getSessionRules()).map((rule) => rule.id).sort((a, b) => a - b));
    expect(ids).toEqual([1, 2, 11, 12, 13, 21]);
  });

  for (const [from, to] of [
    ["https://www.youtube.com/shorts/abc123?feature=share", "https://www.youtube.com/watch?feature=share&v=abc123"],
    ["https://m.youtube.com/shorts/abc123", "https://m.youtube.com/watch?v=abc123"],
    ["https://www.instagram.com/reels/C0dE_1/?igsh=share", "https://www.instagram.com/reel/C0dE_1/?igsh=share"],
    ["https://www.instagram.com/reels/", "https://www.instagram.com/"],
    ["https://www.facebook.com/watch/reels/", "https://www.facebook.com/"],
    ["https://m.facebook.com/reels/", "https://m.facebook.com/"],
  ] as const)
    test(`${from} is redirected before the page loads`, async ({ context }) => {
      const page = await context.newPage();
      const seen = await watch(page, new URL(from).hostname.split(".").slice(-2)[0]!);
      await page.goto(from);
      await expect(page).toHaveURL(to);
      // The original address never reached the network and never committed a document.
      expect(seen.requested).toEqual([to]);
      expect(seen.committed).toEqual([to]);
    });

  for (const url of [
    "https://www.instagram.com/reels/audio/123/",
    "https://www.instagram.com/reels/audio/",
    "https://www.instagram.com/someuser/reel/C0dE/",
    "https://www.instagram.com/reel/C0dE/",
    "https://www.facebook.com/someuser/reels_tab",
    "https://www.facebook.com/reel/123456",
    "https://www.youtube.com/watch?v=abc123",
  ])
    test(`${url} stays reachable`, async ({ context }) => {
      const page = await context.newPage();
      const seen = await watch(page, new URL(url).hostname.split(".").slice(-2)[0]!);
      await page.goto(url);
      await expect(page.locator("#page")).toBeVisible();
      await expect(page).toHaveURL(url);
      expect(seen.requested).toEqual([url]);
    });

  test("a saved Off removes that service's rule before the reply, and On restores it", async ({ context, extensionId }) => {
    await commit(context, extensionId, "sites.instagram.reels", false);
    // No polling: the reply already means the rules match the saved choice.
    expect((await dnrState(context)).domains).toEqual(["facebook.com", "youtube.com"]);
    const page = await context.newPage();
    const seen = await watch(page, "instagram");
    await page.goto("https://www.instagram.com/reels/C0dE_1/");
    await expect(page.locator("#page")).toBeVisible();
    await expect(page).toHaveURL("https://www.instagram.com/reels/C0dE_1/");
    expect(seen.requested).toEqual(["https://www.instagram.com/reels/C0dE_1/"]);

    await commit(context, extensionId, "sites.instagram.reels", true);
    expect((await dnrState(context)).domains).toEqual(["facebook.com", "instagram.com", "youtube.com"]);
    await page.goto("https://www.instagram.com/reels/C0dE_1/");
    await expect(page).toHaveURL("https://www.instagram.com/reel/C0dE_1/");
  });

  test("the master switch Off removes every rule; the static ruleset stays off", async ({ context, extensionId }) => {
    await commit(context, extensionId, "globalOn", false);
    expect(await dnrState(context)).toEqual({ domains: [], staticOn: false });
    const page = await context.newPage();
    const seen = await watch(page, "youtube");
    await page.goto("https://www.youtube.com/shorts/abc123");
    await expect(page.locator("#page")).toBeVisible();
    await expect(page).toHaveURL("https://www.youtube.com/shorts/abc123");
    expect(seen.requested).toEqual(["https://www.youtube.com/shorts/abc123"]);
    await commit(context, extensionId, "globalOn", true);
    expect((await dnrState(context)).domains).toEqual(["facebook.com", "instagram.com", "youtube.com"]);
  });
});
