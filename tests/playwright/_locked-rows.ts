import { expect, type Page } from "@playwright/test";

// ISS-0122 (owner, 22 Oct): while Still Pro is not owned, a locked row shows no switch, only its
// name and the Still Pro chip, on one line, on every surface, at every width down to a 375pt
// iPhone. A locked row is as tall as a free row on the same surface: 40px in the popups, 46px on
// the Settings page and in the app. Shared by locked-rows-one-line.spec.ts (the extension builds)
// and app-webview-v3-bundle.spec.ts (the Apple app's web view).

export interface MeasuredRow {
  readonly name: string;
  readonly access: string;
  /** The row's border box, divider included. */
  readonly height: number;
  /** Distinct line boxes the visible name takes. */
  readonly nameLines: number;
  /** A note under the name ("Search stays.") makes a row two lines tall by design. */
  readonly note: boolean;
  readonly switches: number;
  readonly chips: number;
  /** Vertical distance between the chip's centre and the name block's centre (null: no chip). */
  readonly chipOffset: number | null;
  /** The chip starts to the right of the name's text, on the name's own line (not wrapped under it). */
  readonly chipBeside: boolean | null;
}

/** Opens each site in turn and measures every option row it draws. */
export async function measureOptionRows(page: Page): Promise<MeasuredRow[]> {
  const expanders = page.locator("button.expander");
  const rows: MeasuredRow[] = [];
  const count = await expanders.count();
  expect(count, "the site list is drawn").toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const expander = expanders.nth(index);
    await expander.scrollIntoViewIfNeeded();
    if ((await expander.getAttribute("aria-expanded")) !== "true") await expander.click();
    await expect(expander).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
    );
    const panel = page.locator(`[id="${await expander.getAttribute("aria-controls")}"]`);
    rows.push(
      ...(await panel.locator(".option-row").evaluateAll((elements) =>
        elements.map((row) => {
          const box = row.getBoundingClientRect();
          const label = row.querySelector<HTMLElement>(".label")!;
          // One rect per line of each text node (an element's own box would count twice).
          const lines: DOMRect[] = [];
          const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(node);
            lines.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
          }
          const tops = new Set(lines.map((rect) => Math.round(rect.top)));
          const chip = row.querySelector<HTMLElement>(".lock-pro");
          const chipBox = chip?.getBoundingClientRect();
          const main = row.querySelector<HTMLElement>(".row-main")!.getBoundingClientRect();
          const nameRight = Math.max(...lines.map((rect) => rect.right));
          return {
            name: label.textContent!.trim(),
            access: row.getAttribute("data-access") ?? "",
            height: box.height,
            nameLines: tops.size,
            note: Boolean(row.querySelector(".sub")),
            switches: row.querySelectorAll('[role="switch"], input[type="checkbox"]').length,
            chips: row.querySelectorAll(".lock-pro").length,
            chipOffset: chipBox ? (chipBox.top + chipBox.bottom) / 2 - (main.top + main.bottom) / 2 : null,
            chipBeside: chipBox
              ? chipBox.left >= nameRight && chipBox.top < lines[0]!.bottom && chipBox.bottom > lines[0]!.top
              : null,
          };
        }),
      )),
    );
  }
  return rows;
}

/**
 * Every locked row: no switch, one chip beside the name (never wrapped under it), the name on one
 * line, and (rows without a note) the same height as the free rows on this surface, `height`.
 *
 * `nameWraps` lists the rows whose name alone is wider than the space the canvas chip leaves at
 * this width (for example "Explore recommendations", 184px at 15px, beside the 90px chip in the
 * 257px a 375pt iPhone app row has). Their name wraps inside its own column, the chip stays beside
 * it, and nothing else changes; the list is exact, so any other row that wraps fails.
 */
export function expectLockedRowsOnOneLine(
  rows: readonly MeasuredRow[],
  height: number,
  where: string,
  nameWraps: readonly string[] = [],
) {
  const locked = rows.filter((row) => row.access === "locked");
  const free = rows.filter((row) => row.access !== "locked" && !row.note);
  expect(locked.length, `${where}: locked rows drawn`).toBeGreaterThan(0);
  expect(free.length, `${where}: free rows drawn`).toBeGreaterThan(0);
  for (const row of free) expect(row.height, `${where}: free row ${row.name}`).toBeCloseTo(height, 0);
  for (const row of locked) {
    const label = `${where}: locked row ${row.name}`;
    expect(row.switches, `${label} has no switch`).toBe(0);
    expect(row.chips, `${label} has one Still Pro chip`).toBe(1);
    expect(row.chipBeside, `${label} chip beside the name`).toBe(true);
    expect(Math.abs(row.chipOffset!), `${label} chip centred on the name`).toBeLessThanOrEqual(1);
    const wraps = nameWraps.includes(row.name);
    expect(row.nameLines, `${label} name on ${wraps ? "two lines" : "one line"}`).toBe(wraps ? 2 : 1);
    if (!row.note && !wraps) expect(row.height, `${label} is a free row's height`).toBeCloseTo(height, 0);
  }
  for (const name of nameWraps)
    expect(locked.some((row) => row.name === name), `${where}: ${name} is drawn`).toBe(true);
}
