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
    expect(ids).toEqual([1, 2, 11, 12, 13, 14, 21, 22]);
  });

  for (const [from, to] of [
    ["https://www.youtube.com/shorts/abc123?feature=share", "https://www.youtube.com/watch?feature=share&v=abc123"],
    ["https://m.youtube.com/shorts/abc123", "https://m.youtube.com/watch?v=abc123"],
    ["https://www.instagram.com/reels/", "https://www.instagram.com/"],
    // A profile's Reels tab opens the profile (ISS-0034).
    ["https://www.instagram.com/someuser/reels/?igsh=share", "https://www.instagram.com/someuser/"],
    ["https://www.facebook.com/watch/reels/", "https://www.facebook.com/"],
    ["https://m.facebook.com/reels/", "https://m.facebook.com/"],
    // The top-menu Reels tab's feed entry and the player's own feeds (ISS-0035).
    ["https://www.facebook.com/reel/?s=tab", "https://www.facebook.com/"],
    ["https://www.facebook.com/reel/following/", "https://www.facebook.com/"],
    ["https://m.facebook.com/reel/", "https://m.facebook.com/"],
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
    "https://www.instagram.com/reels/C0dE_1/?igsh=share",
    "https://www.instagram.com/reels/reels/",
    "https://www.instagram.com/reels/audio/123/",
    "https://www.instagram.com/reels/audio/",
    "https://www.instagram.com/someuser/reel/C0dE/",
    "https://www.instagram.com/someuser/tagged/",
    "https://www.instagram.com/reel/C0dE/",
    "https://www.facebook.com/someuser/reels_tab",
    "https://www.facebook.com/reel/123456",
    "https://www.facebook.com/reel/123456/?s=tab",
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

  test("site canonicalization of a shared Reel to its plural alias does not loop", async ({ context }) => {
    const page = await context.newPage();
    const requested: string[] = [];
    // Controlled site navigation, not a claimed recording of Instagram's redirect chain.
    await page.route("https://www.instagram.com/**", async (route) => {
      const url = new URL(route.request().url());
      requested.push(url.pathname);
      if (requested.length > 4) {
        // Bound a regressed redirect loop so the test reports its route chain promptly.
        await route.fulfill({ contentType: "text/html", body: "<!doctype html><main>Repeated alias redirect</main>" });
      } else if (url.pathname === "/reel/A1/") {
        await route.fulfill({ contentType: "text/html", body: '<!doctype html><script>location.replace("/reels/A1/?igsh=share")</script>' });
      } else {
        await route.fulfill({ contentType: "text/html", body: "<!doctype html><main id=player>Shared clip</main>" });
      }
    });
    await page.goto("https://www.instagram.com/reel/A1/?igsh=share");
    await expect.poll(() => requested).toEqual(["/reel/A1/", "/reels/A1/"]);
    await expect(page.locator("#player")).toBeVisible();
    await expect(page).toHaveURL("https://www.instagram.com/reels/A1/?igsh=share");
    expect(requested).toEqual(["/reel/A1/", "/reels/A1/"]);
    await expect(page.locator("html")).toHaveClass(/still-feature-\d+-instagram-reels/);
    await page.evaluate(() => history.pushState(null, "", "/reel/A1/?igsh=share"));
    await expect(page).toHaveURL("https://www.instagram.com/reel/A1/?igsh=share");
    await page.evaluate(() => history.pushState(null, "", "/reels/B2/"));
    await expect(page).toHaveURL("https://www.instagram.com/");
  });

  // Fragments, pinned on real Chromium: declarativeNetRequest matches the request URL WITH its
  // fragment, so the rules (which never match a "#") leave these to the content script. The
  // original document commits (without its fragment on the wire) and the content script then
  // makes the classifier's own redirect: Shorts keep the fragment, the Reels feed goes home
  // without it. So no rule can ever carry a fragment somewhere the classifier would not.
  for (const [from, to] of [
    ["https://www.youtube.com/shorts/abc123#t=10", "https://www.youtube.com/watch?v=abc123#t=10"],
    ["https://www.instagram.com/reels/#x", "https://www.instagram.com/"],
  ] as const)
    test(`${from} is left to the content script`, async ({ context }) => {
      const page = await context.newPage();
      const seen = await watch(page, new URL(from).hostname.split(".").slice(-2)[0]!);
      await page.goto(from).catch(() => {}); // replaced while loading
      await expect(page).toHaveURL(to);
      const wire = (url: string) => url.replace(/#.*$/, "");
      expect(seen.requested).toEqual([wire(from), wire(to)]);
      expect(seen.committed[0]).toBe(from);
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
    await expect(page).toHaveURL("https://www.instagram.com/reels/C0dE_1/");
  });

  // ISS-0078. Drives the Settings page's own YouTube "Shorts" row, as a person does. Off: the
  // network layer and the content script both leave a direct Shorts link alone while YouTube stays
  // On. On: the open Shorts page is sent to the watch page (proving the content script was running
  // there and chose not to redirect) and a new Shorts link is redirected before it loads again.
  // On live YouTube, check this with a real Short's ID: YouTube itself answers /shorts/<id> for an
  // ordinary video with a 303 to /watch?v=<id>, which looks exactly like this switch being ignored.
  test("the YouTube Shorts row Off lets a direct Shorts link load; On redirects again", async ({ context, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.getByRole("button", { name: "YouTube Blocker" }).click();
    const shorts = options.getByRole("switch", { name: "Shorts", exact: true });
    await expect(shorts).toHaveAttribute("aria-checked", "true");
    await shorts.click();
    await expect(shorts).toHaveAttribute("aria-checked", "false");
    await expect(options.getByRole("switch", { name: "Still on YouTube", exact: true })).toHaveAttribute("aria-checked", "true");
    // An Off is saved only after its rules are gone. On this lane the static ruleset is off whatever
    // the Shorts choice, so this only proves Off does not bring it back; the legacy-lane gate is
    // covered in packages/ext-chromium/lib/__tests__/navigation-dnr.test.ts.
    expect(await dnrState(context)).toEqual({ domains: ["facebook.com", "instagram.com"], staticOn: false });

    const url = "https://www.youtube.com/shorts/abc123?feature=share";
    const page = await context.newPage();
    const seen = await watch(page, "youtube");
    await page.goto(url);
    await expect(page.locator("#page")).toBeVisible();
    await expect(page).toHaveURL(url);
    expect(seen.requested).toEqual([url]);

    await shorts.click();
    await expect(shorts).toHaveAttribute("aria-checked", "true");
    const watchUrl = "https://www.youtube.com/watch?feature=share&v=abc123";
    await expect(page).toHaveURL(watchUrl);
    await expect.poll(async () => (await dnrState(context)).domains).toEqual(["facebook.com", "instagram.com", "youtube.com"]);
    const again = await context.newPage();
    const seenAgain = await watch(again, "youtube");
    await again.goto(url);
    await expect(again).toHaveURL(watchUrl);
    expect(seenAgain.requested).toEqual([watchUrl]);
  });

  test("the real switch saves Off only after every rule is gone; a page opened that moment is left alone", async ({ context, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    const control = options.getByRole("switch", { name: /^(Still|Still on\/off)$/, exact: true });
    await expect(control).toHaveAttribute("aria-checked", "true");
    // The first moment any context can read the saved Off (a storage listener, as every page's
    // settings cache has) the rules must already be gone. Saving first and removing after would
    // leave a window in which a page that read Off was still redirected.
    await options.evaluate(() => {
      const probe = globalThis as unknown as {
        rulesWhenOffSaved: number | "pending" | null;
        chrome: {
          storage: { onChanged: { addListener(fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void } };
          declarativeNetRequest: { getSessionRules(): Promise<unknown[]> };
        };
      };
      probe.rulesWhenOffSaved = null;
      probe.chrome.storage.onChanged.addListener((changes, area) => {
        const saved = changes["still:settings"]?.newValue as { settings?: { globalOn?: unknown } } | undefined;
        if (area !== "local" || saved?.settings?.globalOn !== false || probe.rulesWhenOffSaved !== null) return;
        probe.rulesWhenOffSaved = "pending";
        void probe.chrome.declarativeNetRequest.getSessionRules().then((rules) => { probe.rulesWhenOffSaved = rules.length; });
      });
    });
    const page = await context.newPage();
    const seen = await watch(page, "facebook");
    await control.click();
    await expect(control).toHaveAttribute("aria-checked", "false");
    // No polling and no settle time: the switch showing Off is the promise that nothing redirects.
    await page.goto("https://www.facebook.com/watch/reels/");
    await expect(page.locator("#page")).toBeVisible();
    await expect(page).toHaveURL("https://www.facebook.com/watch/reels/");
    expect(seen.requested).toEqual(["https://www.facebook.com/watch/reels/"]);
    await expect
      .poll(() => options.evaluate(() => (globalThis as unknown as { rulesWhenOffSaved: unknown }).rulesWhenOffSaved))
      .toBe(0);

    // On is the safe direction: other pages may read the saved On a moment before its rules are
    // added, and the content script redirects in the meantime, so the rules follow by polling.
    await control.click();
    await expect(control).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await dnrState(context)).domains).toEqual(["facebook.com", "instagram.com", "youtube.com"]);
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
