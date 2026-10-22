// Canvas fidelity, Safari popups (22 Oct 2026). The owner's screens canvas is the visual truth; these
// pin the build fixes that bring the shared popup parts onto it, measured board by board:
//  - P-Sites, locked Still Pro row (Safari-Popup-Locked, MacPopup-Locked; CH-96 option C): the
//    dimmed saved switch comes first, then a bordered "Still Pro" pill 32px tall; the label keeps its
//    normal ink and the row keeps the 40px compact height.
//  - P-Sites, open site: 6px under the last option row.
//  - P-PopupSync / P-AppSync (owner canvas ruling, 22 Oct): "Still Pro on this device" is grey on
//    every surface, only "Still Pro User" is green; the tag's line height is 1.4 (a 20.8px box),
//    so its heading row is not 1.2px short.
//  - P-PopupSync on every desktop popup: no 4px gap under "Settings sync".
//  - Review follow-ups: a locked row keeps a 120px name at large text (F-1); a dormant pill does not
//    look clickable (F-3).
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import FeatureRow from "./FeatureRow.svelte";
import StillProTag from "./StillProTag.svelte";

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");
const css = source("design/tokens/components.css");
const rule = (selector: string) =>
  css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
const styleBlock = (file: string) => {
  const text = source(file);
  return text.slice(text.indexOf("<style>"), text.indexOf("</style>"));
};

function lockedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "youtube.comments" as const,
    label: "Comments",
    state: "locked" as const,
    checked: true,
    inactive: false,
    unsupportedText: "Not available in Safari. Your choice is saved.",
    onChange: vi.fn(),
    onLock: vi.fn(),
    host: "safari" as const,
    ...overrides,
  };
}

