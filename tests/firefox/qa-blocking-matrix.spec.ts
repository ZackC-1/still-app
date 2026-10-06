/* eslint-disable no-empty-pattern -- Playwright requires a destructured first argument, and these tests use none of its fixtures */
import { test, expect } from "@playwright/test";
import { FirefoxEvidence } from "./_qa-evidence.js";
import { waitWorking } from "./_qa-assert.js";
import { startFresh, firstRunTab, savedSettings } from "./_qa-session.js";
import { fixture, type StillFirefox, type Tab } from "./_session.js";
import type { Format2Service } from "./_assertions.js";

// J2.FD: the same recorded pages the Chromium lane checks (tests/playwright/fixtures.spec.ts), in
// real Firefox over BiDi. Both paid flags are off, so every supported surface is blocked for
// everyone. Firefox hides what Still blocks and leaves it in the page, so "gone" here means "not
// drawn" (absent or hidden), and "kept" means drawn.
//
// Each service is proved in two passes over the same pages. Pass one: blocked (and Still has put its
// marker on the page, so a pass is not just a page that never loaded). Pass two: after the real
// switch in the popup is turned Off, every "gone" part is drawn again. Pass two is the negative
// control: it shows that each "gone" check can fail, and that Off restores that service's pages.

type Row = {
  name: string;
  url: string;
  html: () => string;
  gone: string[];
  kept: string[];
};

const ytmWatch = () =>
  fixture("youtube-watch.html")
    .replace("<body>", "<body><ytm-app>")
    .replace("</body>", "</ytm-app></body>");

const ROWS: Record<Exclude<Format2Service, never>, Row[]> = {
  youtube: [
    {
      name: "home and subscriptions",
      url: "https://www.youtube.com/feed/subscriptions",
      html: () => fixture("youtube.html"),
      gone: [
        "#shelf",
        "#rich-shorts-section",
        "#subs-shorts-shelf",
        "#endpoint",
        "#shorts-mini-guide",
        "#shorts-chip",
      ],
      kept: [
        "#keep-video",
        "#keep-subs-video",
        "#keep-guide-home",
        "#keep-chip-all",
        "#keep-mixed-section",
        "#keep-mixed-video",
        "#keep-reels-titled-video",
      ],
    },
    {
      name: "search",
      url: "https://www.youtube.com/results?search_query=shorts",
      html: () => fixture("youtube-search.html"),
      gone: ["#shorts-shelf", "#shorts-result"],
      kept: [
        "#keep-first-result",
        "#keep-result-linking-to-short",
        "#keep-reels-titled-result",
        "#keep-normal-shelf",
      ],
    },
    {
      name: "channel",
      url: "https://www.youtube.com/@YouTube",
      html: () => fixture("youtube-channel.html"),
      gone: ["#shorts-tab", "#shorts-tab-legacy", "#channel-shorts-shelf"],
      kept: [
        "#keep-videos-tab",
        "#keep-videos-tab-legacy",
        "#keep-channel-video",
        "#keep-community-post",
      ],
    },
    {
      name: "watch",
      url: "https://www.youtube.com/watch?v=long123",
      html: () => fixture("youtube-watch.html"),
      gone: ["#watch-shorts-shelf", "#watch-mobile-short"],
      kept: [
        "#keep-player",
        "#keep-title",
        "#keep-desktop-next",
        "#keep-mobile-next",
      ],
    },
    {
      name: "m.youtube.com home",
      url: "https://m.youtube.com/",
      html: () => fixture("youtube-mobile.html"),
      gone: [
        "#shorts-tab",
        "#shorts-tab-by-href",
        "#mobile-shorts-section",
        "#mobile-reel-shelf-section",
        "#mobile-loose-short",
        "#mobile-shorts-card",
      ],
      kept: [
        "#home-tab",
        "#keep-mobile-video",
        "#keep-mobile-mixed-section",
        "#keep-mobile-mixed-video",
        "#keep-mobile-video-linking-to-short",
        "#keep-mobile-reels-titled-video",
      ],
    },
    {
      name: "m.youtube.com search",
      url: "https://m.youtube.com/results?search_query=shorts",
      html: () => fixture("youtube-mobile-search.html"),
      gone: ["#mobile-shorts-shelf", "#mobile-shorts-result"],
      kept: [
        "#keep-mobile-first-result",
        "#keep-mobile-result-linking-to-short",
        "#keep-mobile-normal-shelf",
      ],
    },
    {
      name: "m.youtube.com channel",
      url: "https://m.youtube.com/@YouTube",
      html: () => fixture("youtube-mobile-channel.html"),
      gone: ["#mobile-shorts-tab", "#mobile-channel-shorts-shelf"],
      kept: [
        "#keep-mobile-videos-tab",
        "#keep-mobile-channel-shelf",
        "#keep-mobile-channel-video",
      ],
    },
    {
      name: "m.youtube.com watch",
      url: "https://m.youtube.com/watch?v=long123",
      html: ytmWatch,
      gone: ["#watch-mobile-short"],
      kept: ["#keep-mobile-rail", "#keep-mobile-next"],
    },
  ],
  instagram: [
    {
      name: "profile",
      url: "https://www.instagram.com/someuser/",
      html: () => fixture("instagram.html"),
      gone: ["#reel-post", "#reels-link", "#profile-reel-tile"],
      kept: [
        "#keep-post",
        "#keep-profile-post-tile",
        "#keep-profile-lookalike",
      ],
    },
    {
      name: "home feed",
      url: "https://www.instagram.com/",
      html: () => fixture("instagram-home.html"),
      gone: ["#reel-post", "#reel-post-with-hashtags", "#nav-reels"],
      kept: [
        "#keep-photo-post",
        "#keep-sponsored-post",
        "#keep-nav-home",
        "#keep-video-post-with-audio",
        "#keep-post-linking-to-reels",
      ],
    },
  ],
  facebook: [
    {
      name: "home",
      url: "https://www.facebook.com/",
      html: () => fixture("facebook.html"),
      gone: ["#reel-article", "#reels-shortcut"],
      kept: ["#keep-article", "#keep-lookalike-article"],
    },
  ],
};

