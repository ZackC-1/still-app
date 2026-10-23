import { chromium, test, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAID_TIER_ENABLED } from "../../packages/shared-types/src/entitlement.js";
import { helpHitAreas } from "./_help-hit-areas.js";

// Text size (owner decision 51): the V3 screens follow Chrome's own "Font size" setting. The
// setting is real: each browser starts with a profile whose saved Preferences carry the default
// font size, exactly what Settings → Appearance → Font size writes. Nothing in the page is stubbed.
//
// Lane-aware: configured 2.x builds (STILL_TEST_SYNC_CONFIGURED=true) contain no text-size code,
// so there the setting must change nothing. The sync invitation card needs the V3 build with
// sign-in, which CI does not build; its case runs with STILL_EXPECT_MODERN_SIGN_IN=1 (see
// sync-invitation.spec.ts for how to build it).

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = process.env.STILL_CHROMIUM_EXTENSION
  ? resolve(process.env.STILL_CHROMIUM_EXTENSION)
  : resolve(HERE, "../../packages/ext-chromium/dist/chrome-mv3");
const configured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
const MODERN_SIGN_IN = process.env.STILL_EXPECT_MODERN_SIGN_IN === "1";
const V3_ONLY = "Text size follows the browser only in builds that show the V3 screens";
const FIRST_RUN = /^chrome-extension:\/\/[a-z]{32}\/first-run\.html$/;

interface Browser {
  readonly context: BrowserContext;
  readonly id: string;
  close(): Promise<void>;
}

interface ProfileExtras {
  /** Settings → Appearance → Customize fonts → Minimum font size (Chromium's slider tops out at 24). */
  readonly minimumFontSize?: number;
  /** Settings → Appearance → Page zoom, as a factor (1.5 is 150%). */
  readonly pageZoom?: number;
}

async function launchWithFontSize(
  defaultFontSize: number,
  extras: ProfileExtras = {},
): Promise<Browser> {
  const root = mkdtempSync(join(tmpdir(), "still-text-scale-"));
  const profile = join(root, "browser");
  mkdirSync(join(profile, "Default"), { recursive: true });
  const webprefs: Record<string, number> = { default_font_size: defaultFontSize };
  if (extras.minimumFontSize !== undefined) webprefs.minimum_font_size = extras.minimumFontSize;
  const preferences: Record<string, unknown> = { webkit: { webprefs } };
  // Chrome saves the default page zoom as a zoom level (factor = 1.2 ^ level) for the default
  // storage partition, keyed "x".
  if (extras.pageZoom !== undefined)
    preferences.partition = {
      default_zoom_level: { x: Math.log(extras.pageZoom) / Math.log(1.2) },
    };
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify(preferences));
  // Chromium writes into an unpacked extension it loads, so load a disposable copy, never the
  // built folder other specs hash (as _extension.ts does).
  const extension = join(root, "extension");
  cpSync(EXTENSION, extension, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = (await context.waitForEvent("serviceworker")) as Worker;
  const id = new URL(worker.url()).host;
  await context.route(/^https?:/, (route) => route.abort());
  // A V3 build opens its first-run tab on install, at a moment of its own choosing. If it lands on
  // top of a page under test, headless Chromium (on Linux) throttles that page to a frame or two a
  // second while it still reports itself visible, and every scroll and viewport check waits on
  // frames. Let the install tab appear and close it before any page is opened.
  if (!configured) {
    const firstRun =
      context.pages().find((page) => FIRST_RUN.test(page.url())) ??
      (await context.waitForEvent("page", {
        predicate: (page) => FIRST_RUN.test(page.url()),
        timeout: 15_000,
      }));
    await firstRun.close();
  }
  return {
    context,
    id,
    async close() {
      await context.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

async function openPage(browser: Browser, path: string, width = 1280, height = 900): Promise<Page> {
  const page = await browser.context.newPage();
  await page.setViewportSize({ width, height });
  await page.goto(`chrome-extension://${browser.id}/${path}`);
  // The page under test is the front tab, so it renders at full frame rate (see launchWithFontSize).
  await page.bringToFront();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const textScale = (page: Page): Promise<string> =>
  page.evaluate(() => document.documentElement.style.getPropertyValue("--text-scale"));

/** The computed font size of the V3 screen root, once the V3 screen has mounted. */
async function v3RootFontSize(page: Page): Promise<number> {
  const root = page.locator(".still-ui").first();
  await expect(root).toBeVisible();
  return root.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
}

/** Nothing on the page reaches past its right edge. */
async function expectNoSidewaysOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll<HTMLElement>(".still-ui *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > document.documentElement.clientWidth + 0.5;
      })
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 80)),
  }));
  expect(overflow.offenders).toEqual([]);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
}

