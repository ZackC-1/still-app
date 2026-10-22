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