let firefox: StillFirefox;
let current: () => string = () => "";
test.beforeAll(async () => {
  firefox = await startFresh(() => current());
  await (await firstRunTab(firefox)).close();
});
test.afterAll(async () => {
  await firefox?.stop();
});

async function open(row: Row): Promise<Tab> {
  current = row.html;
  firefox.serve((url) =>
    url.pathname.startsWith("/watch") && !row.url.includes("/watch?")
      ? "<!doctype html><title>watch</title>watch"
      : current(),
  );
  return await firefox.openTab(row.url);
}

async function setSwitch(label: string, on: boolean): Promise<void> {
  const popup = await firefox.openExtensionPage("popup.html");
  const selector = `button[role=switch][aria-label=${JSON.stringify(label)}]`;
  await popup.waitFor(
    `${label} switch`,
    () => popup.count(selector),
    (n) => n === 1,
  );
  const read = () =>
    popup.evaluate<string>(
      `document.querySelector(${JSON.stringify(selector)}).getAttribute("aria-checked")`,
    );
  if ((await read()) !== String(on))
    await popup.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
  await popup.waitFor(`${label} reads ${on}`, read, (v) => v === String(on));
  await popup.close();
}

const SWITCH: Record<string, string> = {
  youtube: "Still on YouTube",
  instagram: "Still on Instagram",
  facebook: "Still on Facebook",
};

for (const service of ["youtube", "instagram", "facebook"] as const) {
  test(`J2.FD ${service}: every fixture page blocks, then Off restores the same pages`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const ev = new FirefoxEvidence("J2.FD", testInfo, firefox);
    for (const row of ROWS[service]) {
      const tab = await open(row);
      await waitWorking(tab, service);
      for (const selector of row.gone)
        await tab.waitForVisible(selector, false).catch((e) => {
          throw new Error(
            `${service} ${row.name}: ${selector} should be gone. ${e}`,
          );
        });
      for (const selector of row.kept)
        expect(
          await tab.isVisible(selector),
          `${service} ${row.name}: ${selector} stays`,
        ).toBe(true);
      await tab.close();
    }
    // Negative control and Off: with the service switched off the same pages show everything.
    await setSwitch(SWITCH[service]!, false);
    try {
      expect((await savedSettings(firefox)).settings.services[service]).toBe(
        false,
      );
      for (const row of ROWS[service]) {
        const tab = await open(row);
        await tab.holdsFor(
          `${service} ${row.name} left alone`,
          async () => {
            for (const selector of [...row.gone, ...row.kept])
              if (!(await tab.isVisible(selector))) return false;
            return true;
          },
          800,
        );
        await tab.close();
      }
      ev.log(
        "pages-checked",
        ROWS[service].map((r) => r.name),
      );
    } finally {
      await setSwitch(SWITCH[service]!, true);
    }
  });
}

test("J2.FD a Shorts address ends up on the watch page, on both hosts, and Off leaves it alone", async () => {
  const cases = [
    {
      url: "https://www.youtube.com/shorts/abc123",
      html: () => fixture("youtube.html"),
      end: /\/watch\?v=abc123/,
    },
    {
      url: "https://m.youtube.com/shorts/def456",
      html: () => fixture("youtube-mobile.html"),
      end: /\/watch\?v=def456/,
    },
  ];
  for (const c of cases) {
    current = c.html;
    firefox.serve((url) =>
      url.pathname.startsWith("/watch")
        ? "<!doctype html><title>watch</title>watch"
        : current(),
    );
    const tab = await firefox.openTab(c.url);
    expect(
      await tab.waitFor(
        "the redirect",
        () => tab.url(),
        (u) => u.includes("/watch"),
      ),
    ).toMatch(c.end);
    await tab.close();
  }
  await setSwitch("Still on YouTube", false);
  try {
    for (const c of cases) {
      current = c.html;
      const tab = await firefox.openTab(c.url);
      await tab.holdsFor(
        "the Shorts address is left alone",
        async () => (await tab.url()) === c.url,
        1_500,
      );
      await tab.close();
    }
  } finally {
    await setSwitch("Still on YouTube", true);
  }
});

test("J2.FD a Shorts address reached by in-page navigation still ends up on the watch page", async () => {
  current = () => fixture("youtube.html");
  firefox.serve((url) =>
    url.pathname.startsWith("/watch")
      ? "<!doctype html><title>watch</title>watch"
      : current(),
  );
  const tab = await firefox.openTab(
    "https://www.youtube.com/feed/subscriptions",
  );
  await waitWorking(tab, "youtube");
  await tab.evaluate(
    `(() => { window.__stillMarker = "same-document"; history.pushState({}, "", "/shorts/spa123"); return true; })()`,
  );
  const url = await tab.waitFor(
    "the in-page redirect",
    () => tab.url(),
    (u) => u.includes("/watch"),
  );
  expect(url).toMatch(/\/watch\?v=spa123/);
  // The redirect is a real navigation, not an in-place change: the page's own marker is gone.
  expect(
    await tab.evaluate<string | null>("window.__stillMarker ?? null"),
  ).toBeNull();
  await tab.close();
});

test.fixme("J2.FD the Navigation API path and its poll fallback on Firefox ESR", async () => {
  // Needs a Firefox ESR binary (FIREFOX_BIN) that lacks the Navigation API. The release build under
  // test has it, so the fallback cannot be forced here without a product hook.
});
