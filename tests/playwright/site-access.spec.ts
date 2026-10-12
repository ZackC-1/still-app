import type { Page } from "@playwright/test";
import { test, expect } from "./_extension.js";

// ISS-0037 (retest CH-36): with Chrome's site access set to "When you click the extension" (or a
// site removed), Still used to stop blocking silently. The V3 popup and settings page now ask the
// browser whether Still has its four declared sites, warn at the top while it does not, and ask
// for exactly those four sites from Allow.
//
// How access is withheld here: Playwright cannot drive chrome://extensions, and Chrome refuses
// `chrome.permissions.remove()` for install-time host permissions ("You cannot remove required
// permissions"), so a real unpacked build cannot be put into the withheld state from a test. The
// first test therefore checks the real, unmocked answer (a fresh install has the four sites, so no
// warning). The others replace `chrome.permissions` on the extension page only, before any page
// script runs, with a stand-in that reports the sites withheld until its `request` is called, and
// records each request's origins and whether Chrome saw a user gesture at that moment
// (`navigator.userActivation.isActive`), which is what Chrome's real prompt requires. The real
// withheld state is exercised on Firefox, which lets an add-on remove its own host access
// (tests/firefox/site-access.spec.ts).
//
// The warning is a V3 screen. A configured (2.x store-style) build keeps its existing popup and
// settings page, so this file runs in the unconfigured lane only.
const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
test.skip(syncConfigured, "The site access warning is on the V3 popup and settings page only.");
test.use({ settingsProfile: "modern" });

const TITLE = "Still can't work on these sites yet";
const BODY = "Still needs permission to work on Instagram, Facebook, YouTube, and TikTok.";

type Probe = { requests: { origins: string[]; gesture: boolean }[]; granted: boolean };

/** Withhold Still's sites on this extension page until `request` is answered with `grant`. */
async function withholdSiteAccess(page: Page, grant: boolean) {
  await page.addInitScript((grant) => {
    type Listener = () => void;
    const permissions = (globalThis as unknown as { chrome: { permissions: Record<string, unknown> } })
      .chrome.permissions;
    const probe: Probe = { requests: [], granted: false };
    (window as unknown as { stillProbe: Probe }).stillProbe = probe;
    const added = new Set<Listener>();
    const realContains = (permissions.contains as (q: unknown) => Promise<boolean>).bind(permissions);
    permissions.contains = async (query: { origins?: string[] }) =>
      query.origins?.length ? probe.granted : realContains(query);
    permissions.request = (query: { origins: string[] }) => {
      probe.requests.push({
        origins: [...query.origins],
        gesture: navigator.userActivation.isActive,
      });
      return new Promise<boolean>((resolve) =>
        setTimeout(() => {
          if (grant) probe.granted = true;
          resolve(grant);
          if (grant) added.forEach((listener) => listener());
        }, 150),
      );
    };
    permissions.onAdded = {
      addListener: (listener: Listener) => added.add(listener),
      removeListener: (listener: Listener) => added.delete(listener),
      hasListener: (listener: Listener) => added.has(listener),
    };
  }, grant);
}

const probe = (page: Page) =>
  page.evaluate(() => (window as unknown as { stillProbe: Probe }).stillProbe);
const declaredHosts = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as {
    chrome: { runtime: { getManifest(): { host_permissions: string[] } } };
  }).chrome.runtime.getManifest().host_permissions);

async function expectAboveSiteList(page: Page) {
  const card = page.getByRole("region", { name: TITLE });
  await expect(card).toBeVisible();
  const first = page.getByRole("switch", { name: "Still on Instagram" });
  await expect(first).toBeVisible();
  const [cardBox, siteBox] = [await card.boundingBox(), await first.boundingBox()];
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(siteBox!.y);
}

test("a fresh install has its four sites, so the popup and settings page show no warning", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole("switch", { name: "Still on Instagram" })).toBeVisible();
  // The real, unmocked browser answer for exactly the declared hosts.
  const hosts = await declaredHosts(page);
  expect(hosts).toEqual([
    "*://*.youtube.com/*",
    "*://*.instagram.com/*",
    "*://*.facebook.com/*",
    "*://*.tiktok.com/*",
  ]);
  expect(
    await page.evaluate(
      (origins) =>
        (globalThis as unknown as {
          chrome: { permissions: { contains(q: { origins: string[] }): Promise<boolean> } };
        }).chrome.permissions.contains({ origins }),
      hosts,
    ),
  ).toBe(true);
  await expect(page.getByRole("region", { name: TITLE })).toHaveCount(0);
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.getByRole("switch", { name: "Still on Instagram" })).toBeVisible();
  await expect(page.getByRole("region", { name: TITLE })).toHaveCount(0);
});

test("popup: withheld access shows the warning at the top, and Allow asks for the four sites in the click", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await withholdSiteAccess(page, true);
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expectAboveSiteList(page);
  const card = page.getByRole("region", { name: TITLE });
  await expect(card.getByText(BODY)).toBeVisible();
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card.getByText("Waiting for Chrome…")).toBeVisible();
  await expect(page.getByRole("region", { name: TITLE })).toHaveCount(0);
  const { requests } = await probe(page);
  expect(requests).toEqual([{ origins: await declaredHosts(page), gesture: true }]);
});

test("popup: a declined prompt says Chrome didn't allow it and offers Try again", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await withholdSiteAccess(page, false);
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const card = page.getByRole("region", { name: TITLE });
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card.getByText("Chrome didn't allow it.")).toBeVisible();
  await card.getByRole("button", { name: "Try again" }).click();
  await expect.poll(async () => (await probe(page)).requests.length).toBe(2);
  expect((await probe(page)).requests.every((request) => request.gesture)).toBe(true);
});

test("settings: withheld access shows the warning at the top, and Allow restores it", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await withholdSiteAccess(page, true);
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expectAboveSiteList(page);
  await page.getByRole("region", { name: TITLE }).getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("region", { name: TITLE })).toHaveCount(0);
  const { requests } = await probe(page);
  expect(requests).toEqual([{ origins: await declaredHosts(page), gesture: true }]);
});
