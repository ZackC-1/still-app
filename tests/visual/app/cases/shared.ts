import type { Deviation } from "../types.js";

/**
 * Owner decision 2026-10-12 (ISS-0029), reworded in the owner's canvas review of 21 Oct 2026: the
 * sync line reads "Sync settings across devices and browsers. Free." on every screen.
 * Reference frames still carry the earlier "every device and browser" wording. The region is the
 * implementation element holding the new wording, so a failing frame reports how many differing
 * pixels sit on that line and how many remain elsewhere.
 */
export const OWNER_SYNC_COPY: Deviation = {
  reason:
    'owner-approved copy (sync line "Sync settings across devices and browsers. Free."; reference says "every device and browser")',
  text: "Sync settings across devices and browsers.",
};

/**
 * Owner's canvas review, 21 Oct 2026: the setup and site-access headers read "Still can’t block
 * distractions yet" (no full stop since the 22 Oct copy audit) where the references say "Still
 * can't block on these websites yet." (setup) or "Still can't work on these sites" (site access).
 */
export const OWNER_SETUP_HEADER_COPY: Deviation = {
  reason:
    'owner-approved copy (setup header "Still can’t block distractions yet", no full stop since the 22 Oct copy audit; reference says "Still can\'t block on these websites yet.")',
  text: "Still can’t block distractions yet",
};

/**
 * Owner's canvas review, 21 Oct 2026: the Safari popup's setup instructions quote the two labels
 * (choose “Still”, then “Always Allow on Every Website”), so the body line differs from the
 * reference and may wrap differently. The owner's iPhone check the same day (iOS 27, Safari) also
 * renamed the first step: Safari's extensions sit behind the button at the left of the address bar,
 * where the reference says "the extensions button".
 */
export const OWNER_SAFARI_SETUP_BODY: Deviation = {
  reason:
    "owner-approved copy (Safari setup instructions name “the button at the left of the address bar” and quote “Still” and “Always Allow on Every Website”; reference says “the extensions button” with no quotes)",
  text: "In Safari, tap the button at the left of the address bar",
};

/** The latest reference restores demo banners; their omission also moves subsequent cards. */
export const REFERENCE_DEMO_ACCOUNT: Deviation = {
  reason:
    "reference-only demonstration banner omitted from the real account card; account actions and subsequent cards flow upward",
  selector: ".card:has(.synced), .card:has(.synced) ~ .card",
};

/**
 * ISS-0032 (owner-approved design, 12 Oct 2026): a compact Still Pro card ("Even fewer distractions on
 * Instagram, Facebook and YouTube. One-time purchase." and Get Still Pro) replaces the reference's
 * plain "Purchase Still Pro" button under the site list, and the cards below it move down.
 */
export const POPUP_PRO_CARD: Deviation = {
  reason:
    "owner-approved Still Pro card replaces the reference's plain purchase button; later cards move down",
  selector: ".pro-entry, .pro-entry ~ *",
};

/**
 * ISS-0073 (owner-approved 16 Oct 2026): with Still Pro purchased, the sync card's account row
 * carries a small boxed "Still Pro" tag beside the address, or beside Sign in when signed out.
 * The reference frames predate it; the sync card (and anything after it) can move.
 */
export const STILL_PRO_TAG: Deviation = {
  reason:
    'owner-approved "Still Pro" tag in the sync card account row (ISS-0073); later content may move',
  selector: ".card:has(.still-pro-tag), .card:has(.still-pro-tag) ~ *",
};

/**
 * Owner's canvas review, 21 Oct 2026: the light-mode success green is darker (#145a38; the
 * references use #1a7046) so the small "Still Pro User" tag text reads at 4.5:1 or better on
 * screen. Every success-coloured element changes colour: the boxed Still Pro tags, success status
 * glyphs and the finished first-run step numbers. Dark mode is unchanged. Declared on every light
 * frame (index.ts); a frame without such an element measures 0 px here. The design source under
 * docs/design stays the owner's 3.0.1 archive the references were rendered from (its hashes are
 * pinned in latest-gallery-references.json), so its tokens keep #1a7046 until the references are
 * regenerated and reviewed.
 */
export const OWNER_SUCCESS_GREEN: Deviation = {
  reason:
    "owner-approved darker light-mode success green (#145a38; reference #1a7046) on Still Pro tags, success glyphs and finished first-run steps",
  selector:
    '.access-tag.boxed.success, .status-line[data-tone="success"] .glyph, .step[data-done="true"] .num',
};

