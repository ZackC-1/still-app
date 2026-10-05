/* eslint-disable no-empty-pattern -- Playwright requires a destructured first argument, and these tests use none of its fixtures */
import { test, expect } from "@playwright/test";
import { FirefoxEvidence } from "./_qa-evidence.js";
import {
  NEEDS_BACKEND,
  firstRunTab,
  readStore,
  recordRequests,
  startFresh,
  writeStore,
} from "./_qa-session.js";
import { offersPurchase } from "../playwright/_extras-helpers.js";
import { fixture, type StillFirefox, type Tab } from "./_session.js";

// J12.FD (paid-dormant behaviour) and J13.FD (rating dormancy) on real Firefox. Both paid flags are
// off, so no screen Still shows may offer a purchase (owner decision 6), locked Pro rows offer
// nothing when tapped (decision 24), no rating card appears, and pages make no checkout or sales
// request. BiDi cannot see the background's own requests; the lane's unconfigured-build check shows
// the background has no server address to call.

const SALES_REQUEST =
  /revenuecat|rc-?billing|stripe|checkout|paddle|purchase|product-policy|entitlement|storekit/i;
const RATING_COPY =
  /A rating helps other people find Still\.|rate still|leave a review|how is still working/i;

let firefox: StillFirefox;
test.beforeEach(async () => {
  firefox = await startFresh((url) =>
    url.hostname.endsWith("tiktok.com") ? fixture("tiktok.html") : null,
  );
});
test.afterEach(async () => {
  await firefox?.stop();
});

const visibleText = (page: Tab) =>
  page.evaluate<string>("document.body.innerText.replace(/\\s+/g, ' ')");
const allText = (page: Tab) =>
  page.evaluate<string>(
    "(document.body.textContent ?? '').replace(/\\s+/g, ' ')",
  );

async function expectNoOffer(page: Tab, where: string): Promise<void> {
  await new Promise((done) => setTimeout(done, 400)); // late-rendering cards
  expect(
    offersPurchase(await visibleText(page)),
    `${where}: visible text offers a purchase`,
  ).toBe(false);
  expect(
    offersPurchase(await allText(page)),
    `${where}: page text offers a purchase`,
  ).toBe(false);
  const controls = await page.evaluate<string[]>(
    `[...document.querySelectorAll("button, a, [role='button'], [role='link']")].map((n) => ((n.textContent ?? "") + " " + (n.getAttribute("aria-label") ?? "") + " " + (n.getAttribute("href") ?? "")).replace(/\\s+/g, " ").trim())`,
  );
  for (const label of controls)
    expect(offersPurchase(label), `${where}: control "${label}"`).toBe(false);
  const hrefs = await page.evaluate<string[]>(
    `[...document.querySelectorAll("a[href]")].map((n) => n.href)`,
  );
  for (const href of hrefs)
    expect(href, `${where}: link ${href}`).not.toMatch(SALES_REQUEST);
}

async function expandEvery(page: Tab, where: string): Promise<void> {
  for (const service of ["YouTube", "Instagram", "Facebook"]) {
    const open = () =>
      page.evaluate<string | null>(
        `[...document.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(`${service} Blocker`)}))?.getAttribute("aria-expanded") ?? null`,
      );
    await page.waitFor(`${service} header`, open, (v) => v !== null);
    if ((await open()) !== "true")
      await page.evaluate(
        `[...document.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(`${service} Blocker`)})).click()`,
      );
    await page.waitFor(`${service} open`, open, (v) => v === "true");
    await expectNoOffer(page, `${where} with ${service} open`);
  }
}

