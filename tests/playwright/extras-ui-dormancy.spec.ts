import { test, expect } from "./_extension.js";
import type { Page } from "@playwright/test";
import { EXTRAS_CONTROLS } from "../../packages/core/src/rules/__tests__/extras-fixtures.js";
import { setAllExtras } from "./_extras-helpers.js";

// The UI half of A4 on the SHIPPED Chromium build, paid tier off. With all 12 extras committed On,
// no extras row may render as an enabled switch and nothing on the page may offer a purchase.
// Accepts either today's state ("unsupported": a note and no control) or the locked state of owner
// decision 24 (a lock and "Still Pro", never a purchase). It forbids an enabled switch and any
// Buy, price or purchase entry. Which of the two states shows is not asserted here.

const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
test.skip(
  syncConfigured,
  "Format-2 lane needs committed schema-2 settings; configured builds stay on the legacy lane",
);

test.use({ settingsProfile: "modern" });

// The 12 row names as the registry spells them (the UI may relabel, but only to these).
const ROW_NAMES = [
  "Related videos", "End-of-video suggestions", "Autoplay prevention", "Comments", "Live chat",
  "Explore recommendations", "Stories and Highlights", "Suggested accounts", "Threads links",
  "Facebook Stories", "Videos and Watch", "Desktop sidebar ads",
] as const;

const PURCHASE_WORDS = /\b(buy|purchase|purchased|upgrade|subscribe|checkout|price|pricing)\b|[$€£]\s?\d|\d\s?(usd|eur|gbp)\b/i;

async function openExpanded(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator("body")).toContainText("Still is");
  // Service sections may start collapsed; open them all so every row is in the DOM.
  for (const toggle of await page.getByRole("button", { name: /^(YouTube|Instagram|Facebook) Blocker/ }).all())
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await page.waitForTimeout(300);
}

for (const surface of ["options", "popup"] as const)
  test(`dormant UI: ${surface} shows no enabled switch for the 12 extras and no purchase entry`, async ({ context, extensionId }) => {
    await setAllExtras(context, extensionId, true);
    const page = await context.newPage();
    await openExpanded(page, `chrome-extension://${extensionId}/${surface}.html`);

    let found = 0;
    for (const name of ROW_NAMES) {
      const row = page.locator(".option-row").filter({ has: page.locator(".label", { hasText: new RegExp(`^${name}$`) }) });
      const count = await row.count();
      expect(count, `${name} appears at most once`).toBeLessThanOrEqual(1);
      if (count === 0) continue;
      found++;
      // No interactive switch or checkbox that is enabled, whether or not it is checked.
      const controls = await row.locator('[role="switch"], input[type="checkbox"]').evaluateAll((nodes) =>
        nodes.map((node) => ({
          enabled: !(node as HTMLButtonElement).disabled && node.getAttribute("aria-disabled") !== "true",
          checked: node.getAttribute("aria-checked") === "true" || (node as HTMLInputElement).checked === true,
        })),
      );
      for (const control of controls) expect(control.enabled, `${name} must not be an enabled switch`).toBe(false);
      expect(controls.filter((c) => c.checked && c.enabled), `${name}: no interactive checked control`).toEqual([]);
      // A locked row may offer "Still Pro"; it must not be a purchase.
      const rowText = (await row.innerText()).replace(/\s+/g, " ");
      expect(rowText, `${name} row text`).not.toMatch(PURCHASE_WORDS);
    }
    // Options lists every row today. The popup may fold them away; either way none misbehaves.
    if (surface === "options") expect(found, "every extras row was inspected").toBe(ROW_NAMES.length);
    expect(EXTRAS_CONTROLS).toHaveLength(12);

    // No purchase control or wording anywhere on the page.
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(text, "page text offers no purchase").not.toMatch(PURCHASE_WORDS);
    const controls = await page.locator("button, a, [role='button'], [role='link'], input[type='submit']").evaluateAll((nodes) =>
      nodes.map((n) => `${n.textContent ?? ""} ${n.getAttribute("aria-label") ?? ""} ${n.getAttribute("href") ?? ""}`.replace(/\s+/g, " ").trim()),
    );
    for (const label of controls) expect(label, `control "${label}"`).not.toMatch(PURCHASE_WORDS);
    expect(page.url()).toContain(`/${surface}.html`);
  });
