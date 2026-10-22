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
 * The 22 Oct 2026 copy audit and the owner's rulings on it: curly apostrophes, no full stop on
 * headings, no serial comma, "We couldn’t …" error lines, US spelling, and the reworded lines below.
 * Declared on every frame (index.ts) as text regions; a frame without the text measures 0 px.
 */
export const OWNER_COPY_AUDIT: Deviation[] = [
  ["’", "curly apostrophes in user-visible copy"],
  ["Still can’t block distractions yet", "setup heading without a full stop"],
  ["Turn on the Still extension in Safari.", "extension-off line (P2-1)"],
  ["below.", "numbered steps end with a full stop"],
  ["reopen it.", "numbered steps end with a full stop"],
  ["YouTube and TikTok", "no serial comma in the site list"],
  ["Facebook and YouTube", "no serial comma in the Still Pro line"],
  ["Verify purchase", "\"Verify purchase\" replaces \"Verify now\""],
  ["Your free controls keep working while this finishes.", "checking line names the free controls"],
  ["Enjoying Still?", "rating invitation heading"],
  ["Link Still Pro to your account", "linking offer heading and button"],
  ["Opens the Still app", "Safari settings page signed-out sync card hands off to the app"],
  ["Sync settings across devices and browsers. Free.", "Safari settings page signed-out sync line"],
  ["Lifetime access. No subscription.", "purchase view terms"],
  ["Back to Still settings", "browser purchase view back link"],
  ["New controls start off, so turn on", "after-purchase line"],
  ["Bought it with another account?", "browser restore not-found line"],
  ["Loading your settings…", "loading line kept apart from \"Checking sync…\""],
  ["Not available in Safari.", "unavailable Still Pro row on Safari"],
  ["Not available on this device.", "unavailable Still Pro row in the Apple app"],
  ["Helps improve Still.", "usage switch line"],
  ["Delete shared data from all your devices", "shared-data link matches its dialog"],
  ["6-digit sign-in code", "both sign-in prompts"],
  ["Sign in to get Still Pro", "purchase sign-in sheet title"],
  ["Sign in first to keep Still Pro", "purchase sign-in sheet note"],
  ["Checkout was canceled.", "US spelling"],
  ["Still is on", "first-run heading without a full stop"],
  ["One step to finish setup", "first-run heading without a full stop"],
  ["TikTok stays closed", "TikTok page heading without a full stop"],
].map(([text, what]) => ({ reason: `22 Oct copy audit: ${what}`, text }));
