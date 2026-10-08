// The T1 (real extension in real Chromium) cases that can be reached today. `id` is the frame id
// used by the frame-to-tier map (tests/visual/real/frames.json, owned by the frame-map change), and
// `reference` is the package PNG, relative to handoff/reference. Size and 2x come from the
// reference itself. `blocked` records a frame that needs something this runner does not have yet;
// it is reported as BLOCKED, never as a pass.
const BACKEND = "needs a configured backend and dedicated signed-in QA account with the required sync state";
const NO_GERMAN = "the build has no German strings";
const SITE_ACCESS =
  "needs Chrome site access withdrawn; chrome.permissions.remove refuses required host permissions and the harness cannot drive chrome://extensions";
const PAID = "needs a configured paid QA build and verified sandbox purchase; the local QA build keeps paid behavior off";

export const cases = [
  { id: "d01-01", reference: "d01-desktop-popup/01-light-pro-not-owned-457px-tall.png", theme: "light", recipe: "popup-fresh" },
  { id: "d01-03", reference: "d01-desktop-popup/03-fresh-install-collapsed-457px-tall.png", theme: "light", recipe: "popup-fresh" },
  { id: "d01-05", reference: "d01-desktop-popup/05-still-off-choices-kept-522px-tall.png", theme: "dark", recipe: "popup-still-off-expanded" },
  { id: "d01-10", reference: "d01-desktop-popup/10-long-text-de-522px-tall.png", theme: "light", blocked: NO_GERMAN },
  { id: "d01-11", reference: "d01-desktop-popup/11-focus-on-the-youtube-expander-457px-tall.png", theme: "light", recipe: "popup-focus-youtube-expander" },
  { id: "d01-06", reference: "d01-desktop-popup/06-checking-access-signed-in-syncing-531px-tall.png", theme: "light", blocked: BACKEND },
  { id: "d01-07", reference: "d01-desktop-popup/07-needs-verification-sync-failed-569px-tall.png", theme: "dark", blocked: BACKEND },
  { id: "d03-01", reference: "d03-extension-settings/01-signed-out-pro-not-owned-consent-not-asked-560-1180.png", theme: "light", recipe: "options-fresh-expanded" },
  { id: "d03-10", reference: "d03-extension-settings/10-still-off-choices-kept.png", theme: "dark", recipe: "options-still-off-youtube-card" },
  { id: "d03-11", reference: "d03-extension-settings/11-permission-needed-560-720.png", theme: "light", blocked: SITE_ACCESS },
  { id: "d03-03", reference: "d03-extension-settings/03-sync-failed-retry.png", theme: "light", blocked: BACKEND },
  { id: "d03-07", reference: "d03-extension-settings/07-checking-access.png", theme: "light", blocked: BACKEND },
  { id: "d03-08", reference: "d03-extension-settings/08-sharing-off-deletion-requested.png", theme: "dark", blocked: BACKEND },
  { id: "d03-12", reference: "d03-extension-settings/12-delete-account-dialog-560-720.png", theme: "dark", blocked: BACKEND },
  { id: "d03-14", reference: "d03-extension-settings/14-keyboard-focus-on-sign-in-560-900.png", theme: "dark", recipe: "options-focus-sign-in" },
  { id: "d14-01", reference: "d14-extension-first-run/01-chrome-just-installed-600-1000.png", theme: "light", recipe: "firstrun-fresh" },
  { id: "d14-07", reference: "d14-extension-first-run/07-keyboard-focus-on-allow-480-760.png", theme: "dark", blocked: SITE_ACCESS },
  { id: "d14-02", reference: "d14-extension-first-run/02-chrome-pinned-signed-in-consent-answered-600-1000.png", theme: "dark", blocked: BACKEND },
  { id: "gallery-28", reference: "system-gallery/28-browser.png", theme: "light", recipe: "tiktok-blocked" },
  { id: "gallery-29", reference: "system-gallery/29-confirmation.png", theme: "dark", recipe: "tiktok-confirmation" },
  { id: "d01-04", reference: "d01-desktop-popup/04-expanded-youtube-purchased-522px-tall.png", theme: "light", blocked: PAID },
];