/**
 * The 22 Oct 2026 copy audit and the owner's rulings on it. Each entry names only the lines this
 * change rewrote (curly apostrophes, no full stop on headings, no serial comma, "We couldn’t …"
 * errors and the owner's reworded lines), and the screens that can show it (index.ts attaches it
 * to those screens' frames only), so a layout change elsewhere in a card is never labelled as
 * approved copy. A frame that does not show the line measures 0 px.
 */
type AuditScreen =
  | "d01-desktop-popup"
  | "d02-mobile-popup"
  | "d03-extension-settings"
  | "d04-apple-app-settings"
  | "d12-apple-onboarding"
  | "d14-extension-first-run"
  | "d18-d20-d24-d25-purchase-and-restore"
  | "d28-rating-prompt"
  | "system-gallery";
const POPUPS: AuditScreen[] = ["d01-desktop-popup", "d02-mobile-popup", "d28-rating-prompt"];
const SETTINGS: AuditScreen[] = ["d03-extension-settings", "d04-apple-app-settings"];
const PRO: AuditScreen[] = [...SETTINGS, "d18-d20-d24-d25-purchase-and-restore", "system-gallery"];
const AUDIT_LINES: [string, string, AuditScreen[]][] = [
  ["Turn on the Still extension in Safari.", "extension-off line", ["d04-apple-app-settings", "d12-apple-onboarding"]],
  ["Tap “Open Settings” below.", "numbered step ends with a full stop", ["d04-apple-app-settings"]],
  ["then allow Instagram, Facebook, YouTube and TikTok.", "numbered step, no serial comma", ["d04-apple-app-settings"]],
  ["Close Safari, then reopen it.", "numbered step ends with a full stop", ["d04-apple-app-settings"]],
  ["Allowed on Instagram, Facebook, YouTube and TikTok.", "no serial comma", ["d14-extension-first-run"]],
  ["Verify purchase", "\"Verify purchase\" replaces \"Verify now\"", PRO],
  ["Your free controls keep working while this finishes.", "purchase view checking lines", ["d18-d20-d24-d25-purchase-and-restore"]],
  ["Enjoying Still?", "rating invitation heading", ["d28-rating-prompt", "system-gallery"]],
  ["Link Still Pro to your account", "linking offer heading and button", ["d04-apple-app-settings", "d28-rating-prompt", "system-gallery"]],
  ["Lifetime access. No subscription.", "purchase view terms", ["d18-d20-d24-d25-purchase-and-restore"]],
  ["Back to Still settings", "browser purchase view back link", ["d18-d20-d24-d25-purchase-and-restore"]],
  ["Back to Settings", "Apple purchase view back link", ["d18-d20-d24-d25-purchase-and-restore"]],
  ["Still Pro is ready. New controls start off, so turn on", "after-purchase line", PRO],
  ["New controls start off, so turn on the ones you want.", "after-purchase line", ["d18-d20-d24-d25-purchase-and-restore"]],
  ["Bought it with another account?", "browser restore not-found line", PRO],
  ["No Still Pro purchase was found for this Apple Account.", "Apple restore not-found line", ["d18-d20-d24-d25-purchase-and-restore"]],
  ["Not available in Safari.", "unavailable Still Pro row on Safari", ["d01-desktop-popup", "d02-mobile-popup", "system-gallery"]],
  ["Not available on this device.", "unavailable Still Pro row in the Apple app", ["d04-apple-app-settings"]],
  ["Helps improve Still.", "usage switch line", [...SETTINGS, "d14-extension-first-run", "system-gallery"]],
  ["Delete shared data from all your devices", "shared-data link matches its dialog", ["d03-extension-settings", "system-gallery"]],
  ["6-digit sign-in code", "both sign-in prompts", ["d18-d20-d24-d25-purchase-and-restore", "system-gallery"]],
  ["Sign in to get Still Pro", "purchase sign-in sheet title", ["d18-d20-d24-d25-purchase-and-restore", "system-gallery"]],
  ["Sign in first to keep Still Pro", "purchase sign-in sheet note", ["d18-d20-d24-d25-purchase-and-restore", "system-gallery"]],
  ["Checkout was canceled.", "US spelling", ["system-gallery"]],
  ["Still is on", "first-run heading without a full stop", ["d14-extension-first-run"]],
  ["One step to finish setup", "first-run heading without a full stop", ["d14-extension-first-run"]],
  ["TikTok stays closed", "TikTok page heading without a full stop", ["system-gallery"]],
  ["We couldn’t open TikTok.", "error line starts \"We couldn’t\"", ["system-gallery"]],
  ["Still settings", "popup footer button label", POPUPS],
  // Curly apostrophes, line by line.
  ["We couldn’t finish checking. Nothing changed.", "curly apostrophe", PRO],
  ["Still Pro can’t be bought here yet.", "curly apostrophe", PRO],
  ["Still Pro couldn’t be bought right now.", "curly apostrophe", PRO],
  ["Make sure you’re signed in to the App Store", "curly apostrophe", PRO],
  ["The purchase wasn’t confirmed.", "curly apostrophe", PRO],
  ["Still can’t check right now.", "curly apostrophe", ["d03-extension-settings"]],
  ["Try again when you’re online.", "curly apostrophe", ["d03-extension-settings"]],
  ["You’ll use this account to restore Still Pro", "curly apostrophe", PRO],
  ["It’s linked to another account.", "curly apostrophe", PRO],
  ["Linking didn’t finish.", "curly apostrophe", PRO],
  ["You’ll sign in first", "curly apostrophe", ["d18-d20-d24-d25-purchase-and-restore"]],
  ["We couldn’t confirm your payment yet.", "curly apostrophe", ["system-gallery"]],
  ["your setting doesn’t change.", "curly apostrophe", ["system-gallery"]],
  ["didn’t allow it.", "curly apostrophe", [...POPUPS, "d03-extension-settings", "d14-extension-first-run"]],
  ["Your choices start working once it’s allowed.", "shortened refused line (P3-5)", [...POPUPS, "d03-extension-settings"]],
  ["Your choices are saved and start working once it’s allowed.", "curly apostrophe", ["d14-extension-first-run"]],
  ["If Still isn’t in your toolbar", "curly apostrophe", ["d14-extension-first-run"]],
  ["Your shared data hasn’t been deleted yet.", "curly apostrophe", ["d03-extension-settings", "system-gallery"]],
  ["We couldn’t send your deletion request.", "curly apostrophe", ["d03-extension-settings", "system-gallery"]],
  ["Sync didn’t finish.", "curly apostrophe", [...POPUPS, ...SETTINGS, "system-gallery"]],
  ["We couldn’t delete your account.", "error line starts \"We couldn’t\"", [...SETTINGS, "system-gallery"]],
  ["We couldn’t send the code.", "error line starts \"We couldn’t\"", ["d18-d20-d24-d25-purchase-and-restore", "system-gallery"]],
  ["It doesn’t work inside", "curly apostrophe", ["d12-apple-onboarding"]],
  ["I’ve turned it on", "curly apostrophe", ["d12-apple-onboarding"]],
  ["You’re set", "curly apostrophe", ["d12-apple-onboarding"]],
  ["We couldn’t save your choice.", "curly apostrophe", ["d12-apple-onboarding"]],
  ["We couldn’t finish setup.", "curly apostrophe", ["d12-apple-onboarding"]],
];

/** Cards that gained the free-controls line while checking (P3-10), by selector, because the same
 * line already sat in the Still Pro card's checking state before this change. */
const AUDIT_REGIONS: [string, string, AuditScreen[]][] = [
  [
    '.restore-focus + .status-line[data-tone="pending"]',
    "restore checking line gains the free-controls line",
    [...SETTINGS, "system-gallery"],
  ],
  [
    ".status-line:has(#popup-pro-checking)",
    "popup Still Pro checking card gains the free-controls line",
    [...POPUPS, "d03-extension-settings", "system-gallery"],
  ],
];

/** The copy-audit notes that apply to one screen's frames. */
export function copyAuditFor(screen: string): Deviation[] {
  const on = (screens: AuditScreen[]) => (screens as string[]).includes(screen);
  return [
    ...AUDIT_LINES.filter(([, , screens]) => on(screens)).map(([text, what]) => ({
      reason: `22 Oct copy audit: ${what}`,
      text,
    })),
    ...AUDIT_REGIONS.filter(([, , screens]) => on(screens)).map(([selector, what]) => ({
      reason: `22 Oct copy audit: ${what}`,
      selector,
    })),
  ];
}
