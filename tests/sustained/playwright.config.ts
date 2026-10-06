import { defineConfig } from "@playwright/test";

// The sustained-session harness has its own config: it is long, local and single-worker, and it
// must never join the gating fixtures project. Run it through run.mjs.
export default defineConfig({
  testDir: ".",
  testMatch: /sustained-session\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "../../test-results/sustained/artifacts",
});
