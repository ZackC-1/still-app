import { defineConfig } from "@playwright/test";

// Local WebKit evidence for the Safari pending cover (U7-W3). Separate from the main config on
// purpose: CI installs only Chromium, and the coordinator ruled this lane local macOS evidence, not
// a required check. Playwright's WebKit cannot load a Safari extension, so these specs run the
// maintained cover module as a document-creation script on routed pages; they prove WebKit's
// rendering of the cover (opacity, self-expiry, canvas background, timing), not extension
// injection order or device behaviour. Run: pnpm exec playwright test -c tests/webkit/playwright.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? "github" : "list",
});
