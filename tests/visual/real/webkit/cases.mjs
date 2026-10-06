// The T2 frames (QA plan §2.3/§2.4; docs FRAME-MAP T2 rows): the BUILT Safari extension pages and
// the BUILT Apple web view in WebKit, each inside the same review frame V1 draws for that
// reference (frame specs copied from tests/visual/app/cases/*.ts), with a recorded native state
// behind it (tests/qa/webkit/shim/states.ts) and real clicks or key presses where the frame needs
// them (./recipes.mjs).
//
//   id         frame id used by FRAME-MAP / frames.json
//   reference  the package PNG, relative to handoff/reference (size and 2x come from it)
//   page       the reference page whose review chrome styles the frame (as V1)
//   surface    "safari-popup" | "safari-options" | "app" (the built bundle under test)
//   state      the recorded native state
//   recipe     how the frame's state is reached on the page (./recipes.mjs)
//   screen     the device screen the page sees (window.screen), for frames depicting a phone/tablet
//   twin       set when the frame is not a Safari/Apple reference but the closest one (evidence,
//              reported like any other row, never counted as a required T2 frame)
//   blocked    the state cannot be reached on this lane; reported BLOCKED with the reason
//   evidenceOnly  the state is reached and captured, but the reference draws a different screen,
//              so no pixel verdict is claimed (reported BLOCKED with the reason and the capture)

const D02 = "d02-mobile-popup";
const D04 = "d04-apple-app-settings";
const D12 = "d12-apple-onboarding";
const D18 = "d18-d20-d24-d25-purchase-and-restore";

// Device screens (window.screen, portrait points) for the frames that depict a phone or tablet.
const SE_SCREEN = { width: 375, height: 667 };
const IPHONE15_SCREEN = { width: 393, height: 852 };
const IPAD_SCREEN = { width: 820, height: 1180 };

const iphoneSE = { kind: "device", device: "iphone", w: 375, h: 667, safeTop: 20 };
const iphone15 = { kind: "device", device: "iphone", w: 393, h: 852, safeTop: 59, safeBottom: 34 };
const popover = { kind: "device", device: "popover", w: 380, h: 600 };
const app15 = { kind: "device", device: "iphoneapp", w: 393, h: 852, safeTop: 59, safeBottom: 34 };
const ipadApp = { kind: "device", device: "ipadapp", w: 820, h: 760, safeTop: 24, safeBottom: 20 };
const mac = (w, h, extra = {}) => ({ kind: "device", device: "mac", w, h, ...extra });

const PAGES = {
  d01: "ui_kits/still-app/desktop-popup.html",
  d02: "ui_kits/still-app/d02-mobile-popup.html",
  d03: "ui_kits/still-app/d03-settings.html",
  d04: "ui_kits/still-app/d04-apple-settings.html",
  d12: "ui_kits/still-app/d12-apple-onboarding.html",
  d18: "ui_kits/still-app/d18-purchase.html",
};

const PAID = "needs a Pro purchase or a price, which both paid flags keep off (QA-only paid build, Q3)";
const TEXT_SCALE = "T0 only: no host binds --text-scale (QA plan §2.5, Q1)";
const NO_SIGN_IN =
  "needs a signed-in account; the V3 Safari screens are gated on the Apple app's atomic mode, which only an unconfigured app (no sign-in) can enter";
const NO_SETUP =
  "the Safari popup host supplies no setup observation (no verified Safari permission read exists; U12-W4 design §2.3), so this state never renders";
const NO_CONSENT =
  "this build skips the consent step: no approved purposes and no consent committer are wired (apple-onboarding.ts), so onboarding has three steps";
const NO_IOS_OBSERVATION =
  "iOS cannot observe whether the Safari extension is on (SafariSetupObservation is always \"unknown\" on iOS), so the app's setup card renders only on macOS with the extension off; the iPhone page is captured as evidence";
const PRO_PAGE =
  "the reference draws the Still Pro page, which is not mounted while the paid tier is off; the free-period Restore result is shown on the D04 settings page instead (captured as evidence)";

