// Canvas fidelity, Safari popups (22 Oct 2026). The owner's screens canvas is the visual truth; these
// pin the build fixes that bring the shared popup parts onto it, measured board by board:
//  - P-Sites, locked Still Pro row (Safari-Popup-Locked, MacPopup-Locked; CH-96 option C): the
//    dimmed saved switch comes first, then a bordered "Still Pro" pill 32px tall; the label keeps its
//    normal ink and the row keeps the 40px compact height.
//  - P-Sites, open site: 6px under the last option row.
//  - P-PopupSync / P-AppSync: "Still Pro on this device" is the neutral boxed tag, only "Still Pro
//    User" is green; the tag's line height is 1.4 (a 20.8px box), so its heading row is not 1.2px
//    short.
//  - P-PopupSync on the Mac Safari popup: no 4px gap under "Settings sync".
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
    expect(rule(".option-row .lock-pro::before")).toContain(
      "inset-block: min(0px, calc((var(--tap-target) - 100%) / -2));",
    );
    expect(styleBlock("FeatureRow.svelte")).toMatch(/\.locked-controls \{[^}]*gap: var\(--space-3, 12px\);/);
  });
});

describe("canvas: an open site section", () => {
  it("leaves 6px under the last option row", () => {
    expect(rule(".service-options .list")).toMatch(/padding: 0 var\(--service-card-padding-inline, var\(--space-4\)\) 6px /);
  });
});

describe("canvas: the Still Pro tag", () => {
  it("is green only for Still Pro User", () => {
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

describe("canvas: the Mac Safari popup's sync heading", () => {
  it("adds no space under Settings sync", () => {
    const style = styleBlock("DesktopPopup.svelte");
    expect(style).toMatch(/\.sync-row-title \{\s*margin: 0;\s*\}/);
    expect(style).not.toMatch(/margin: 0 0 4px/);
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