test("J12.FD no popup, options, first-run or TikTok page state offers a purchase", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const ev = new FirefoxEvidence("J12.FD", testInfo, firefox);
  const requests = recordRequests(firefox);
  const first = await firstRunTab(firefox);
  await expectNoOffer(first, "first-run");
  await ev.shot("first-run", "first-run");
  await first.close();

  for (const name of ["popup.html", "options.html"] as const) {
    const page = await firefox.openExtensionPage(name);
    await page.waitFor(
      "the switches",
      () => page.count("button[role=switch]"),
      (n) => n >= 5,
    );
    await expectNoOffer(page, `${name} (collapsed)`);
    await expandEvery(page, name);
    await ev.shot(name, `${name.replace(".html", "")}-all-open`, {
      width: name === "popup.html" ? 380 : 560,
      height: 1100,
    });
    await page.close();
  }

  // The TikTok page and its confirmation, reached the way a person reaches it.
  const tiktok = await firefox.openTab("https://www.tiktok.com/foryou");
  await tiktok.waitFor(
    "the blocked page",
    () => tiktok.url().catch(() => ""),
    (u) => /tiktok-blocked\.html/.test(u),
  );
  await tiktok.waitFor(
    "its heading",
    () =>
      tiktok
        .evaluate<string>("document.querySelector('h1')?.textContent ?? ''")
        .catch(() => ""),
    (t) => t === "TikTok stays closed.",
  );
  await expectNoOffer(tiktok, "tiktok blocked page");
  await tiktok.waitFor(
    "the open button",
    () =>
      tiktok
        .evaluate<string | null>(
          `(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Open TikTok this time"); return b ? b.getAttribute("aria-disabled") : "absent"; })()`,
        )
        .catch(() => "absent"),
    (d) => d === null,
  );
  await tiktok.evaluate(
    `[...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Open TikTok this time").click()`,
  );
  await tiktok.waitFor(
    "the confirmation",
    () => tiktok.count('[role="dialog"]'),
    (n) => n === 1,
  );
  await expectNoOffer(tiktok, "tiktok confirmation");
  await tiktok.close();

  ev.log("page-requests", requests.entries);
  expect(
    requests.entries.filter((e) => SALES_REQUEST.test(`${e.origin}${e.path}`)),
    "no checkout, RevenueCat or sales request",
  ).toEqual([]);
});

test("J12.FD the matcher can fail: it flags a page that does offer a purchase", async () => {
  // Negative control for the checks above: the same function must catch a Buy button and a price.
  const page = await firefox.openExtensionPage("options.html");
  await page.waitFor(
    "the switches",
    () => page.count("button[role=switch]"),
    (n) => n >= 5,
  );
  await page.evaluate(
    `(() => { const b = document.createElement("button"); b.textContent = "Buy Still Pro for $1.99"; document.body.append(b); return true; })()`,
  );
  expect(offersPurchase(await visibleText(page))).toBe(true);
  await page.close();
});

