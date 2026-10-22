import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Canvas fidelity, Safari popups (22 Oct 2026), the host's own styles (SafariV3Popup.svelte):
//  - Safari-Popup-Locked / -ProOpen draw the iPhone popup growing to fit an open site. MobilePopup
//    caps the site list at 312px and the page at 600px, so an open Facebook or YouTube section was
//    an inner scroll box (TikTok cut off, the dividers squeezed to 0px). Like the Mac popup, the
//    phone popup now grows and the page itself scrolls past the sheet's height (ISS-0098 option B).
//  - MacPopup-Offline draws "Open the Still app to continue." as a raised, 12px-radius note inside
//    the popup's 12px inset: 8px 12px padding, 13px ink, 8px above the hero.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../SafariV3Popup.svelte"), "utf8");
const style = source
  .slice(source.indexOf("<style>"), source.indexOf("</style>"))
  .replace(/\/\*[\s\S]*?\*\//g, "");
const block = (selector: string) =>
  new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(style)?.[1] ?? "";

describe("SafariV3Popup on iPhone and iPad: the popup grows to fit an open site", () => {
  it("lifts the compact page cap", () => {
    expect(block('.popup:not(.desktop-popup) :global(.app[data-density="compact"])')).toMatch(
      /max-block-size:\s*none;/,
    );
  });

  it("never makes the site list a scroll box of its own", () => {
    const list = block('.popup:not(.desktop-popup) :global(.app[data-density="compact"] .site-scroll)');
    expect(list).toMatch(/flex:\s*none;/);
    expect(list).toMatch(/max-block-size:\s*none;/);
    expect(list).toMatch(/overflow-y:\s*visible;/);
  });

  it("takes no size from the viewport (the iPad popover measures its content)", () => {
    expect(block('.popup:not(.desktop-popup) :global(.app[data-density="compact"])')).not.toMatch(
      /min-block-size/,
    );
  });
});

describe("SafariV3Popup: the hand-off note", () => {
  it("is the canvas's raised note inside the popup inset", () => {
    const note = block(".handoff-failed");
    expect(note).toMatch(/margin:\s*var\(--space-3, 12px\) var\(--space-3, 12px\) 0;/);
    expect(note).toMatch(/padding:\s*var\(--space-2, 8px\) var\(--space-3, 12px\);/);
    expect(note).toMatch(/border-radius:\s*12px;/);
    expect(note).toMatch(/background:\s*var\(--surface-raised\);/);
    expect(note).toMatch(/font-size:\s*calc\(13px \* var\(--text-scale, 1\)\);/);
    expect(note).toMatch(/color:\s*var\(--ink, inherit\);/);
  });

  it("sits 8px above the hero", () => {
    expect(block(".handoff-failed + :global(.app)")).toMatch(/padding-block-start:\s*var\(--space-2, 8px\);/);
  });

  it("keeps the owner's wording", () => {
    expect(source).toContain('<p class="handoff-failed" role="alert">Open the Still app to continue.</p>');
  });
});
