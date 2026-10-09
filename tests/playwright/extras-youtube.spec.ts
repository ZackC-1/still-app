import type { Page, Worker } from "@playwright/test";
import { paidOnExtrasTest as test } from "./_format2-extension";
import { extrasFixture } from "../../packages/core/src/rules/__tests__/extras-fixtures.js";

// YouTube's four Still Pro hide controls and the top-level live chat route, in a DISPOSABLE copy
// of the built Chromium extension whose content script runs the real packaged format-2 rules with
// paid ON (Chromium host capabilities, purchased access) through the test-only seam. The shipping
// artifact stays byte-identical and paid OFF; extras-dormancy.spec.ts proves it does nothing.
//
// Lanes: this copy replaces both the worker (which commits its own schema-2 settings) and the
// content script, so it does not depend on the build's sync configuration and runs in both CI
// lanes, like format2-shipping.spec.ts. The fixtures are synthetic and their selector families
// are unverified candidates (packages/core/src/rules/youtube-extras.ts).

const expect = test.expect;
type Feature = "youtube.related" | "youtube.endscreen" | "youtube.comments" | "youtube.livechat";
const FEATURES: readonly Feature[] = ["youtube.related", "youtube.endscreen", "youtube.comments", "youtube.livechat"];
const HOME = "<!doctype html><title>Home</title><main id='home'>Invented home</main>";

async function commit(authority: Worker, path: string, value: boolean) {
  await authority.evaluate(async ({ path, value }) => {
    await (globalThis as unknown as {
      fixtureAuthority: { commitIntent: (intent: unknown) => Promise<unknown> };
    }).fixtureAuthority.commitIntent({ path, value, updatedAt: Date.now() });
  }, { path, value });
}
async function only(authority: Worker, on: readonly Feature[]) {
  for (const feature of FEATURES) await commit(authority, `sites.${feature}`, on.includes(feature));
}
/** Serve `body` for YouTube pages, Home for "/", and abort anything else. */
async function serve(page: Page, body: string) {
  await page.context().route(/^https?:/, (route) => {
    const url = new URL(route.request().url());
    if (!url.hostname.endsWith("youtube.com")) return route.abort();
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: url.pathname === "/" ? HOME : body });
  });
}
const featureClass = (feature: Feature) => new RegExp(`still-feature-\\d+-${feature.replace(".", "-")}`);
const ids = (page: Page, prefix: string) =>
  page.locator(`[id^="${prefix}"]`).evaluateAll((nodes) => nodes.map((node) => node.id));

const CASES = [
  { feature: "youtube.related", file: "yt-watch-related.html", url: "https://www.youtube.com/watch?v=inv000000",
    targets: ["target-related-below", "target-related-side"] },
  { feature: "youtube.related", file: "yt-m-watch-related.html", url: "https://m.youtube.com/watch?v=inv100000",
    targets: ["target-m-related"] },
  { feature: "youtube.endscreen", file: "yt-watch-end.html", url: "https://www.youtube.com/watch?v=inv200000",
    targets: ["target-end-card-video", "target-end-card-channel", "target-endscreen-grid"] },
  { feature: "youtube.comments", file: "yt-watch-comments-chat.html", url: "https://www.youtube.com/watch?v=inv400000",
    targets: ["target-comments", "target-comments-panel"] },
  { feature: "youtube.comments", file: "yt-m-watch-comments.html", url: "https://m.youtube.com/watch?v=inv400002",
    targets: ["target-m-comments-teaser", "target-m-comments-preview", "target-m-comments-panel", "target-m-comments-header", "target-m-comments-scrim"] },
  { feature: "youtube.livechat", file: "yt-watch-comments-chat.html", url: "https://www.youtube.com/watch?v=inv400001",
    targets: ["target-chat-frame", "target-chat-entry", "target-chat-replay"] },
] as const;

for (const c of CASES)
  test(`paid on: ${c.feature} on ${c.file} hides its targets, keeps everything else, and Off restores without navigating`, async ({ page, authority }) => {
    await only(authority, [c.feature]);
    await serve(page, extrasFixture(c.file));
    await page.goto(c.url);
    await expect(page.locator("html")).toHaveClass(featureClass(c.feature));
    const token = await page.evaluate(() => ((window as unknown as { token: number }).token = Math.random()));
    for (const id of c.targets) {
      await expect(page.locator(`#${id}`), id).toHaveCount(1);
      await expect(page.locator(`#${id}`), id).toBeHidden();
    }
    const keep = await ids(page, "keep-");
    expect(keep.length).toBeGreaterThan(0);
    for (const id of keep) await expect(page.locator(`#${id}`), id).toBeVisible();
    for (const id of (await ids(page, "target-")).filter((id) => !(c.targets as readonly string[]).includes(id)))
      await expect(page.locator(`#${id}`), `${id} belongs to another control`).toBeVisible();
    expect(await page.locator("[id^='still-']").count(), "no Still placeholder or notice").toBe(0);

    await commit(authority, `sites.${c.feature}`, false);
    for (const id of c.targets) await expect(page.locator(`#${id}`), `${id} after Off`).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(featureClass(c.feature));
    await commit(authority, `sites.${c.feature}`, true);
    for (const id of c.targets) await expect(page.locator(`#${id}`), `${id} on again`).toBeHidden();
    // Same document throughout: no reload and no navigation.
    expect(page.url()).toBe(c.url);
    expect(await page.evaluate(() => (window as unknown as { token: number }).token)).toBe(token);
  });

