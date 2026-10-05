import { test, expect, fixture } from "./_extension.js";

// Gating in CI's configured run (STILL_TEST_SYNC_CONFIGURED=true, a build with synthetic public
// Supabase configuration). Configured builds keep the legacy settings document until the modern
// settings rollout, so the shipping entry must keep them on the legacy engine. The deeper,
// opt-in evidence run is configured-build.spec.ts.
test.skip(
  process.env.STILL_TEST_SYNC_CONFIGURED !== "true",
  "Requires the independently declared configured build",
);

test("configured build: a YouTube Shorts page runs the legacy lane, never format-2", async ({ context }) => {
  const page = await context.newPage();
  await page.route("**://*.youtube.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture("youtube.html") }),
  );
  await page.goto("https://www.youtube.com/feed/subscriptions");
  await expect(page.locator("html")).toHaveClass(/(^|\s)still-active(\s|$)/);
  await expect(page.locator("html")).toHaveClass(/still-service-youtube/);
  await expect(page.locator("#shelf")).toHaveCount(0); // the legacy remove surface ran
  await expect(page.locator("#keep-video")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator("html")).not.toHaveClass(/still-feature-/);
});
