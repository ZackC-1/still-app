import { test, expect, fixture } from "./_extension.js";
import type { Worker } from "@playwright/test";

// Evidence for configured (store-like) builds, which keep the legacy settings document until the
// modern settings rollout. Run against a configured artifact, e.g.:
//   VITE_SUPABASE_URL=https://placeholder-project.invalid VITE_SUPABASE_ANON_KEY=placeholder \
//     pnpm --filter @still/ext-chromium build && cp -R packages/ext-chromium/dist/chrome-mv3 /tmp/configured
//   STILL_CHROMIUM_EXTENSION=/tmp/configured STILL_EXPECT_CONFIGURED=1 \
//     pnpm exec playwright test --project=fixtures tests/playwright/configured-build.spec.ts
// The default CI artifact is unconfigured (it initializes schema-2 settings at install), so these
// cases are skipped there; fixtures.spec.ts covers the same legacy lane with a schema-1 profile.

test.skip(!process.env.STILL_EXPECT_CONFIGURED, "needs a configured build (see header)");

async function storedSchema(worker: Worker): Promise<number | null> {
  return worker.evaluate(async () => {
    const api = (globalThis as unknown as {
      chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
    }).chrome;
    const record = (await api.storage.local.get("still:settings"))["still:settings"] as
      | { settings?: { schemaVersion?: number } }
      | undefined;
    return record?.settings ? (record.settings.schemaVersion ?? 1) : null;
  });
}

test("configured build: a fresh install never commits schema-2 settings and pages run the legacy engine", async ({
  context,
  extensionId,
}) => {
  // Resolving extensionId first waits for the background worker (or finds it already running);
  // waiting for a "serviceworker" event after the worker has started would hang.
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  const worker = context.serviceWorkers()[0]!;
  const page = await context.newPage();
  await page.route("**://*.youtube.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture("youtube.html") }),
  );
  await page.goto("https://www.youtube.com/feed/subscriptions");
  await expect(page.locator("html")).toHaveClass(/still-active/);
  await expect(page.locator("html")).toHaveClass(/still-service-youtube/);
  await expect(page.locator("html")).not.toHaveClass(/still-feature-/);
  await expect(page.locator("#shelf")).toHaveCount(0); // the legacy remove surface
  await expect(page.locator("#keep-video")).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(await storedSchema(worker)).not.toBe(2);
});

test.describe("configured build with a saved schema-1 profile", () => {
  test.use({ settingsProfile: "legacy" });
  test("Instagram keeps the legacy route placeholder and removal", async ({ context }) => {
    const page = await context.newPage();
    await page.route("**://*.instagram.com/**", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture("instagram-mobile.html") }),
    );
    await page.goto("https://www.instagram.com/");
    await expect(page.locator("#ig-mobile-reel")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveClass(/still-feature-/);
    await page.goto("https://www.instagram.com/someuser/reels/");
    await expect(page.locator("#still-placeholder")).toBeVisible();
  });
});
