import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findFirefox } from "./_bidi.js";
import { FIREFOX_EXTENSION, StillFirefox } from "./_session.js";

// Text size (owner decision 51) in a real Firefox: the V3 settings page follows Firefox's own font
// size (Settings → Fonts → Size, the `font.size.variable.x-western` preference).
//
// Not covered here: a browser text zoom that grows both of the binder's probes (Firefox for
// Android's font size). Desktop Firefox has no setting that does this: `font.size.systemFontScale`
// leaves page text unchanged on desktop, and the minimum font size is applied after computed
// values, so both probes still read 16px. The binder's unit tests cover that case, and Firefox for
// Android is checked on the Android emulator.

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

test("Firefox font size 32 gives 2×", async () => {
  expect((await settingsPage({ "font.size.variable.x-western": 32 })).scale).toBe("2");
});
