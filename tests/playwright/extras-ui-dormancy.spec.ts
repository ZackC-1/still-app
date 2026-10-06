import { test, expect } from "./_extension.js";
import type { Page } from "@playwright/test";
import { EXTRAS_CONTROLS } from "../../packages/core/src/rules/__tests__/extras-fixtures.js";
import { offersPurchase, setAllExtras } from "./_extras-helpers.js";

// The UI half of A4 on the SHIPPED Chromium build, paid tier off. Two independent checks:
//
// 1. Rows (unconfigured lane only: it needs committed schema-2 settings). With all 12 extras
//    committed On, no extras row may render as an enabled switch. Each service section is opened
//    in turn (they are an accordion, so only one is ever open) and that service's rows are
//    checked while open; all 12 must be inspected on options AND popup. Accepts today's
//    "unsupported" state or the locked state of owner decision 24; forbids an enabled switch or
//    any purchase wording in a row.
// 2. Page-wide purchase scan (BOTH lanes). Nothing on options.html or popup.html may offer a
//    purchase. The configured build is where the purchase pieces actually exist, so this check
//    must not be skipped there.

const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";

// The 12 row names as the registry spells them, grouped by the service section that holds them.
const ROWS_BY_SERVICE = {
  YouTube: ["Related videos", "End-of-video suggestions", "Autoplay prevention", "Comments", "Live chat"],
  Instagram: ["Explore recommendations", "Stories and Highlights", "Suggested accounts", "Threads links"],
  Facebook: ["Facebook Stories", "Videos and Watch", "Desktop sidebar ads"],
} as const;

test("purchase matcher: approved copy passes, purchase offers fail", () => {
  expect(offersPurchase("Restore purchase")).toBe(false);
  expect(offersPurchase("Already purchased? Restore")).toBe(false);
  expect(offersPurchase("If you were charged, Restore purchase will find it.")).toBe(false);
  expect(offersPurchase("Buy Still Pro")).toBe(true);
  expect(offersPurchase("Buy Still Pro for $1.99")).toBe(true);
  expect(offersPurchase("Restore purchase. Buy Still Pro")).toBe(true);
  expect(offersPurchase("Only $1.99")).toBe(true);
  expect(offersPurchase("Upgrade to Still Pro")).toBe(true);
  expect(offersPurchase("Still Pro")).toBe(false);
  expect(EXTRAS_CONTROLS).toHaveLength(12);
});

async function openSection(page: Page, service: keyof typeof ROWS_BY_SERVICE) {
  const header = page.getByRole("button", { name: new RegExp(`^${service} Blocker`) });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

test.describe("extras rows (schema-2 lane)", () => {
  test.skip(
    syncConfigured,
    "Format-2 lane needs committed schema-2 settings; configured builds stay on the legacy lane",
  );
  test.use({ settingsProfile: "modern" });

  for (const surface of ["options", "popup"] as const)
    test(`dormant UI: ${surface} shows no enabled switch for the 12 extras`, async ({ context, extensionId }) => {
      await setAllExtras(context, extensionId, true);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${surface}.html`);
      await expect(page.locator("body")).toContainText("Still is");

      let inspected = 0;
      for (const [service, names] of Object.entries(ROWS_BY_SERVICE) as [keyof typeof ROWS_BY_SERVICE, readonly string[]][]) {
        await openSection(page, service);
        for (const name of names) {
          const row = page.locator(".option-row").filter({ has: page.locator(".label", { hasText: new RegExp(`^${name}$`) }) });
          await expect(row, `${name} is shown once while ${service} is open`).toHaveCount(1);
          await expect(row, `${name} is visible while ${service} is open`).toBeVisible();
          inspected++;
          const controls = await row.locator('[role="switch"], input[type="checkbox"]').evaluateAll((nodes) =>
            nodes.map((node) => ({
              enabled: !(node as HTMLButtonElement).disabled && node.getAttribute("aria-disabled") !== "true",
              checked: node.getAttribute("aria-checked") === "true" || (node as HTMLInputElement).checked === true,
            })),
          );
          for (const control of controls) expect(control.enabled, `${name} must not be an enabled switch`).toBe(false);
          expect(controls.filter((c) => c.checked && c.enabled), `${name}: no interactive checked control`).toEqual([]);
          // A locked row may offer "Still Pro"; it must not offer a purchase.
          expect(offersPurchase(await row.innerText()), `${name} row text offers no purchase`).toBe(false);
        }
      }
      expect(inspected, "every extras row was inspected").toBe(12);
    });
});

// Both lanes: the configured build is the one that carries the purchase pieces.
for (const surface of ["options", "popup"] as const)
  test(`dormant UI: ${surface} offers no purchase text or control anywhere`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${surface}.html`);
    await expect(page.getByRole("switch").first()).toBeVisible();
    await page.waitForTimeout(800); // let late-rendering cards (sign-in, Pro offers) appear

    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(text.length, "the page rendered").toBeGreaterThan(20);
    expect(offersPurchase(text), `page text offers no purchase: ${text}`).toBe(false);
    // Hidden panels have empty innerText; textContent also covers anything merely collapsed.
    const all = (await page.locator("body").evaluate((body) => body.textContent ?? "")).replace(/\s+/g, " ");
    expect(offersPurchase(all), "page textContent offers no purchase").toBe(false);
    const controls = await page.locator("button, a, [role='button'], [role='link'], input[type='submit']").evaluateAll((nodes) =>
      nodes.map((n) => `${n.textContent ?? ""} ${n.getAttribute("aria-label") ?? ""} ${n.getAttribute("href") ?? ""}`.replace(/\s+/g, " ").trim()),
    );
    for (const label of controls) expect(offersPurchase(label), `control "${label}"`).toBe(false);
    expect(page.url()).toContain(`/${surface}.html`);
  });
