import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the two ways a browser-action popup gets its width wrong.
//
// Too narrow (the collapse, fixed 2026-07-24). A browser-action popup has NO predefined viewport:
// the browser derives the popup window's width FROM the rendered content. Anything relative in the
// popup's `inline-size` is therefore circular. `inline-size: min(380px, 100vw)` collapsed the popup
// to a one-character-wide sliver, and a plain `100%` does the same thing (measured at 69px in a
// real Chrome toolbar popup on 2026-09-08). Only a hard pixel width is safe.
//
// Too wide (the clipping, fixed 2026-09-08). The very same document is Safari's extension popup on
// iPhone, presented as a sheet at the device width. 380px overhangs a 375pt screen by 5px and a
// 320pt screen by 60px, and because the popup does not scroll sideways the controls on the right
// edge simply could not be reached. `max-inline-size: 100%` fixes that without touching the width:
// it is a percentage of the containing block, not of the viewport, and browsers ignore percentage
// maximums while measuring preferred width, so the desktop popup still measures 380px.
const here = dirname(fileURLToPath(import.meta.url));
const popupSource = readFileSync(
  resolve(here, "../../entrypoints/popup/PopupApp.svelte"),
  "utf8",
);
const tokens = readFileSync(
  resolve(here, "../../../core/src/ui/tokens.css"),
  "utf8",
);

const styleBlock = popupSource
  .slice(popupSource.indexOf("<style>"), popupSource.indexOf("</style>"))
  // Strip CSS comments. The explanatory comment on `.popup` deliberately names the units it warns
  // against, and those mentions must not trip the assertions below.
  .replace(/\/\*[\s\S]*?\*\//g, "");

// The width declaration only. The lookbehind keeps `max-inline-size` out of this match, since the
// two properties have opposite rules: the width must be absolute, the maximum must be relative.
const widthDeclaration = /(?<![-\w])inline-size:\s*([^;]+);/.exec(styleBlock)?.[1];

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