describe("canvas: the locked Still Pro row", () => {
  it("draws the saved switch before the Still Pro chip", () => {
    render(FeatureRow, { props: lockedRow() });
    const control = screen.getByRole("switch", { name: "Comments" });
    const chip = screen.getByRole("button", { name: /^Comments\. Included in Still Pro\./ });
    expect(control.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(control.parentElement).toBe(chip.parentElement);
    expect(control.parentElement).toHaveClass("locked-controls");
  });

  it("keeps the label in normal ink while only the switch is dimmed", () => {
    const { container } = render(FeatureRow, { props: lockedRow() });
    const row = container.querySelector(".option-row");
    expect(row).toHaveAttribute("data-access", "locked");
    expect(row).not.toHaveAttribute("data-inactive");
    expect(styleBlock("FeatureRow.svelte")).toMatch(
      /\.locked-controls :global\(\.toggle\[aria-disabled="true"\]\) \{\s*opacity: 0\.45;\s*\}/,
    );
  });

  it("still mutes a locked row that is otherwise inactive, and the dormant lock-only row", () => {
    const off = render(FeatureRow, { props: lockedRow({ inactive: true }) });
    expect(off.container.querySelector(".option-row")).toHaveAttribute("data-inactive", "true");
    off.unmount();
    const dormant = render(FeatureRow, { props: lockedRow({ dormant: true }) });
    expect(dormant.container.querySelector(".option-row")).toHaveAttribute("data-inactive", "true");
  });

  it("styles the chip as the canvas pill: 32px, bordered, 13px semibold ink", () => {
    const chip = rule(".option-row .lock-pro");
    for (const declaration of [
      "gap: 6px;",
      "min-block-size: 32px;",
      "padding: 4px 10px;",
      "border: 1px solid var(--border-strong);",
      "border-radius: 999px;",
      "font-size: calc(13px * var(--text-scale, 1));",
      "font-weight: 600;",
      "color: var(--ink);",
    ])
      expect(chip).toContain(declaration);
    // The visible pill is 32px; the hit area stays a full tap target without growing the row.
    expect(chip).not.toContain("min-block-size: var(--tap-target)");
    // Scrolled into view, a pill is never left a fraction of a pixel under the page's edge.
    expect(chip).toContain("scroll-margin-block: var(--space-1);");
    // The shared hit-area ::before (one pattern with the Help links), reaching 6px past the pill.
    expect(rule(":is(.card-stack.help .link, .option-row .lock-pro)::before")).toContain(
      "inset-block: max(calc(-1 * var(--hit-reach, 22px)), min(0px, calc((var(--tap-target) - 100%) / -2)));",
    );
    expect(chip).toContain("--hit-reach: 6px;");
    expect(styleBlock("FeatureRow.svelte")).toMatch(/\.locked-controls \{[^}]*gap: var\(--space-3, 12px\);/);
  });
});

describe("canvas: an open site section", () => {
  it("leaves 6px under the last option row", () => {
    expect(rule(".service-options .list")).toMatch(/padding: 0 var\(--service-card-padding-inline, var\(--space-4\)\) 6px /);
  });
});

describe("canvas: the Still Pro tag", () => {
  it("is green only for Still Pro User, grey for device provenance (owner ruling, 22 Oct)", () => {
    const account = render(StillProTag, { props: { kind: "account" } });
    expect(screen.getByText("Still Pro User")).toHaveClass("access-tag", "boxed", "success", "still-pro-tag");
    account.unmount();
    render(StillProTag, { props: { kind: "device" } });
    const device = screen.getByText("Still Pro on this device");
    expect(device).toHaveClass("access-tag", "boxed", "still-pro-tag");
    expect(device).not.toHaveClass("success");
    // The neutral boxed tag is the secondary ink with the strong border.
    expect(rule(".access-tag")).toContain("color: var(--ink-secondary);");
    expect(rule(".access-tag.boxed")).toContain("border: 1px solid var(--border-strong);");
  });

  it("uses the canvas line height so the heading row keeps its height", () => {
    expect(rule(".still-pro-tag")).toContain("line-height: 1.4;");
    // Declared after .access-tag (line height 1.3) so it wins at equal specificity.
    expect(css.indexOf(".still-pro-tag {")).toBeGreaterThan(css.indexOf(".access-tag {"));
  });
});

describe("canvas: the desktop popup's sync heading", () => {
  it("adds no space under Settings sync on any desktop popup path", () => {
    // The shared heading rule has no margin; DesktopPopup no longer adds 4px of its own (it applied
    // to the Safari Mac popup and to a configured build that mounts DesktopPopup directly; only the
    // d28 InvitedDesktopPopup path had overridden it). Review F-4 (22 Oct).
    expect(rule(".sync-row-title")).toContain("margin: 0;");
    expect(styleBlock("DesktopPopup.svelte")).not.toMatch(/\.sync-row-title/);
    // #521's grid-only override is redundant once no surface adds the margin.
    expect(css).not.toMatch(/\.sync-row\.pro-signed-out \.sync-row-title/);
  });
});

describe("canvas: locked rows at large text (review F-1)", () => {
  it("lets the saved switch and pill wrap under a name that would get less than 120px", () => {
    expect(rule('.option-row[data-access="locked"]')).toContain("flex-wrap: wrap;");
    expect(rule('.option-row[data-access="locked"] .row-main')).toContain("flex: 1 1 120px;");
    const row = styleBlock("FeatureRow.svelte");
    expect(row).toMatch(/\.locked-controls \{[^}]*margin-inline-start: auto;/);
    // 32px pill + 3px above and below fits inside the 40px compact row (39px inside its border).
    expect(row).toMatch(/\.locked-controls \{[^}]*margin-block: 3px;/);
  });
});

describe("canvas: the dormant Still Pro pill (review F-3)", () => {
  it("does not look clickable while it has no destination", () => {
    expect(rule('.option-row .lock-pro[aria-disabled="true"]')).toContain("cursor: default;");
    expect(rule('.option-row .lock-pro[aria-disabled="true"]:hover')).toContain(
      "border-color: var(--border-strong);",
    );
    const dormant = render(FeatureRow, { props: lockedRow({ dormant: true }) });
    expect(dormant.container.querySelector(".lock-pro")).toHaveAttribute("aria-disabled", "true");
  });
});

// Owner rulings R1 and R2 on the canvas fidelity report (22 Oct): every popup (Safari iPhone,
// Safari Mac, Chrome/Firefox) takes the canvas hero inset and footer.
describe("canvas: the popup hero (R1)", () => {
  it("insets the hero's title and switch 16px from its sides, popups only", () => {
    expect(rule('.app[data-density="compact"] .hero.compact')).toContain("padding-inline: var(--space-4);");
    // The Settings page and the Apple app (not compact density) keep their own hero.
    expect(rule(".hero.compact")).not.toContain("padding-inline");
  });
});

describe("canvas: the popup footer (R2)", () => {
  it("draws its links at 14px with 4px above and below", () => {
    const footer = rule(".popup-footer");
    expect(footer).toContain("font-size: calc(14px * var(--text-scale, 1));");
    expect(footer).toContain("padding-block: var(--space-1);");
    expect(footer).toContain("padding-inline: var(--space-4);");
  });
});