test("paid on: Comments and Live chat are independent in all four combinations", async ({ page, authority }) => {
  await serve(page, extrasFixture("yt-watch-comments-chat.html"));
  const comments = ["#target-comments", "#target-comments-panel"];
  const chat = ["#target-chat-frame", "#target-chat-entry", "#target-chat-replay"];
  for (const [commentsOn, chatOn] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    await only(authority, [...(commentsOn ? ["youtube.comments" as const] : []), ...(chatOn ? ["youtube.livechat" as const] : [])]);
    await page.goto("https://www.youtube.com/watch?v=inv400000");
    await expect(page.locator("html")).toHaveClass(/still-feature-\d+-youtube-shorts/);
    for (const id of comments) await expect(page.locator(id), `${id} comments=${commentsOn} chat=${chatOn}`).toBeVisible({ visible: !commentsOn });
    for (const id of chat) await expect(page.locator(id), `${id} comments=${commentsOn} chat=${chatOn}`).toBeVisible({ visible: !chatOn });
    for (const id of await ids(page, "keep-")) await expect(page.locator(`#${id}`), id).toBeVisible();
  }
});

test("paid on: mobile comments preserve shared controls, recycle panels and restore when Still turns Off", async ({ page, authority }) => {
  await only(authority, ["youtube.comments"]);
  await serve(page, extrasFixture("yt-m-watch-comments.html"));
  await page.goto("https://m.youtube.com/watch?v=inv400002");
  await expect(page.locator("#comments-panel-shell")).toBeHidden();
  await expect(page.locator("#keep-carousel")).toBeVisible();
  await expect(page.locator("#keep-shared-carousel-action")).toBeVisible();
  await expect(page.locator("#keep-description-panel")).toBeVisible();
  await page.locator("#target-m-comments-panel").evaluate(node => { node.className = "engagement-panel-description-section"; });
  await expect(page.locator("#comments-panel-shell")).toBeVisible();
  await page.locator("#target-m-comments-panel").evaluate(node => { node.className = "engagement-panel-comments-section"; });
  await expect(page.locator("#comments-panel-shell")).toBeHidden();
  await page.locator("#comments-panel-shell").evaluate(node => {
    node.insertAdjacentHTML("beforeend", '<ytm-engagement-panel-section-list-renderer id="ambiguous-description">Invented description</ytm-engagement-panel-section-list-renderer>');
  });
  await expect(page.locator("#comments-panel-shell")).toBeVisible();
  await expect(page.locator("#ambiguous-description")).toBeVisible();
  await commit(authority, "globalOn", false);
  await expect(page.locator("#target-m-comments-teaser")).toBeVisible();
  await expect(page.locator("#target-m-comments-header")).toBeVisible();
});

test("paid on: Related with End-of-video keeps the playlist panel, player, chat and comments, and hides late-rendered suggestions", async ({ page, authority }) => {
  await only(authority, ["youtube.related", "youtube.endscreen"]);
  await serve(page, extrasFixture("yt-watch-related.html"));
  await page.goto("https://www.youtube.com/watch?v=inv000000");
  await expect(page.locator("html")).toHaveClass(featureClass("youtube.related"));
  await expect(page.locator("#target-related-side")).toBeHidden();
  for (const id of ["#keep-playlist-panel", "#keep-chat-frame", "#keep-chat-iframe", "#keep-player", "#keep-comments", "#keep-title", "#keep-description"])
    await expect(page.locator(id), id).toBeVisible();
  // Late-inserted (SPA-rendered) renderers hide without a reload; a recycled section follows its structure.
  await page.evaluate(() => {
    const late = document.createElement("ytd-watch-next-secondary-results-renderer");
    late.id = "late-related";
    late.textContent = "Invented late suggestion";
    document.querySelector("#secondary")!.append(late);
  });
  await expect(page.locator("#late-related")).toBeHidden();
});

