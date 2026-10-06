import { defineConfig } from "@playwright/test";

// The WebKit bundle lane (T2). Opt-in and local only: CI installs only Chromium, and this config is
// separate from the root one, so neither the fixtures gate nor the Chrome qa project runs it.
// Run: pnpm exec playwright test -c tests/qa/webkit/playwright.config.ts (see README.md).
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: "../.output/webkit-results",
  reporter: process.env.CI ? "github" : "list",
});
