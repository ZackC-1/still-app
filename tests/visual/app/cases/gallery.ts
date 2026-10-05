// System gallery (gallery/index.html): component specimens. Only the D29 TikTok blocked page
// frames belong to the V1 screen list; the rest are reported as outside it.
import type { ScreenCases } from "../types.js";

const D29_MISSING =
  "D29 TikTokBlocked has no merged V3 Svelte component on main (only legacy strings exist), so there is nothing to mount";

export const GALLERY: ScreenCases = {
  screen: "system-gallery",
  page: "gallery/index.html",
  cases: [],
  unmapped: {
    "28-browser.png": D29_MISSING,
    "29-confirmation.png": D29_MISSING,
    "30-iphone-safari-reload-needed.png": D29_MISSING,
  },
  defaultUnmappedReason:
    "gallery component specimen, not a V1 screen frame (screens are compared on their D-pages)",
};
