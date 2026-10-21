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
 * Owner's canvas review, 21 Oct 2026: the Safari popup's setup header reads "Still can't block
 * distractions yet." where the reference says "Still can't block on these websites yet."
 */
export const OWNER_SAFARI_SETUP_COPY: Deviation = {
  reason:
    'owner-approved copy (Safari setup header "Still can\'t block distractions yet."; reference says "Still can\'t block on these websites yet.")',
  text: "Still can't block distractions yet.",
};

/** The latest reference restores demo banners; their omission also moves subsequent cards. */
export const REFERENCE_DEMO_ACCOUNT: Deviation = {
  reason:
    "reference-only demonstration banner omitted from the real account card; account actions and subsequent cards flow upward",
  selector: ".card:has(.synced), .card:has(.synced) ~ .card",
};

/**
 * ISS-0032 (owner-approved design, 12 Oct 2026): a compact Still Pro card ("Even fewer distractions on
 * Instagram, Facebook, and YouTube. One-time purchase." and Get Still Pro) replaces the reference's
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
