import { test, expect } from "../playwright/_extension.js";

// NON-GATING real-site smoke (KTD10). Hits the live sites with the extension loaded, with lenient
// assertions and retries, to catch gross breakage that fixtures can't. Never runs in CI's required
// check — run on demand: pnpm exec playwright test --project=smoke
test("youtube.com loads with the extension and stays on youtube", async ({ context }) => {
  const page = await context.newPage();
  await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  expect(page.url()).toContain("youtube.com");
});

test("a real Shorts URL leaves the Shorts player", async ({ context }) => {
  const page = await context.newPage();
  await page.goto("https://www.youtube.com/shorts/", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  // Either redirected to watch or shown the placeholder — never left on a Shorts player.
  await expect(page.locator("ytd-shorts")).toHaveCount(0);
});
