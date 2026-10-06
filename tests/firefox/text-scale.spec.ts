import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findFirefox } from "./_bidi.js";
import { FIREFOX_EXTENSION, StillFirefox } from "./_session.js";

// Text size (owner decision 51) in a real Firefox: the V3 settings page follows Firefox's own font
// size (Settings → Fonts → Size, the `font.size.variable.x-western` preference).
//
// Not exercised here: text zoom. Desktop Firefox has it (View → Zoom → Zoom Text Only, then zoom
// in), but it is a per-site zoom applied through the browser UI, which this BiDi session cannot
// drive, and no preference sets it at startup (`font.size.systemFontScale` left page text unchanged
// on desktop). Firefox for Android's font size works the same way and is checked on the Android
// emulator. The ratio stays safe either way: text zoom treats the binder's two probes alike, so if
// it shows in computed sizes both grow and the ratio holds, and if it does not, neither changes.
// The binder's unit tests cover the case where both probes grow.
//
// Firefox applies its minimum font size after computed values, so a minimum never skews the scale
// (Chromium's does; see tests/playwright/text-scale.spec.ts).

const firefoxBinary = findFirefox();
const built = existsSync(resolve(FIREFOX_EXTENSION, "manifest.json"));
test.skip(!firefoxBinary, "Firefox is not installed (set FIREFOX_BIN to point at it)");
test.skip(!built, "Firefox build missing: run `pnpm --filter @still/ext-chromium build:firefox` first");
test.describe.configure({ mode: "serial" });

type Prefs = Record<string, string | number | boolean>;

async function settingsPage(prefs: Prefs): Promise<{ scale: string; rootFontSize: number }> {
  const firefox = await StillFirefox.start(prefs);
  try {
    const page = await firefox.openExtensionPage("options.html");
    await page.waitForCount(".still-ui", (n) => n > 0, 15_000);
    const scale = await page.evaluate<string>(
      `document.documentElement.style.getPropertyValue("--text-scale")`,
    );
    const rootFontSize = await page.evaluate<number>(
      `parseFloat(getComputedStyle(document.querySelector(".still-ui")).fontSize)`,
    );
    return { scale, rootFontSize };
  } finally {
    await firefox.stop();
  }
}

test("the default font size leaves the normal size", async () => {
  expect((await settingsPage({})).scale).toBe("1");
});

test("Firefox font size 24 gives 1.5×", async () => {
  const { scale, rootFontSize } = await settingsPage({ "font.size.variable.x-western": 24 });
  expect(scale).toBe("1.5");
  expect(rootFontSize).toBeCloseTo(24, 1);
});

test("a minimum font size does not change it: font size 24 with a 20px minimum gives 1.5×", async () => {
  const { scale } = await settingsPage({
    "font.size.variable.x-western": 24,
    "font.minimum-size.x-western": 20,
  });
  expect(scale).toBe("1.5");
});

test("Firefox font size 32 gives 2×", async () => {
  expect((await settingsPage({ "font.size.variable.x-western": 32 })).scale).toBe("2");
});
