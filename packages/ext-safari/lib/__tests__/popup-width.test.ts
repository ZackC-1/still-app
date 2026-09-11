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