/** ISS-0098 (owner, 21 Oct): nothing inside the popup scrolls on its own; when it is taller than
 * the browser's cap the document scrolls. Lead ruling, 22 Oct: at 1.5× text size and larger the
 * browser's own popup frame may scroll (Chrome caps popups at 600px), so "may" accepts either; the
 * inner layout still never scrolls, and at 1× the option B growth holds (nothing scrolls). */
async function expectOnlyTheDocumentScrolls(page: Page, documentScrolls: boolean | "may"): Promise<void> {
  const scrollers = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".still-ui, .still-ui *")]
      .filter((element) => element.scrollHeight > element.clientHeight + 1 &&
        ["auto", "scroll"].includes(getComputedStyle(element).overflowY))
      .map((element) => element.className),
  );
  expect(scrollers).toEqual([]);
  const scroll = await page.evaluate(() => ({
    height: document.scrollingElement!.scrollHeight,
    view: document.scrollingElement!.clientHeight,
  }));
  if (documentScrolls !== "may") expect(scroll.height > scroll.view).toBe(documentScrolls);
}

/** Every button, link and switch in the V3 screen can be scrolled into view and seen. */
async function expectEveryControlReachable(page: Page): Promise<void> {
  const controls = page.locator(".still-ui :is(button, a, [role=switch])");
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue; // collapsed sections and screen-reader-only text
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport();
  }
}

/** Open each site's section in turn (both screens show one at a time) and check what it holds:
 * nothing reaches sideways, every control in it can be scrolled into view, and every locked
 * "Still Pro" row is whole (on screen, not cut short). Returns how many locked rows were seen. */
async function sweepEverySection(page: Page, where: string): Promise<number> {
  const expanders = page.locator(".still-ui button.expander");
  // The sections appear once the first settings read answers ("Checking sync…" until then); with
  // sign-in configured that read can take a moment longer, so wait for them before counting.
  await expect(expanders.first(), where).toBeVisible({ timeout: 15_000 });
  const sections = await expanders.count();
  expect(sections, where).toBeGreaterThan(0);
  let locked = 0;
  for (let index = 0; index < sections; index++) {
    const expander = expanders.nth(index);
    await expander.scrollIntoViewIfNeeded();
    await expander.click();
    await expect(expander).toHaveAttribute("aria-expanded", "true");
    // The section that was open closes with an animation; check only once everything has settled.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    await expectNoSidewaysOverflow(page);
    const panel = page.locator(`[id="${await expander.getAttribute("aria-controls")}"]`);
    const controls = panel.locator(":is(button, a, [role=switch])");
    for (let item = 0; item < (await controls.count()); item++) {
      const control = controls.nth(item);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 0.99 }); // sub-pixel rounding
      if (!(await control.evaluate((element) => element.classList.contains("lock-pro")))) continue;
      locked++;
      await expect(control).toHaveText("Still Pro");
      const cut = await control.evaluate((element) => element.scrollWidth > element.clientWidth + 0.5);
      expect(cut, `${where}: a "Still Pro" label is cut short`).toBe(false);
    }
  }
  return locked;
}

