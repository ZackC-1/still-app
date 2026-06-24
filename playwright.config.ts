import { defineConfig } from "@playwright/test";

// Two projects (KTD10):
//   - fixtures: the autonomous CI gate. Loads the built Chromium extension and runs it against
//     recorded HTML fixtures (no network). Must be green to merge.
//   - smoke: a small real-site layer, retry-allowed and NON-gating. Run on demand, never in CI's
//     required check.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  projects: [
    {
      name: "fixtures",
      testMatch: /playwright\/.*\.spec\.ts$/,
      retries: 0,
    },
    {
      name: "smoke",
      testMatch: /smoke\/.*\.spec\.ts$/,
      retries: 2,
    },
  ],
});
