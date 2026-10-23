import type { Page } from "@playwright/test";
import { test, expect } from "./_extension.js";

// ISS-0124: "6-digit" wrapped as "6-" / "digit" in the sign-in consent line. The copy now uses a
// non-breaking hyphen (U+2011), which the bundled Inter draws. Measured in the real built extension
// because jsdom has no layout: across a sweep of page widths the token is always on one line, and
// at some width it moves to the next line whole, which shows the sweep crossed the wrap point.
//
// Lane-aware, like sign-in-sheet-dismiss.spec.ts: only builds with a sign-in server show the sheet.
const SIGN_IN_BUILT =
  process.env.STILL_TEST_SYNC_CONFIGURED === "true" || process.env.STILL_EXPECT_MODERN_SIGN_IN === "1";

const NBH_TOKEN = "6‑digit";

interface Placement {
  /** Each occurrence: how many line boxes it spans, and whether it starts a line after the first. */
  tokens: { lines: number; wrappedWhole: boolean }[];
  plainHyphen: boolean;
}

/** Where every "6‑digit" in the open dialog falls at the current width. */
async function placements(page: Page): Promise<Placement> {
  return page.getByRole("dialog").evaluate((dialog, token) => {
    const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
    const tokens: { lines: number; wrappedWhole: boolean }[] = [];
    let plainHyphen = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (/6-digit/.test(text)) plainHyphen = true;
      for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + token.length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        const block = node.parentElement!.getBoundingClientRect();
        const first = range.getClientRects()[0];
        const lineHeight = parseFloat(getComputedStyle(node.parentElement!).lineHeight) || 20;
        tokens.push({
          lines: tops.size,
          // Starts at the paragraph's left edge, below its first line: the whole token wrapped.
          wrappedWhole: Math.abs(first.left - block.left) < 1 && first.top - block.top > lineHeight / 2,
        });
      }
    }
    return { tokens, plainHyphen };
  }, NBH_TOKEN);
}

test.describe("“6‑digit” never breaks across lines (ISS-0124)", () => {
  test.skip(!SIGN_IN_BUILT, "Needs a build with sign-in (the configured lane)");

  test("Settings sign-in: consent line and email prompt keep 6‑digit together at every width", async ({
    context,
    extensionId,
  }) => {
    await context.route(/^https?:/, (route) => route.abort());
    const page = await context.newPage();
    await page.setViewportSize({ width: 380, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.getByRole("button", { name: /^Sign in/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const steps: string[] = [];
    const consent = page.getByRole("dialog").getByRole("button", { name: "Continue" });
    if (await consent.count()) steps.push("consent");
    steps.push("email");

    for (const step of steps) {
      if (step === "email" && steps[0] === "consent") {
        await page.setViewportSize({ width: 380, height: 640 });
        await consent.click();
        await expect(page.getByLabel("Email address")).toBeVisible();
      }
      let wrappedWhole = false;
      for (let width = 240; width <= 420; width += 2) {
        await page.setViewportSize({ width, height: 640 });
        const placed = await placements(page);
        expect(placed.plainHyphen, `${step} at ${width}px has a plain "6-digit"`).toBe(false);
        expect(placed.tokens.length, `${step} at ${width}px names the 6‑digit code`).toBeGreaterThan(0);
        for (const token of placed.tokens) {
          expect(token.lines, `${step} at ${width}px splits 6‑digit across lines`).toBe(1);
          wrappedWhole ||= token.wrappedWhole;
        }
      }
      expect(wrappedWhole, `${step}: the sweep never moved 6‑digit to a new line`).toBe(true);
    }
  });
});