/** Holds (or fails) the page's own reads of the settings slot, so its loading or unavailable state
 * stays on screen (the same seam as popup-loading.spec.ts). */
async function holdSettingsRead(page: Page, mode: "hold" | "fail"): Promise<void> {
  await page.addInitScript((mode) => {
    const area = (
      globalThis as unknown as {
        chrome: { storage: { local: { get: (...a: unknown[]) => Promise<unknown> } } };
      }
    ).chrome.storage.local;
    const get = area.get.bind(area);
    const touchesSettings = (keys: unknown) =>
      keys === "still:settings" ||
      (Array.isArray(keys) && keys.includes("still:settings")) ||
      (keys !== null && typeof keys === "object" && !Array.isArray(keys) && "still:settings" in keys);
    // Record the size the loading or unavailable line has the moment it first appears.
    const seen = window as unknown as { stillFirstStatusSize?: number };
    new MutationObserver(() => {
      if (seen.stillFirstStatusSize !== undefined) return;
      const line = [...document.querySelectorAll("[role=status]")].find((element) =>
        /Loading your settings…|Settings are unavailable\./.test(element.textContent ?? ""),
      );
      if (line) seen.stillFirstStatusSize = parseFloat(getComputedStyle(line).fontSize);
    }).observe(document, { subtree: true, childList: true, characterData: true });
    area.get = (...args: unknown[]) => {
      if (!touchesSettings(args[0])) return get(...args);
      if (mode === "fail") return Promise.reject(new Error("synthetic storage failure"));
      return new Promise(() => {}); // never answers: the page stays in its first read
    };
  }, mode);
}

/** The computed font size of an element, in CSS pixels. */
const fontSizeOf = (locator: ReturnType<Page["locator"]>): Promise<number> =>
  locator.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));

