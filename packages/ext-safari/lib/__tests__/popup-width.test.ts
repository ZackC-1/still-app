import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the two ways a browser-action popup gets its width wrong. See the Chromium
// twin of this test for the full explanation. In short: the popup's `inline-size` must be a hard
// pixel value, because the browser derives the popup window's width from the content and anything
// relative there is circular; and `max-inline-size` must be `100%`, because this same document is
// the extension sheet in Safari on iPhone, where 380px overhangs a 375pt screen by 5px and a 320pt
// screen by 60px and the controls on the right edge cannot be reached.
const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(
  resolve(here, "../../../core/src/ui/tokens.css"),
  "utf8",
);

// Both popup documents: the legacy popup and the opted-in V3 popup host (U12-W4), which keeps its
// own copy of the same rule because the legacy file must stay byte-identical.
describe.each([
  "../../entrypoints/popup/PopupApp.svelte",
  "../../entrypoints/popup/SafariV3Popup.svelte",
])("%s", (file) => {
  const popupSource = readFileSync(resolve(here, file), "utf8");

  const styleBlock = popupSource
    .slice(popupSource.indexOf("<style>"), popupSource.indexOf("</style>"))
    // Strip CSS comments. The explanatory comment on `.popup` deliberately names the units it warns
    // against, and those mentions must not trip the assertions below.
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // The width declaration only. The lookbehind keeps `max-inline-size` out of this match, since the
  // two properties have opposite rules: the width must be absolute, the maximum must be relative.
  const widthDeclaration = /(?<![-\w])inline-size:\s*([^;]+);/.exec(
    styleBlock,
  )?.[1];

  describe("popup sizing", () => {
    it("has a <style> block", () => {
      expect(styleBlock).toContain(".popup");
    });

    it("sizes the popup with a pixel width, directly or through the shared token", () => {
      expect(widthDeclaration).toBeDefined();
      expect(widthDeclaration).toMatch(
        /^(\d+px|var\(--popup-inline-size,\s*\d+px\))$/,
      );
    });

    it("takes that width from a token that is itself a pixel value", () => {
      // The popup names the token with a pixel fallback, so the popup file alone cannot prove the
      // width is absolute. Pin the token too, or a relative value could be introduced one file away.
      expect(tokens).toMatch(/--popup-inline-size:\s*\d+px;/);
    });

    it("never uses viewport units to size the popup (they collapse to a sliver)", () => {
      // The WHOLE viewport-unit family collapses a popup, not just vw/vh: vmin/vmax and the
      // dynamic/small/large variants (dvw, svw, lvw, dvh, …) and vi/vb all resolve against a
      // viewport that is ~0 during the popup's content-measurement pass. Reject any of them.
      expect(styleBlock).not.toMatch(/\d\s*[sdl]?v(?:w|h|i|b|min|max)\b/i);
    });

    it("clamps the popup to the surface it is given, so it fits the smallest phone", () => {
      // Without this the popup keeps its full 380px on a 320pt or 375pt iPhone screen and the
      // switches on the right edge are cut off, with no sideways scrolling to reach them.
      expect(styleBlock).toMatch(/max-inline-size:\s*100%;/);
    });
  });
});

// The iPhone extension sheet (VD-11): Safari gives the sheet the screen's width, so the V3 popup
// fills it edge to edge, as D02 draws it. The rule must never become a width the popup derives from
// its own viewport (the 2026-07 sliver), so it is a percentage MINIMUM over the fixed pixel width,
// applied only when safariPopupFillsSheet says this is a phone sheet.
describe("SafariV3Popup on the iPhone sheet", () => {
  const source = readFileSync(resolve(here, "../../entrypoints/popup/SafariV3Popup.svelte"), "utf8");
  const style = source
    .slice(source.indexOf("<style>"), source.indexOf("</style>"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const sheetRule = /\.popup\.edge-to-edge\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";

  it("fills the sheet with a percentage minimum only", () => {
    expect(sheetRule).toMatch(/^\s*min-inline-size:\s*100%;\s*$/);
  });

  it("keeps the fixed pixel width underneath, so a measuring pass cannot collapse it", () => {
    expect(sheetRule).not.toMatch(/(?<![-\w])inline-size:/);
    expect(/\.popup\s*\{[^}]*(?<![-\w])inline-size:\s*var\(--popup-inline-size,\s*380px\)/.exec(style)).not.toBeNull();
  });

  it("applies the rule only through the phone-sheet decision", () => {
    expect(source).toMatch(/class:edge-to-edge=\{fillsSheet\}/);
    expect(source).toMatch(/safariPopupFillsSheet\(surface, globalThis\.screen\?\.width\)/);
  });

  it("uses a class the shared V3 stylesheet does not already style", () => {
    // A first attempt named it `.sheet`, which the design stylesheet styles as a fixed bottom sheet.
    const design = readFileSync(resolve(here, "../../../core/src/ui/v3/design/tokens/components.css"), "utf8");
    expect(design).not.toMatch(/\.edge-to-edge\b/);
  });
});
