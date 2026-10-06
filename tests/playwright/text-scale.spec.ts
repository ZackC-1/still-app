import { chromium, test, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
        /Checking sync…|Settings are unavailable\./.test(element.textContent ?? ""),
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

  test("at 1.5× the popup keeps its approved layout; above it the whole popup scrolls", async () => {
    for (const [fontSize, overflowY] of [
      [24, "visible"],
      [32, "auto"],
    ] as const) {
      const browser = await launchWithFontSize(fontSize);
      try {
        const page = await openPage(browser, "popup.html", 380, 600);
        const app = page.locator('.app[data-density="compact"]');
        await expect(app).toBeVisible();
        expect(await app.evaluate((element) => getComputedStyle(element).overflowY)).toBe(overflowY);
        const height = await app.evaluate((element) => element.getBoundingClientRect().height);
        expect(height).toBeLessThanOrEqual(600);
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
    // Until the first settings read answers the popup and settings page say "Checking sync…"; a
    // read that fails says "Settings are unavailable." with Try again. Both follow the text size.
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
              hasText: mode === "hold" ? "Checking sync…" : "Settings are unavailable.",
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
      const card = page.getByRole("region", { name: "Rate Still" });
      await expect(card).toBeVisible();
      const app = page.locator('.app[data-density="compact"]');
      expect(await app.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
      expect(await app.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(600);
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
  const CARD = "Use the same settings in every browser";

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
      const app = popup.locator('.app[data-density="compact"]');
      expect(await app.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
      expect(await app.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(600);
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
