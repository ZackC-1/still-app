import type { Page, Worker } from "@playwright/test";
import { paidOnExtrasTest as test } from "./_format2-extension";
import { extrasFixture } from "../../packages/core/src/rules/__tests__/extras-fixtures.js";

// YouTube Autoplay prevention with paid ON, in a DISPOSABLE copy of the built Chromium extension
// whose content script runs the real packaged rules with the Chromium host's capabilities and a
// purchased access snapshot (test-only seam). The shipping artifact stays byte-identical and paid
// OFF; extras-dormancy.spec.ts proves it does nothing on this fixture.
//
// Lanes: the copy replaces the worker and the content script with maintained source, so this runs
// the same in both CI lanes (like extras-youtube.spec.ts). The countdown and Cancel class names
// are unverified candidates (content/youtube-autoplay.ts); the fixture is synthetic.

const expect = test.expect;
const WATCH = "https://www.youtube.com/watch?v=inv300001";
const PLAYLIST = "https://www.youtube.com/watch?v=inv300003&list=PLinvented03&index=2";
type Probe = { toggleClicks: number; cancelClicks: number; ended: number; loads: number; token: string };

async function commit(authority: Worker, path: string, value: boolean) {
  await authority.evaluate(async ({ path, value }) => {
    await (globalThis as unknown as {
      fixtureAuthority: { commitIntent: (intent: unknown) => Promise<unknown> };
    }).fixtureAuthority.commitIntent({ path, value, updatedAt: Date.now() });
  }, { path, value });
}
async function open(page: Page, url: string) {
  await page.context().route(/^https?:/, (route) => {
    const target = new URL(route.request().url());
    if (!target.hostname.endsWith("youtube.com")) return route.abort();
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: extrasFixture("yt-autoplay.html") });
  });
  await page.goto(url);
  // The engine ran: the free Shorts class is the proof of life (Autoplay itself adds no class).
  await expect(page.locator("html")).toHaveClass(/still-feature-\d+-youtube-shorts/);
}
/** Makes the player video really play (a muted canvas stream) and counts its pause events. */
async function startPlaying(page: Page) {
  await page.evaluate(async () => {
    const video = document.getElementById("player-video") as HTMLVideoElement;
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const paint = () => { canvas.getContext("2d")!.fillRect(0, 0, 16, 16); };
    paint();
    setInterval(paint, 50);
    video.muted = true;
    video.srcObject = canvas.captureStream(10);
    (window as unknown as { pauses: number }).pauses = 0;
    video.addEventListener("pause", () => { (window as unknown as { pauses: number }).pauses++; });
    await video.play();
  });
  await expect.poll(() => page.evaluate(() => (document.getElementById("player-video") as HTMLVideoElement).paused)).toBe(false);
}
const probe = (page: Page) => page.evaluate(() => (window as unknown as { __autoplayProbe: Probe }).__autoplayProbe);
const fireEnded = (page: Page) => page.evaluate(() => (window as unknown as { fireEnded(): void }).fireEnded());
const replay = (page: Page) => page.evaluate(() => document.getElementById("player-video")!.dispatchEvent(new Event("play")));
const setNext = (page: Page, href: string) =>
  page.evaluate((href) => { (document.getElementById("keep-autonav-next") as HTMLAnchorElement).href = href; }, href);
async function playerState(page: Page) {
  return page.evaluate(() => ({
    paused: (document.getElementById("player-video") as HTMLVideoElement).paused,
    pauses: (window as unknown as { pauses: number }).pauses,
    toggle: document.getElementById("keep-autoplay-toggle")!.getAttribute("aria-checked"),
  }));
}

test("paid on: the up-next countdown is cancelled once, with the autoplay toggle, the playing video and the page untouched", async ({ page, authority }) => {
  await commit(authority, "sites.youtube.autoplay", true);
  await open(page, WATCH);
  await startPlaying(page);
  const before = await probe(page);
  await fireEnded(page);
  await expect.poll(async () => (await probe(page)).cancelClicks).toBe(1);
  await page.waitForTimeout(300);
  const after = await probe(page);
  expect(after.cancelClicks, "exactly once for this countdown").toBe(1);
  expect(after.toggleClicks, "YouTube's own autoplay toggle is never clicked").toBe(0);
  expect(after.ended).toBe(1);
  // Same document, no reload, no bounce, same address.
  expect(after.token).toBe(before.token);
  expect(after.loads).toBe(1);
  expect(page.url()).toBe(WATCH);
  // The current video is never paused (nor started) by Still; the native toggle state is unchanged.
  expect(await playerState(page)).toEqual({ paused: false, pauses: 0, toggle: "true" });
  await expect(page.locator("#keep-autonav-overlay")).toBeVisible();
  await expect(page.locator("#keep-playlist-panel")).toBeVisible();
});

test("paid on: a deliberately started playlist continues; a recommendation after it ends is cancelled", async ({ page, authority }) => {
  await commit(authority, "sites.youtube.autoplay", true);
  await open(page, PLAYLIST); // a full page load is the person's own choice
  await startPlaying(page);
  await setNext(page, "/watch?v=inv300004&list=PLinvented03&index=3");
  await fireEnded(page);
  await page.waitForTimeout(400);
  expect((await probe(page)).cancelClicks, "the next playlist item is left to play").toBe(0);
  // The last item: YouTube offers a recommendation outside the playlist.
  await replay(page);
  await setNext(page, "/watch?v=inv300099");
  await fireEnded(page);
  await expect.poll(async () => (await probe(page)).cancelClicks).toBe(1);
  expect((await probe(page)).toggleClicks).toBe(0);
  expect(page.url()).toBe(PLAYLIST);
  expect((await playerState(page)).pauses).toBe(0);
});

test("paid on: Off stops intervening without starting anything, and On again works", async ({ page, authority }) => {
  await commit(authority, "sites.youtube.autoplay", true);
  await open(page, WATCH);
  await commit(authority, "sites.youtube.autoplay", false);
  await page.waitForTimeout(300);
  await fireEnded(page);
  await page.waitForTimeout(400);
  expect((await probe(page)).cancelClicks).toBe(0);
  // Nothing was started on Off: the (never started) video is still paused, with no reload.
  const off = await playerState(page);
  expect(off.paused).toBe(true);
  expect((await probe(page)).loads).toBe(1);
  await commit(authority, "sites.youtube.autoplay", true);
  await page.waitForTimeout(300);
  await replay(page);
  await fireEnded(page);
  await expect.poll(async () => (await probe(page)).cancelClicks).toBe(1);
  expect(page.url()).toBe(WATCH);
});

test("paid on: the free Shorts path is unchanged with Autoplay prevention On", async ({ page, authority }) => {
  await commit(authority, "sites.youtube.autoplay", true);
  await page.context().route(/^https?:/, (route) => {
    const target = new URL(route.request().url());
    if (!target.hostname.endsWith("youtube.com")) return route.abort();
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: extrasFixture("yt-autoplay.html") });
  });
  await page.goto("https://www.youtube.com/shorts/inv300050", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/watch\?v=inv300050$/);
});
