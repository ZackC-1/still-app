import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The owner's screens canvas, Chrome-Settings-* boards (fidelity check of 22 Oct 2026). jsdom does
// not lay out, so this pins the options frame's rules: the shared settings column pads itself by
// 16px, and the page adds at most 16px, so the first card sits 32px down; full-width buttons are
// 44px tall on this page (owner ruling: 54px in the Apple apps, 44px in Chrome and Firefox).

const here = dirname(fileURLToPath(import.meta.url));
const css = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(join(here, "../OptionsApp.svelte"), "utf8"))?.[1] ?? "";
const options = /\.options\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

describe("Chrome and Firefox Settings page frame", () => {
  it("adds at most 16px above and below the settings column", () => {
    expect(options).toMatch(/padding-block:\s*clamp\(0px, calc\(5vh - var\(--space-4\)\), var\(--space-4\)\)/);
  });

  it("makes full-width buttons 44px tall (the shared minimum) with 8px around the label", () => {
    expect(options).toMatch(/--block-button-padding:\s*var\(--space-2\) var\(--space-4\)/);
  });
});