test("J12.FD locked Pro rows show the lock and Still Pro, and offer nothing when tapped", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J12.FD", testInfo, firefox);
  const requests = recordRequests(firefox);
  await (await firstRunTab(firefox)).close();
  const before = JSON.stringify(await readStore(firefox, "still:settings"));
  const page = await firefox.openExtensionPage("options.html");
  await page.waitFor(
    "the switches",
    () => page.count("button[role=switch]"),
    (n) => n >= 5,
  );
  const tabsBefore = (await firefox.bidi.send("browsingContext.getTree", {}))
    .contexts.length;
  const requestsBefore = requests.entries.length;
  const rows = {
    YouTube: [
      "Related videos",
      "End-of-video suggestions",
      "Autoplay prevention",
      "Comments",
      "Live chat",
    ],
    Instagram: [
      "Explore recommendations",
      "Stories and Highlights",
      "Suggested accounts",
      "Threads links",
    ],
    Facebook: ["Facebook Stories", "Videos and Watch", "Desktop sidebar ads"],
  };
  let tapped = 0;
  for (const [service, names] of Object.entries(rows)) {
    const header = await page.evaluate<boolean>(
      `(() => { const b = [...document.querySelectorAll("button[aria-expanded]")].find((x) => x.textContent.trim().startsWith(${JSON.stringify(`${service} Blocker`)})); if (b.getAttribute("aria-expanded") !== "true") b.click(); return true; })()`,
    );
    expect(header).toBe(true);
    for (const name of names) {
      const info = await page.waitFor(
        `${name} row`,
        () =>
          page.evaluate<{
            rows: number;
            text: string;
            switches: number;
            locks: number;
            disabled: string | null;
          }>(`(() => {
        const rows = [...document.querySelectorAll(".option-row")].filter((r) => r.querySelector(".label")?.textContent.trim() === ${JSON.stringify(name)});
        const r = rows[0];
        return { rows: rows.length, text: r?.textContent ?? "", switches: r ? r.querySelectorAll('[role="switch"], input[type="checkbox"]').length : -1, locks: r ? r.querySelectorAll("button.lock-pro").length : -1, disabled: r?.querySelector("button.lock-pro")?.getAttribute("aria-disabled") ?? null };
      })()`),
        (i) => i.rows === 1,
      );
      expect(info.text, `${name} shows the lock and Still Pro`).toContain(
        "Still Pro",
      );
      expect(info.switches, `${name} has no switch`).toBe(0);
      expect(info.locks, `${name} has one lock chip`).toBe(1);
      expect(info.disabled, `${name} lock chip is inert`).toBe("true");
      await page.evaluate(
        `(() => { const r = [...document.querySelectorAll(".option-row")].find((x) => x.querySelector(".label")?.textContent.trim() === ${JSON.stringify(name)}); r.click(); r.querySelector("button.lock-pro").click(); return true; })()`,
      );
      tapped += 1;
    }
  }
  expect(tapped, "all 12 locked rows were tapped").toBe(12);
  await new Promise((done) => setTimeout(done, 800));
  expect(
    (await firefox.bidi.send("browsingContext.getTree", {})).contexts.length,
    "tapping opened no page",
  ).toBe(tabsBefore);
  expect(
    JSON.stringify(await readStore(firefox, "still:settings")),
    "tapping changed no saved choice",
  ).toBe(before);
  expect(requests.entries.length, "tapping made no request").toBe(
    requestsBefore,
  );
  await expectNoOffer(page, "options after tapping locked rows");
  await ev.shot("options.html", "locked-rows", { width: 560, height: 1300 });
});

test("J13.FD no rating card ever appears while the policy is off, even for an old install", async ({}, testInfo) => {
  const ev = new FirefoxEvidence("J13.FD", testInfo, firefox);
  await (await firstRunTab(firefox)).close();
  // An install ten days old, which would be eligible for a card if a policy ever allowed one.
  const original = (await readStore<{ firstRecordedAt: number }>(
    firefox,
    "still:originalInstall",
  ))!;
  await writeStore(firefox, {
    "still:originalInstall": {
      ...original,
      firstRecordedAt: Date.now() - 10 * 24 * 3600 * 1000,
    },
  });
  for (const name of [
    "popup.html",
    "options.html",
    "first-run.html",
  ] as const) {
    const page = await firefox.openExtensionPage(name);
    await new Promise((done) => setTimeout(done, 1000));
    const text = await allText(page);
    expect(RATING_COPY.test(text), `${name} shows no rating card`).toBe(false);
    expect(await page.count("[data-kind=rating], .invitation")).toBe(0);
    await page.close();
  }
  const dump = await ev.storage("after-old-install");
  expect(Object.keys(dump).filter((k) => /rating/i.test(k))).toEqual([]);
});

test("J13.FD the rating check can fail: it finds the card copy when it is on the page", async () => {
  const page = await firefox.openExtensionPage("popup.html");
  await page.waitFor(
    "the switches",
    () => page.count("button[role=switch]"),
    (n) => n >= 5,
  );
  expect(RATING_COPY.test(await allText(page))).toBe(false);
  await page.evaluate(
    `(() => { const p = document.createElement("p"); p.textContent = "A rating helps other people find Still."; document.body.append(p); return true; })()`,
  );
  expect(RATING_COPY.test(await allText(page))).toBe(true);
  await page.close();
});

test.fixme("J14.FD account deletion from settings (request, verify, deleted, failed)", async () => {
  // NEEDS_BACKEND, and it depends on the U5-W2 erasure build (owner questions open). The unconfigured
  // Firefox build has no sign-in, so the delete-account dialog is unreachable.
  expect(NEEDS_BACKEND).toBeTruthy();
});
