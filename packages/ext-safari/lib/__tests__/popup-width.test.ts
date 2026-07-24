import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the popup width-collapse bug (fixed 2026-07-24). See the Chromium twin of
// this test for the full explanation: a browser-action popup has no predefined viewport, so a
// viewport unit (`100vw`) resolves to ~0 during the browser's content-measurement pass and the
// popup collapses to a one-character-wide sliver. The only reliable popup width is a hard pixel
// value.
const here = dirname(fileURLToPath(import.meta.url));
const popupSource = readFileSync(
  resolve(here, "../../entrypoints/popup/PopupApp.svelte"),
  "utf8",
);

const styleBlock = popupSource
  .slice(popupSource.indexOf("<style>"), popupSource.indexOf("</style>"))
  // Strip CSS comments — the explanatory comment on `.popup` deliberately names `100vw` to warn
  // future editors, and that mention must not trip the viewport-unit assertion below.
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("popup sizing", () => {
  it("has a <style> block", () => {
    expect(styleBlock).toContain(".popup");
  });

  it("sizes the popup with a fixed pixel width", () => {
    expect(styleBlock).toMatch(/inline-size:\s*\d+px/);
  });

  it("never uses viewport units to size the popup (they collapse to a sliver)", () => {
    // The WHOLE viewport-unit family collapses a popup, not just vw/vh: vmin/vmax and the
    // dynamic/small/large variants (dvw, svw, lvw, dvh, …) and vi/vb all resolve against a
    // viewport that is ~0 during the popup's content-measurement pass. Reject any of them.
    expect(styleBlock).not.toMatch(/\d\s*[sdl]?v(?:w|h|i|b|min|max)\b/i);
  });
});
