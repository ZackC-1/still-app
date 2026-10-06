import type { Page } from "@playwright/test";
import { test, expect } from "./_extension.js";

// The popup's first settings read can be slow (a cold browser, Firefox for Android in an emulator).
// Until that read answers, the popup must say it is checking, never "Settings are unavailable.":
// that line and its Try again button are for a read that actually failed. An unconfigured build
// runs the committed (V3) popup on schema-2 settings; a configured build keeps the legacy popup on
// its settings document. Both lanes must behave the same way.
const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
test.use({ settingsProfile: syncConfigured ? "fresh" : "modern" });

const UNAVAILABLE = "Settings are unavailable.";

type Probe = {
  sawUnavailable: boolean;
  sawChecking: boolean;
  settingsWrites: number;
};

/** Delays (or fails) the popup's own reads of the settings slot and records what it ever showed. */
async function slowSettingsRead(
  page: Page,
  mode: { delayMs: number } | { fail: true },
) {
  await page.addInitScript((mode) => {
    const probe: Probe = {
      sawUnavailable: false,
      sawChecking: false,
      settingsWrites: 0,
    };
    (window as unknown as { stillProbe: Probe }).stillProbe = probe;
    const area = (
      globalThis as unknown as {
        chrome: {
          storage: {
            local: {
              get: (...a: unknown[]) => Promise<unknown>;
              set: (...a: unknown[]) => Promise<unknown>;
            };
          };
        };
      }
    ).chrome.storage.local;
    const get = area.get.bind(area);
    const set = area.set.bind(area);
    const touchesSettings = (keys: unknown) =>
      keys === "still:settings" ||
      (Array.isArray(keys) && keys.includes("still:settings")) ||
      (keys !== null &&
        typeof keys === "object" &&
        !Array.isArray(keys) &&
        "still:settings" in keys);
    area.get = (...args: unknown[]) => {
      if (!touchesSettings(args[0])) return get(...args);
      if ("fail" in mode)
        return Promise.reject(new Error("synthetic storage failure"));
      return new Promise((resolve) => setTimeout(resolve, mode.delayMs)).then(
        () => get(...args),
      );
    };
    area.set = (...args: unknown[]) => {
      if (touchesSettings(args[0])) probe.settingsWrites += 1;
      return set(...args);
    };
    new MutationObserver(() => {
      const text = document.body?.textContent ?? "";
      if (text.includes("Settings are unavailable."))
        probe.sawUnavailable = true;
      if (text.includes("Checking sync…")) probe.sawChecking = true;
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, mode);
}

const probe = (page: Page) =>
  page.evaluate(() => (window as unknown as { stillProbe: Probe }).stillProbe);

test("a slow first settings read shows checking, never the unavailable state, and writes nothing", async ({
  context,
  extensionId,
}) => {
  await context.route(/^https?:/, (route) => route.abort());
  const page = await context.newPage();
  await slowSettingsRead(page, { delayMs: 1_500 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole("switch")).toHaveCount(5, { timeout: 10_000 });
  const seen = await probe(page);
  expect(
    seen.sawUnavailable,
    "the popup flashed the unavailable state while loading",
  ).toBe(false);
  expect(
    seen.sawChecking,
    "the popup showed no neutral checking state while loading",
  ).toBe(true);
  await expect(page.getByText(UNAVAILABLE)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(seen.settingsWrites).toBe(0);
});

test("a first settings read that fails still shows the unavailable state", async ({
  context,
  extensionId,
}) => {
  await context.route(/^https?:/, (route) => route.abort());
  const page = await context.newPage();
  await slowSettingsRead(page, { fail: true });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByText(UNAVAILABLE)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  expect((await probe(page)).settingsWrites).toBe(0);
});
