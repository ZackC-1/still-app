import type { Page } from "@playwright/test";
import { test, expect } from "./_extension.js";

// ISS-0098 (owner, 21 Oct, option B): the Chrome/Firefox popup grows to fit an expanded site. The
// site list is never a scroll box of its own (on 20 Oct the owner could not find YouTube's Comments
// and Live chat rows, hidden below the fold of an inner scroller). When an expanded site makes the
// popup taller than the browser lets it be (about 600px), the whole popup scrolls: the document,
// never a box inside it.
//
// V3 only: a configured 2.x build shows the legacy popup.
const configured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
test.use({ settingsProfile: configured ? "fresh" : "modern" });

async function openPopup(page: Page, extensionId: string, height: number) {
  await page.setViewportSize({ width: 380, height });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('.app[data-density="compact"]')).toBeVisible();
}

async function expandYouTube(page: Page) {
  const expander = page.getByRole("button", { name: "YouTube Blocker" });
  await expander.click();
  await expect(expander).toHaveAttribute("aria-expanded", "true");
  // Let the section's opening animation finish before measuring.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** Every element inside the popup that scrolls its own content vertically. */
function innerScrollers(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".still-ui, .still-ui *")]
      .filter((element) => {
        const overflowY = getComputedStyle(element).overflowY;
        return (
          (overflowY === "auto" || overflowY === "scroll") &&
          element.scrollHeight > element.clientHeight + 1
        );
      })
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 80)),
  );
}

test.describe("the popup's site list (ISS-0098)", () => {
  test.skip(configured, "The V3 popup runs in unconfigured builds only");

  test("an expanded site fits in the popup with no inner scroll box", async ({ page, extensionId }) => {
    await openPopup(page, extensionId, 600);
    await expandYouTube(page);
    const list = page.locator(".site-scroll");
    expect(await list.evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
    expect(await innerScrollers(page)).toEqual([]);
    const panel = page.locator("#site-youtube-panel");
    for (const name of ["Comments", "Live chat"]) {
      const row = panel.locator(".option-row", { hasText: name });
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeInViewport({ ratio: 0.99 });
    }
    // The popup keeps its width.
    const width = await page
      .locator('.app[data-density="compact"]')
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(380);
  });

  test("past the popup's height limit the whole popup scrolls, not the site list", async ({ page, extensionId }) => {
    await openPopup(page, extensionId, 360);
    await expandYouTube(page);
    expect(await innerScrollers(page)).toEqual([]);
    const scroll = await page.evaluate(() => ({
      scrollHeight: document.scrollingElement!.scrollHeight,
      clientHeight: document.scrollingElement!.clientHeight,
    }));
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    const lastRow = page.locator("#site-youtube-panel .option-row").last();
    await lastRow.scrollIntoViewIfNeeded();
    await expect(lastRow).toBeInViewport({ ratio: 0.99 });
    // The document moved to show it; nothing inside the popup did.
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator(".site-scroll").evaluate((element) => element.scrollTop)).toBe(0);
  });
});
