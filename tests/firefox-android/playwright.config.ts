import { defineConfig } from "@playwright/test";

// Firefox for Android spike (U14-W3), run only by .github/workflows/firefox-android-emulator.yml
// inside an Android emulator. It drives the real Firefox for Android over WebDriver BiDi through an
// adb port forward, so it is separate from both the Chromium fixtures and the desktop Firefox lane.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  outputDir: "../../test-results/firefox-android/playwright",
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
});
