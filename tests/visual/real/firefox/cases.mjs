// Firefox T1 frames. `gated` frames decide pass or fail with the V1 gate (2x, differing pixels * 200
// <= total pixels, no masks, no reference edits). `info` frames are CHROME reference frames shown
// against the Firefox build for cross-engine information only: they are reported, never counted as
// a Firefox pass or fail, because the references were drawn for Chrome (for example the pin step
// reads differently in Firefox). `blocked` frames cannot be reached, with the reason.
const OWNER_ASSISTED =
  "needs a trusted click on Allow (QA-P0 item 2): BiDi has no input on extension pages and release Firefox's chrome scope cannot synthesize one. Owner-assisted capture (question Q9) or component-only";

export const cases = [
  {
    id: "d14-03",
    reference:
      "d14-extension-first-run/03-firefox-permission-needed-420-960.png",
    theme: "light",
    recipe: "firstrun-permission-needed",
    mode: "gated",
    // Measured 2026-10-05: the reference draws a 74 px (device) browser-tab header the page does not have, which pushes
    // everything down; a combined email-and-usage consent card the product no longer has; the old sync wording
    // ("every device and browser", owner-approved wording is "every supported surface"); and an enabled Sign in
    // button where the unconfigured build shows it inert. Aligned and without the header and the card, the page
    // differs by 0.678% (6,695 of 987,840 px), the copy and the Sign in button. No renderer or layout defect.
    causes:
      "reference content the product lacks (tab header strip, combined consent card, enabled Sign in on an unconfigured build) plus owner-approved sync wording",
  },
  {
    id: "d14-04",
    reference: "d14-extension-first-run/04-firefox-waiting-420-960.png",
    theme: "dark",
    mode: "blocked",
    reason: OWNER_ASSISTED,
  },
  {
    id: "d14-05",
    reference: "d14-extension-first-run/05-firefox-not-allowed-420-960.png",
    theme: "light",
    mode: "blocked",
    reason: OWNER_ASSISTED,
  },
  {
    id: "d01-08",
    reference:
      "d01-desktop-popup/08-firefox-autoplay-unavailable-522px-tall.png",
    theme: "light",
    mode: "blocked",
    reason:
      "no product state: the V3 popup has no Firefox 'Autoplay unavailable' branch (Autoplay prevention is a locked Pro row on every browser); owner question",
  },
  {
    id: "d14-01",
    reference: "d14-extension-first-run/01-chrome-just-installed-600-1000.png",
    theme: "light",
    recipe: "firstrun-fresh",
    mode: "info",
  },
  {
    id: "d01-01",
    reference: "d01-desktop-popup/01-light-pro-not-owned-457px-tall.png",
    theme: "light",
    recipe: "popup-fresh",
    mode: "info",
  },
  {
    id: "d01-03",
    reference: "d01-desktop-popup/03-fresh-install-collapsed-457px-tall.png",
    theme: "light",
    recipe: "popup-fresh",
    mode: "info",
  },
  {
    id: "d01-05",
    reference: "d01-desktop-popup/05-still-off-choices-kept-522px-tall.png",
    theme: "dark",
    recipe: "popup-still-off",
    mode: "info",
  },
  {
    id: "d03-01",
    reference:
      "d03-extension-settings/01-signed-out-pro-not-owned-consent-not-asked-560-1180.png",
    theme: "light",
    recipe: "options-fresh",
    mode: "info",
  },
  {
    id: "d03-10",
    reference: "d03-extension-settings/10-still-off-choices-kept.png",
    theme: "dark",
    recipe: "options-still-off",
    mode: "info",
  },
  {
    id: "gallery-28",
    reference: "system-gallery/28-browser.png",
    theme: "light",
    recipe: "tiktok-blocked",
    mode: "info",
  },
];