export const cases = [
  // ---- D02 Safari popup, iOS and iPadOS (MobilePopup) --------------------------------------
  { id: "d02-01", reference: `${D02}/01-iphone-se-fresh-install-375-667.png`, page: PAGES.d02, theme: "light", frame: iphoneSE, surface: "safari-popup", state: "ios-fresh", recipe: "ready", screen: SE_SCREEN },
  { id: "d02-03", reference: `${D02}/03-iphone-15-safari-pro-not-owned-393-852.png`, page: PAGES.d02, theme: "light", frame: iphone15, surface: "safari-popup", state: "ios-fresh", recipe: "expand-facebook", screen: IPHONE15_SCREEN },
  { id: "d02-08", reference: `${D02}/08-ipad-safari-popover-380-600.png`, page: PAGES.d02, theme: "light", frame: popover, surface: "safari-popup", state: "ipad-fresh", recipe: "expand-youtube", screen: IPAD_SCREEN },
  { id: "d02-04", reference: `${D02}/04-safari-permission-needed-375-667.png`, theme: "light", blocked: NO_SETUP },
  { id: "d02-07", reference: `${D02}/07-still-off-signed-in-sync-failed-393-852.png`, theme: "dark", blocked: NO_SIGN_IN },
  { id: "d02-02", reference: `${D02}/02-iphone-15-pro-bought-in-the-still-app-393-852.png`, theme: "dark", blocked: PAID },
  { id: "d02-06", reference: `${D02}/06-instagram-mixed-access-393-852.png`, theme: "light", blocked: PAID },
  { id: "d02-10", reference: `${D02}/10-iphone-se-xxxlarge-375-667-text-1-35.png`, theme: "light", blocked: TEXT_SCALE },
  { id: "d02-11", reference: `${D02}/11-iphone-se-accessibility-size-375-667-text-2.png`, theme: "dark", blocked: TEXT_SCALE },
  { id: "gallery-05", reference: "system-gallery/05-safari-popup-pro-not-owned.png", theme: "dark", blocked: "gallery specimen: gated through its real-host twin d02-03 (QA plan §2.4)" },
  { id: "gallery-19", reference: "system-gallery/19-safari-popup.png", theme: "dark", blocked: "gallery specimen: gated through its real-host twin d02-03 (QA plan §2.4)" },
  { id: "gallery-30", reference: "system-gallery/30-iphone-safari-reload-needed.png", theme: "light", blocked: "the Safari bundle has no TikTok blocked page (no tiktok-blocked.html in dist/safari-mv3); the iPhone Safari state needs the simulator lane (T3)" },

  // ---- Safari popup on macOS (DesktopPopup) and the Safari settings page: twins -------------
  // There is no Safari D01/D03 reference. The macOS popup passes the D01 browser value, so the
  // Chrome D01 frames are its closest references; the settings page is compared with D03-01.
  { id: "d01-03", twin: "macOS Safari popup vs the Chrome D01 reference", reference: "d01-desktop-popup/03-fresh-install-collapsed-457px-tall.png", page: PAGES.d01, theme: "light", frame: { kind: "popup" }, surface: "safari-popup", state: "mac-fresh", recipe: "ready" },
  { id: "d01-05", twin: "macOS Safari popup vs the Chrome D01 reference", reference: "d01-desktop-popup/05-still-off-choices-kept-522px-tall.png", page: PAGES.d01, theme: "dark", frame: { kind: "popup" }, surface: "safari-popup", state: "mac-still-off", recipe: "expand-youtube" },
  { id: "d03-01", twin: "Safari settings page vs the Chrome D03 reference", reference: "d03-extension-settings/01-signed-out-pro-not-owned-consent-not-asked-560-1180.png", page: PAGES.d03, theme: "light", frame: { kind: "device", device: "tab", w: 560, h: 1180, url: "Still · Settings" }, surface: "safari-options", state: "mac-fresh", recipe: "expand-youtube" },

  // ---- D04 Apple app settings (app-webview, AppleSettings) ----------------------------------
  { id: "d04-01", reference: `${D04}/01-iphone-15-safari-extension-off-393-852.png`, page: PAGES.d04, theme: "light", frame: app15, surface: "app", state: "app-iphone", recipe: "ready", evidenceOnly: NO_IOS_OBSERVATION, screen: IPHONE15_SCREEN },
  { id: "d04-04", reference: `${D04}/04-ipad-restore-couldn-t-finish-820-760.png`, page: PAGES.d04, theme: "light", frame: ipadApp, surface: "app", state: "app-ipad-restore-failed", recipe: "restore-then-expand-instagram", screen: IPAD_SCREEN },
  { id: "d04-06", reference: `${D04}/06-mac-keyboard-focus-on-the-still-switch-520-680.png`, page: PAGES.d04, theme: "light", frame: mac(520, 680, { title: "Still", cls: "kbd-hero" }), surface: "app", state: "app-mac", recipe: "focus-still-switch" },
  { id: "d04-08", reference: `${D04}/08-restore-nothing-found-393-852.png`, page: PAGES.d04, theme: "dark", frame: app15, surface: "app", state: "app-iphone-restore-none", recipe: "restore", screen: IPHONE15_SCREEN },
  { id: "d04-03", reference: `${D04}/03-iphone-15-waiting-for-apple-393-852.png`, theme: "light", blocked: PAID },
  { id: "d04-07", reference: `${D04}/07-link-confirm-account-393-852.png`, theme: "light", blocked: `${NO_SIGN_IN}; also needs a purchase to link (${PAID})` },
  { id: "d04-02", reference: `${D04}/02-iphone-15-pro-bought-link-invitation-393-852.png`, theme: "dark", blocked: PAID },
  { id: "d04-05", reference: `${D04}/05-mac-still-pro-needs-verification-720-680.png`, theme: "dark", blocked: PAID },
  { id: "d04-09", reference: `${D04}/09-iphone-15-xxxlarge-393-852-text-1-35.png`, theme: "light", blocked: TEXT_SCALE },
  { id: "d04-10", reference: `${D04}/10-iphone-15-accessibility-size-393-852-text-2.png`, theme: "dark", blocked: TEXT_SCALE },

  // ---- D12 Apple onboarding (app-webview, AppleOnboarding) ----------------------------------
  { id: "d12-01", reference: `${D12}/01-iphone-15-step-1-393-852.png`, page: PAGES.d12, theme: "light", frame: app15, surface: "app", state: "app-iphone-onboarding", recipe: "onboarding-step-1", screen: IPHONE15_SCREEN },
  { id: "d12-02", reference: `${D12}/02-iphone-15-step-2-393-852.png`, page: PAGES.d12, theme: "light", frame: app15, surface: "app", state: "app-iphone-onboarding", recipe: "onboarding-step-2", screen: IPHONE15_SCREEN },
  { id: "d12-04", reference: `${D12}/04-iphone-15-step-4-393-852.png`, page: PAGES.d12, theme: "light", frame: app15, surface: "app", state: "app-iphone-onboarding", recipe: "onboarding-last-step", screen: IPHONE15_SCREEN },
  { id: "d12-05", reference: `${D12}/05-iphone-15-step-1-393-852.png`, page: PAGES.d12, theme: "dark", frame: app15, surface: "app", state: "app-iphone-onboarding", recipe: "onboarding-step-1", screen: IPHONE15_SCREEN },
  { id: "d12-08", reference: `${D12}/08-ipad-step-2-820-760.png`, page: PAGES.d12, theme: "light", frame: ipadApp, surface: "app", state: "app-ipad-onboarding", recipe: "onboarding-step-2", screen: IPAD_SCREEN },
  { id: "d12-09", reference: `${D12}/09-mac-step-2-waiting-640-600.png`, page: PAGES.d12, theme: "light", frame: mac(640, 600), surface: "app", state: "app-mac-onboarding-off", recipe: "onboarding-step-2" },
  { id: "d12-10", reference: `${D12}/10-mac-step-2-on-640-600.png`, page: PAGES.d12, theme: "dark", frame: mac(640, 600), surface: "app", state: "app-mac-onboarding-on", recipe: "onboarding-step-2" },
  { id: "d12-03", reference: `${D12}/03-iphone-15-step-3-393-852.png`, theme: "light", blocked: NO_CONSENT },
  { id: "d12-06", reference: `${D12}/06-iphone-se-step-2-xxxlarge-375-667-text-1-35.png`, theme: "light", blocked: TEXT_SCALE },
  { id: "d12-07", reference: `${D12}/07-iphone-15-step-1-accessibility-size-393-852-text-2.png`, theme: "dark", blocked: TEXT_SCALE },

  // ---- D18 Apple purchase and Restore, paid tier off ----------------------------------------
  { id: "d18-17", reference: `${D18}/17-apple-checking-393-852.png`, page: PAGES.d04, theme: "light", frame: app15, surface: "app", state: "app-iphone-restore-pending", recipe: "restore", evidenceOnly: PRO_PAGE, screen: IPHONE15_SCREEN },
  { id: "d18-18", reference: `${D18}/18-apple-restored-393-852.png`, page: PAGES.d04, theme: "dark", frame: app15, surface: "app", state: "app-iphone-restore-restored", recipe: "restore", evidenceOnly: PRO_PAGE, screen: IPHONE15_SCREEN },
  { id: "d18-19", reference: `${D18}/19-apple-nothing-found-393-852.png`, page: PAGES.d04, theme: "light", frame: app15, surface: "app", state: "app-iphone-restore-none", recipe: "restore", evidenceOnly: PRO_PAGE, screen: IPHONE15_SCREEN },
  { id: "d18-02", reference: `${D18}/02-iphone-still-app-393-852.png`, theme: "dark", blocked: PAID },
  { id: "d18-03", reference: `${D18}/03-mac-still-app-560-760.png`, theme: "light", blocked: PAID },
  { id: "d18-05", reference: `${D18}/05-waiting-for-apple-393-852.png`, theme: "light", blocked: PAID },
  { id: "d18-16", reference: `${D18}/16-iphone-after-apple-393-852.png`, theme: "dark", blocked: PAID },
  { id: "d18-23", reference: `${D18}/23-iphone-se-xxxlarge-375-667-text-1-35.png`, theme: "light", blocked: TEXT_SCALE },
];