test("paid on: hidden related continuation never keeps loading (no request loop)", async ({ page, authority }) => {
  // Modelled on YouTube's watch-next continuation: when the in-list continuation item becomes
  // visible it "fetches" (counted), then is replaced by new items plus a fresh continuation item.
  // While the list is short the fresh item is visible at once, so it keeps loading (capped here).
  const continuation = `<!doctype html><html><body><div id="secondary">
    <ytd-watch-next-secondary-results-renderer id="target-related">
      <div id="items"><ytd-compact-video-renderer>Invented suggestion</ytd-compact-video-renderer></div>
    </ytd-watch-next-secondary-results-renderer>
    <ytd-playlist-panel-renderer id="keep-playlist">Invented playlist</ytd-playlist-panel-renderer></div>
    <script>window.loads = 0;
      const items = document.querySelector("#items");
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || window.loads >= 8) continue;
          window.loads++;
          observer.unobserve(entry.target);
          // A 300 ms "network" round trip, then the new items and a fresh continuation item. So
          // at most one load can start per round trip, which bounds the pre-hydration window.
          setTimeout(() => {
            entry.target.remove();
            const item = document.createElement("ytd-compact-video-renderer");
            item.textContent = "Invented continuation " + window.loads;
            items.append(item);
            addSentinel();
          }, 300);
        }
      });
      function addSentinel() {
        const sentinel = document.createElement("ytd-continuation-item-renderer");
        sentinel.textContent = "Loading"; items.append(sentinel); observer.observe(sentinel);
      }
      addSentinel();</script></body></html>`;
  await serve(page, continuation);
  const loads = () => page.evaluate(() => (window as unknown as { loads: number }).loads);
  // Off: the model really loops (so the On result is not vacuous).
  await only(authority, []);
  await page.goto("https://www.youtube.com/watch?v=inv000010");
  await expect.poll(loads, { timeout: 15_000 }).toBe(8);
  // On: once hidden, the continuation stops. A request may start in the brief window before
  // settings hydrate (the engine adds nothing before it knows the settings), but none after.
  await only(authority, ["youtube.related"]);
  await page.goto("https://www.youtube.com/watch?v=inv000011");
  await expect(page.locator("#target-related")).toBeHidden();
  await page.waitForTimeout(400); // let a request that started before hydration finish
  const settled = await loads();
  // One load in the pre-hydration window, two at most if hydration outlasts a round trip; the
  // visible loop reaches the cap of 8.
  expect(settled, "only the pre-hydration window's load(s), not the loop").toBeLessThanOrEqual(2);
  await page.waitForTimeout(1_200);
  expect(await loads(), "no further continuation while hidden").toBe(settled);
  await expect(page.locator("#keep-playlist")).toBeVisible();
});

for (const path of ["/live_chat?v=inv400001", "/live_chat_replay?v=inv400001&continuation=invented"])
  test(`paid on: a top-level ${path.split("?")[0]} page goes silently to Home, and stays when Live chat is Off`, async ({ page, authority }) => {
    await serve(page, extrasFixture("yt-live-chat-route.html"));
    await only(authority, ["youtube.related", "youtube.endscreen", "youtube.comments"]);
    await page.goto(`https://www.youtube.com${path}`);
    await expect(page.locator("#keep-live-chat-app")).toBeVisible();
    await page.waitForTimeout(300);
    expect(page.url()).toBe(`https://www.youtube.com${path}`);

    await only(authority, ["youtube.livechat"]);
    // The content script replaces the page during load, so wait only for the commit.
    await page.goto(`https://www.youtube.com${path}`, { waitUntil: "commit" }).catch(() => {});
    await expect(page).toHaveURL("https://www.youtube.com/");
    await expect(page.locator("#home")).toBeVisible();
    expect(await page.locator("[id^='still-']").count(), "silent: no notice or placeholder").toBe(0);
  });

test("paid on: a watch page embedding the chat iframe is never redirected, and neither is the iframe", async ({ page, authority }) => {
  await only(authority, ["youtube.livechat"]);
  const watch = `<!doctype html><html><body><div id="keep-player"><video></video></div>
    <iframe id="chat-iframe" src="/live_chat?v=inv400001" title="Chat"></iframe></body></html>`;
  await page.context().route(/^https?:/, (route) => {
    const url = new URL(route.request().url());
    if (!url.hostname.endsWith("youtube.com")) return route.abort();
    const body = url.pathname === "/" ? HOME : url.pathname === "/live_chat" ? extrasFixture("yt-live-chat-route.html") : watch;
    return route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  const url = "https://www.youtube.com/watch?v=inv400001";
  await page.goto(url);
  await expect(page.locator("html")).toHaveClass(featureClass("youtube.livechat"));
  const frame = page.frameLocator("#chat-iframe");
  await expect(frame.locator("#keep-live-chat-app")).toBeVisible();
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
  expect(page.frames().find((f) => f !== page.mainFrame())!.url()).toBe("https://www.youtube.com/live_chat?v=inv400001");
});
