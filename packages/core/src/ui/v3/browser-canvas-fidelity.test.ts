import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The owner's screens canvas, Chrome and Firefox popup boards (fidelity check of 22 Oct 2026). jsdom
// does not lay out, so these pin the style rules that put the popup on the canvas's measurements.

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");
const styleOf = (file: string) => {
  const match = /<style>([\s\S]*?)<\/style>/.exec(source(file));
  return match?.[1] ?? "";
};
const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
};

describe("Chrome and Firefox popup, canvas measurements", () => {
  it("draws the signed-in popup's plain Sign out at 14px (Chrome-Popup-SignedIn)", () => {
    const body = rule(styleOf("../App.svelte"), ".v3-popup-host .account .link.plain");
    expect(body).toMatch(/font-size:\s*calc\(14px \* var\(--text-scale, 1\)\)/);
    expect(body).toMatch(/line-height:\s*normal/);
  });

  it("spaces the sync and rating invitation card as drawn (Chrome-Popup-Invite, -Rating)", () => {
    const css = styleOf("PopupInvitation.svelte");
    expect(rule(css, "section.card-stack")).toMatch(/gap:\s*10px/);
    expect(rule(css, ".sync-row-sub")).toMatch(/line-height:\s*1\.4/);
    expect(rule(css, ".inline-actions")).toMatch(/column-gap:\s*var\(--space-4\)/);
    expect(rule(css, ".inline-actions > .primary.inline")).toMatch(/padding-inline:\s*14px/);
    const notNow = rule(css, ".inline-actions > .link");
    expect(notNow).toMatch(/font-size:\s*calc\(14px \* var\(--text-scale, 1\)\)/);
    expect(notNow).toMatch(/line-height:\s*normal/);
  });
});

describe("Help card and site expanders, canvas measurements (owner rulings B1 and B3, 22 Oct)", () => {
  const css = source("design/tokens/components.css");
  const line = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped} \\{([^}]*)\\}`, "m").exec(css)?.[1] ?? "";
  };

  it("draws the Help card at the canvas rhythm: 12px above and below, 10px between rows", () => {
    expect(line(".card-stack.help")).toContain("gap: 10px var(--space-4);");
    expect(line(".card-stack.help")).toContain("padding: var(--space-3) var(--space-4);");
  });

  it("keeps each Help link link-sized, with a hit area drawn by an invisible ::before", () => {
    expect(line(".card-stack.help .link")).not.toContain("min-block-size");
    expect(line(".card-stack.help .link")).toContain("position: relative;");
    const hit = line(":is(.card-stack.help .link, .option-row .lock-pro)::before");
    expect(hit).toContain('content: "";');
    expect(hit).toContain("position: absolute;");
    // Toward a 44px target, but never past half the 10px row gap: no link covers its neighbour.
    expect(hit).toContain("inset-block: max(calc(-1 * var(--hit-reach, 22px)), min(0px, calc((var(--tap-target) - 100%) / -2)));");
    expect(line(".card-stack.help")).toContain("--hit-reach: 5px;");
    // The address paints above Contact support's hit area, so a click selects it (ISS-0112).
    expect(line(".help-contact > .sync-row-sub")).toContain("position: relative;");
  });

  it("puts the support address 2px under Contact support, at the card's line height", () => {
    expect(line(".help-contact")).toContain("gap: 2px;");
    const address = line(".help-contact > .sync-row-sub");
    expect(address).toContain("line-height: 1.4;");
    expect(address).not.toContain("padding");
  });

  it("draws every site expander's chevron at 14px", () => {
    const chevron = line(".service-row .chevron");
    expect(chevron).toContain("inline-size: 14px;");
    expect(chevron).toContain("block-size: 14px;");
  });
});
