import { defineConfig } from "@playwright/test";

// The real-Firefox lane. It is separate from the main config on purpose: those projects load the
// extension into Chromium, and Playwright's own Firefox cannot install add-ons. These specs drive
// a stock Firefox over WebDriver BiDi instead (see _bidi.ts). Run it with `pnpm test:firefox`.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  // Two projects over the same folder. "lane" is the CI-gating scenarios (pnpm test:firefox); "qa" is
  // the opt-in QA journeys (pnpm test:firefox:qa), which are slower and not part of that job.
  projects: [
    { name: "lane", testIgnore: /[\\/]qa-[^\\/]*\.spec\.ts$/ },
    { name: "qa", testMatch: /[\\/]qa-[^\\/]*\.spec\.ts$/ },
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? "github" : "list",
});