test.describe("Chrome Font size reaches the V3 screens", () => {
  test.skip(configured, V3_ONLY);

  for (const [fontSize, scale] of [
    [12, "1"], // Small: never smaller than the design's normal size
    [16, "1"], // Medium (default)
    [20, "1.25"], // Large
    [24, "1.5"], // Very large: the design's 150% frames
    [32, "2"],
    [72, "2"], // the slider's maximum: capped at twice the normal size
  ] as const) {
    test(`default font size ${fontSize}px gives --text-scale ${scale} on the settings page`, async () => {
      const browser = await launchWithFontSize(fontSize);
      try {
        const page = await openPage(browser, "options.html");
        await expect.poll(() => textScale(page)).toBe(scale);
        expect(await v3RootFontSize(page)).toBeCloseTo(16 * Number(scale), 1);
      } finally {
        await browser.close();
      }
    });
  }

  test("the Help card keeps two columns of links with clear hit areas, and one column above 1.5×", async () => {
    test.setTimeout(240_000);
    // Owner, 21 Oct: Setup guide on the left; Privacy policy, then Contact support with its
    // address, on the right. Signed out in this lane, so Delete account is absent.
    for (const [fontSize, columns] of [
      [16, 2],
      [24, 2],
      [32, 1],
    ] as const) {
      const browser = await launchWithFontSize(fontSize);
      try {
        for (const width of [320, 432]) {
          const page = await openPage(browser, "options.html", width, 900);
          const where = `${width}px wide at ${fontSize}px`;
          const help = page.getByRole("region", { name: "Help" });
          await expect(help).toBeVisible();
          const box = async (name: string) => {
            const found = await help.getByRole("button", { name }).boundingBox();
            expect(found, `${name}, ${where}`).not.toBeNull();
            return found!;
          };
          const setup = await box("Setup guide");
          const privacy = await box("Privacy policy");
          const contact = await box("Contact support");
          const address = await help.getByText(/@/).boundingBox();
          expect(address!.y, `address under Contact support, ${where}`).toBeGreaterThanOrEqual(contact.y + contact.height - 1);
          expect(contact.y, `Contact support under Privacy policy, ${where}`).toBeGreaterThanOrEqual(privacy.y + privacy.height - 1);
          if (columns === 2) {
            expect(Math.abs(setup.y - privacy.y), where).toBeLessThan(1);
            expect(privacy.x, where).toBeGreaterThan(setup.x + setup.width);
            expect(Math.abs(contact.x - privacy.x), where).toBeLessThan(1);
          } else {
            expect(Math.abs(setup.x - privacy.x), where).toBeLessThan(1);
            expect(privacy.y, where).toBeGreaterThanOrEqual(setup.y + setup.height - 1);
          }
          // Each link's invisible hit area is at least 24px tall, and none of them takes a click on
          // another link's label or on the support address (ISS-0112: the address stays selectable).
          // Measured last: it scrolls the card into view.
          const { heights, stolen } = await helpHitAreas(page);
          for (const name of ["Setup guide", "Privacy policy", "Contact support"])
            expect(heights[name], `${name} hit area, ${where}`).toBeGreaterThanOrEqual(24);
          expect(stolen, `labels and address taken by another hit area, ${where}`).toEqual([]);
          await expectNoSidewaysOverflow(page);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }
  });

  test("the popup, first-run and TikTok pages follow it too", async () => {
    const browser = await launchWithFontSize(24);
    try {
      for (const path of ["popup.html", "first-run.html", "tiktok-blocked.html?r=text-scale-check"]) {
        const page = await openPage(browser, path);
        await expect.poll(() => textScale(page), { message: path }).toBe("1.5");
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  test("text size adds no rule of its own to the popup's Settings sync heading", async () => {
    // Owner decision 65: text size never resizes this heading itself; it keeps the size its approved
    // design gives it. V3 builds show the popup in its D28 (sync invitation) layout, whose approved
    // 150% frame (d28-09) draws the heading at 15px × the text size, like the card headings; the
    // plain D01 layout's fixed 17px is no longer shown where text size applies. The line under the
    // heading (13px × scale) shows the scale really applied.
    for (const [fontSize, scale] of [
      [16, "1"],
      [24, "1.5"],
      [32, "2"],
    ] as const) {
      const browser = await launchWithFontSize(fontSize);
      try {
        const page = await openPage(browser, "popup.html", 380, 600);
        await expect.poll(() => textScale(page)).toBe(scale);
        await expect(page.locator(".app.d28-invitation")).toBeVisible();
        const rules = await page.locator("style[data-still-text-scale-rules]").textContent();
        expect(rules).not.toContain("sync-row");
        const row = page.locator(".card .sync-row", { hasText: "Settings sync" });
        const heading = row.locator(".sync-row-title");
        await expect(heading).toBeVisible();
        const size = (locator: typeof heading) =>
          locator.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
        expect(await size(heading), `heading at ${scale}×`).toBeCloseTo(15 * Number(scale), 1);
        expect(await size(row.locator(".sync-row-sub")), `line under it at ${scale}×`).toBeCloseTo(
          13 * Number(scale),
          1,
        );
      } finally {
        await browser.close();
      }
    }
  });

  test("at large text only the document scrolls, never a box inside the popup (ISS-0098, lead ruling 22 Oct)", async () => {
    // The shipped 3.x popup (sign-in and the paid tier on) is taller than the approved layout without
    // sign-in. Lead ruling, 22 Oct: at 1.5× and larger its document may scroll; nothing inside it
    // scrolls; at 1× (16px) nothing scrolls at all.
    const shipped = MODERN_SIGN_IN && PAID_TIER_ENABLED;
    const cases: ReadonlyArray<readonly [number, boolean | "may"]> = shipped
      ? [[16, false], [24, "may"], [32, "may"]]
      : [[24, false], [32, true]];
    for (const [fontSize, documentScrolls] of cases) {
      const browser = await launchWithFontSize(fontSize);
      try {
        const page = await openPage(browser, "popup.html", 380, 600);
        await expect(page.locator('.app[data-density="compact"]')).toBeVisible();
        await expectOnlyTheDocumentScrolls(page, documentScrolls);
      } finally {
        await browser.close();
      }
    }
  });


  for (const fontSize of [24, 32]) {
    test(`at default font size ${fontSize}px nothing overflows and every control is reachable`, async () => {
      const browser = await launchWithFontSize(fontSize);
      try {
        const popup = await openPage(browser, "popup.html", 380, 600);
        await expect(popup.locator('.app[data-density="compact"]')).toBeVisible();
        await expectNoSidewaysOverflow(popup);
        await expectEveryControlReachable(popup);
        for (const width of [320, 380, 432]) {
          for (const path of ["options.html", "first-run.html"]) {
            const page = await openPage(browser, path, width, 900);
            await expect(page.locator(".still-ui").first()).toBeVisible();
            await expectNoSidewaysOverflow(page);
            await expectEveryControlReachable(page);
            await page.close();
          }
        }
      } finally {
        await browser.close();
      }
    });
  }

  test("locked Still Pro rows stay whole and reachable at 1.5× and 2×", async () => {
    // Two text sizes × four screens × every site section: allow for a slow CI machine.
    test.setTimeout(120_000);
    // Paid features are dormant, so every Pro extra shows as a locked "Still Pro" row inside its
    // site's section, in the popup and on the settings page.
    for (const fontSize of [24, 32]) {
      const browser = await launchWithFontSize(fontSize);
      try {
        const popup = await openPage(browser, "popup.html", 380, 600);
        await expect.poll(() => textScale(popup)).toBe(fontSize === 24 ? "1.5" : "2");
        expect(await sweepEverySection(popup, `popup at ${fontSize}px`)).toBeGreaterThan(0);
        await popup.close();
        for (const width of [320, 380, 432]) {
          const page = await openPage(browser, "options.html", width, 900);
          await expect(page.locator(".still-ui").first()).toBeVisible();
          expect(await sweepEverySection(page, `settings ${width}px wide at ${fontSize}px`)).toBeGreaterThan(0);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }
  });

  test("the loading and unavailable lines follow the text size too", async () => {
    // Until the first settings read answers, the popup and settings page say "Loading your
    // settings…"; a read that fails says "Settings are unavailable." with Try again. Both follow
    // the text size.
    for (const [fontSize, scale] of [
      [16, 1],
      [32, 2],
    ] as const) {
      const browser = await launchWithFontSize(fontSize);
      try {
        for (const [path, width, height] of [
          ["popup.html", 380, 600],
          ["options.html", 432, 900],
        ] as const) {
          for (const mode of ["hold", "fail"] as const) {
            const page = await browser.context.newPage();
            await page.setViewportSize({ width, height });
            await holdSettingsRead(page, mode);
            await page.goto(`chrome-extension://${browser.id}/${path}`);
            await page.bringToFront();
            const where = `${path}, ${mode === "hold" ? "checking" : "unavailable"}, ${fontSize}px`;
            const line = page.getByRole("status").filter({
              hasText: mode === "hold" ? "Loading your settings…" : "Settings are unavailable.",
            });
            await expect(line, where).toBeVisible({ timeout: 10_000 });
            await expect.poll(() => textScale(page), { message: where }).toBe(String(scale));
            // Already at the right size the moment it appears: never a flash at the normal size.
            const first = await page.evaluate(
              () => (window as unknown as { stillFirstStatusSize?: number }).stillFirstStatusSize,
            );
            expect(first, `${where}: size when it first appeared`).toBeCloseTo(16 * scale, 1);
            expect(await fontSizeOf(line), where).toBeCloseTo(16 * scale, 1);
            if (mode === "fail") {
              const retry = page.getByRole("button", { name: "Try again" });
              await expect(retry, where).toBeVisible();
              await expectNoSidewaysOverflow(page);
              await retry.scrollIntoViewIfNeeded();
              await expect(retry, where).toBeInViewport();
            }
            await page.close();
          }
        }
      } finally {
        await browser.close();
      }
    }
  });

  test("at 2× the rating card and everything under it stay reachable, and nothing reaches sideways", async () => {
    // The card needs a week-old install and a fresh owner allowance from the network, so the
    // background's two answers are given here instead: it reserved a rating card for this opening,
    // and the reservation committed. Everything the popup draws is the real card.
    const browser = await launchWithFontSize(32);
    try {
      const page = await browser.context.newPage();
      await page.setViewportSize({ width: 380, height: 600 });
      await page.addInitScript(() => {
        const runtime = (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage: (message: unknown, ...rest: unknown[]) => Promise<unknown> } };
          }
        ).chrome.runtime;
        const send = runtime.sendMessage.bind(runtime);
        runtime.sendMessage = (message: unknown, ...rest: unknown[]) => {
          const ask = message as { kind?: string; op?: string } | null;
          if (ask?.kind !== "still:invitation") return send(message, ...rest);
          if (ask.op === "present")
            return Promise.resolve({
              status: "present",
              card: { installation: "text-scale-check", reservation: { kind: "rating", generation: 1 } },
            });
          if (ask.op === "commit") return Promise.resolve({ status: "commit", committed: true });
          return send(message, ...rest);
        };
      });
      await page.goto(`chrome-extension://${browser.id}/popup.html`);
      await page.bringToFront();
      await expect.poll(() => textScale(page)).toBe("2");
      const card = page.getByRole("region", { name: "Enjoying Still?" });
      await expect(card).toBeVisible();
      await expectOnlyTheDocumentScrolls(page, true);
      await expectNoSidewaysOverflow(page);
      await expectEveryControlReachable(page);
      for (const name of ["Rate Still", "Not now"]) {
        const button = card.getByRole("button", { name });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport({ ratio: 0.99 }); // sub-pixel rounding
      }
    } finally {
      await browser.close();
    }
  });

  test("a minimum font size does not skew the scale", async () => {
    // Chromium includes its minimum font size in computed sizes. With probes at the normal size,
    // a 20px minimum raised the 16px reference to 20px and a 24px default read as 1.2×.
    for (const [fontSize, minimumFontSize, scale] of [
      [24, 20, "1.5"],
      [24, 24, "1.5"],
      [32, 24, "2"],
      [12, 20, "1"],
    ] as const) {
      const browser = await launchWithFontSize(fontSize, { minimumFontSize });
      try {
        const page = await openPage(browser, "options.html");
        await expect
          .poll(() => textScale(page), { message: `default ${fontSize}px, minimum ${minimumFontSize}px` })
          .toBe(scale);
      } finally {
        await browser.close();
      }
    }
  });

  test("Chrome's page zoom is left to the browser and never read as a text size", async () => {
    for (const [fontSize, scale] of [
      [16, "1"],
      [24, "1.5"],
    ] as const) {
      const browser = await launchWithFontSize(fontSize, { pageZoom: 1.5 });
      try {
        const page = await openPage(browser, "options.html");
        // The zoom really applies to the extension page: 1.5 device pixels per CSS pixel.
        expect(await page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(1.5, 2);
        await expect.poll(() => textScale(page)).toBe(scale);
      } finally {
        await browser.close();
      }
    }
  });
});

test.describe("the sync invitation card at large text (V3 build with sign-in)", () => {
  test.skip(!MODERN_SIGN_IN, "Needs the modern sign-in build (see header)");
  const CARD = "Settings sync";

  test("at 2× the card and everything under it stay reachable, and nothing reaches sideways", async () => {
    const browser = await launchWithFontSize(32);
    try {
      // Earn the card: three direct changes in one opening, then a later opening shows it.
      const first = await openPage(browser, "popup.html", 380, 600);
      const switches = first.getByRole("switch");
      await expect(switches).toHaveCount(5);
      for (const index of [1, 2, 0]) {
        await switches.nth(index).click();
        await expect(switches.nth(index)).toHaveAttribute("aria-checked", "false");
      }
      // The background counts each change; close only once it has earned the card (as
      // sync-invitation.spec.ts does), or the last report can be lost with the page.
      const [worker] = browser.context.serviceWorkers();
      await expect
        .poll(() =>
          worker!.evaluate(async () => {
            const local = (
              globalThis as unknown as {
                chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
              }
            ).chrome.storage.local;
            const ledger = (await local.get("still:invitationLedger"))["still:invitationLedger"] as
              | { sync?: string }
              | undefined;
            return ledger?.sync;
          }),
        )
        .toBe("earned");
      await first.close();
      const popup = await openPage(browser, "popup.html", 380, 600);
      await expect.poll(() => textScale(popup)).toBe("2");
      const card = popup.getByRole("region", { name: CARD });
      await expect(card).toBeVisible();
      await expectOnlyTheDocumentScrolls(popup, true);
      await expectNoSidewaysOverflow(popup);
      await expectEveryControlReachable(popup);
      for (const name of ["Sign in", "Not now"]) {
        const button = card.getByRole("button", { name });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport({ ratio: 0.99 }); // sub-pixel rounding
      }
    } finally {
      await browser.close();
    }
  });
});

test.describe("configured 2.x builds", () => {
  test.skip(!configured, "Requires the configured build");

  test("a large Font size changes nothing: no text-size code is in the build", async () => {
    const browser = await launchWithFontSize(24);
    try {
      for (const path of ["options.html", "popup.html"]) {
        const page = await openPage(browser, path);
        await expect(page.locator("#app *").first()).toBeAttached();
        expect(await textScale(page)).toBe("");
        expect(await page.locator("[data-still-text-probe], style[data-still-text-scale-rules]").count()).toBe(0);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
});

// Review F-1 (22 Oct): with the paid tier compiled on, a locked Still Pro row shows its saved switch
// beside the Still Pro pill (CH-96). At large text that pair must never squeeze the row's name to a
// few letters per line: the name keeps at least 120px, and when the switch and pill do not fit
// beside it they wrap onto their own line. Runs only in the paid-tier-on CI step (STILL_TEST_PAID_TIER),
// which loads the build from scripts/qa/paid-tier-extension.mjs.
test.describe("paid tier on: locked rows at large text keep their names readable", () => {
  test.skip(process.env.STILL_TEST_PAID_TIER !== "true", "Needs the paid-tier-on build");
  test.skip(configured, V3_ONLY);

  // Review F1 and F4 (22 Oct): the Still Pro pill's invisible hit area is a full 44px at normal text
  // (as much as the 40px popup rows allow there),
  // and no control's hit area (the pill's or the saved switch's) covers the row's name, whether the
  // switch and pill sit beside the name or wrap under it (375px wraps on the Settings page at 1x).
  test("locked rows: a 44px pill hit area that never covers the row's name", async () => {
    test.setTimeout(240_000);
    const browser = await launchWithFontSize(16);
    try {
      for (const [path, width] of [["options.html", 375], ["options.html", 432], ["popup.html", 380]] as const) {
        const page = await openPage(browser, path, width, 900);
        const where = `${path} ${width}px wide`;
        const expanders = page.locator(".still-ui button.expander");
        let measured = 0;
        for (let index = 0; index < (await expanders.count()); index++) {
          const expander = expanders.nth(index);
          await expander.scrollIntoViewIfNeeded();
          if ((await expander.getAttribute("aria-expanded")) !== "true") await expander.click();
          await expect(expander).toHaveAttribute("aria-expanded", "true");
          await page.evaluate(() =>
            Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
          );
          const panel = page.locator(`[id="${await expander.getAttribute("aria-controls")}"]`);
          const rows = panel.locator('.option-row[data-access="locked"]');
          for (let r = 0; r < (await rows.count()); r++) {
            const row = rows.nth(r);
            await row.scrollIntoViewIfNeeded();
            const found = await row.evaluate((element) => {
              const pill = element.querySelector<HTMLElement>(".lock-pro")!;
              const label = element.querySelector<HTMLElement>(".label")!;
              const box = pill.getBoundingClientRect();
              const x = box.left + box.width / 2;
              let top = Infinity;
              let bottom = -Infinity;
              for (let y = box.top - 30; y <= box.bottom + 30; y += 0.25) {
                const hit = document.elementFromPoint(x, y);
                if (hit && pill.contains(hit)) {
                  top = Math.min(top, y);
                  bottom = Math.max(bottom, y);
                }
              }
              const covered: string[] = [];
              const range = document.createRange();
              range.selectNodeContents(label);
              for (const rect of range.getClientRects())
                for (let y = rect.top + 0.5; y < rect.bottom; y += 0.5)
                  for (const px of [rect.left + 1, rect.left + rect.width / 2, rect.right - 1]) {
                    const hit = document.elementFromPoint(px, y);
                    const control = hit?.closest("button, [role=switch], a");
                    if (control && element.contains(control)) covered.push(`(${px.toFixed(0)}, ${y.toFixed(1)})`);
                  }
              return { name: label.textContent!.trim(), hit: bottom - top, covered: covered.slice(0, 5) };
            });
            // 44px where the rows leave room (the 49px app and Settings rows). The popups' locked rows
            // are 40px apart, so neighbouring pills' 44px areas meet halfway and each keeps ~40px.
            expect(found.hit, `${where}: ${found.name} pill hit area`).toBeGreaterThanOrEqual(
              path === "popup.html" ? 39.5 : 43.5,
            );
            expect(found.covered, `${where}: ${found.name} name under a control's hit area`).toEqual([]);
            measured++;
          }
        }
        expect(measured, where).toBeGreaterThan(0);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  test("every locked row keeps a 120px name beside or above its saved switch and pill", async () => {
    test.setTimeout(240_000);
    for (const fontSize of [24, 32]) {
      const browser = await launchWithFontSize(fontSize);
      try {
        for (const width of [375, 380]) {
          const page = await openPage(browser, "popup.html", width, 600);
          await expect.poll(() => textScale(page)).toBe(fontSize === 24 ? "1.5" : "2");
          const where = `popup ${width}px wide at ${fontSize}px`;
          const expanders = page.locator(".still-ui button.expander");
          let locked = 0;
          for (let index = 0; index < (await expanders.count()); index++) {
            const expander = expanders.nth(index);
            await expander.scrollIntoViewIfNeeded();
            if ((await expander.getAttribute("aria-expanded")) !== "true") await expander.click();
            await expect(expander).toHaveAttribute("aria-expanded", "true");
            await page.evaluate(() =>
              Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
            );
            const panel = page.locator(`[id="${await expander.getAttribute("aria-controls")}"]`);
            const rows = await panel.locator('.option-row[data-access="locked"]').evaluateAll((elements) =>
              elements.map((row) => ({
                name: row.querySelector(".label")?.textContent?.trim() ?? "",
                nameWidth: row.querySelector(".row-main")!.getBoundingClientRect().width,
                savedSwitch: Boolean(row.querySelector('.locked-controls [role="switch"]')),
                pill: row.querySelector(".lock-pro")?.textContent?.trim() ?? "",
              })),
            );
            for (const row of rows) {
              expect(row.savedSwitch, `${where}: ${row.name} shows its saved switch`).toBe(true);
              expect(row.pill, `${where}: ${row.name}`).toBe("Still Pro");
              expect(row.nameWidth, `${where}: ${row.name} keeps a readable name`).toBeGreaterThanOrEqual(120);
            }
            locked += rows.length;
          }
          expect(locked, where).toBeGreaterThan(0);
          await expectNoSidewaysOverflow(page);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }
  });
});
