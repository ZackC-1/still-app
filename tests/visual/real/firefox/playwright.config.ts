import { defineConfig } from "@playwright/test";

// The T1 Firefox visual lane: the REAL built Firefox extension in a stock Firefox over WebDriver
// BiDi, photographed by Firefox's own window snapshot at 2x. Separate from the Chromium runner
// (tests/visual/real/run.mjs) because it needs Firefox, not Chromium. Run:
//   STILL_DESIGN_PACKAGE=/abs/path/to/still-design-system-v3.2 \
//     pnpm exec playwright test -c tests/visual/real/firefox/playwright.config.ts
// Build first: pnpm --filter @still/ext-chromium build:firefox
export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: "list",
});
