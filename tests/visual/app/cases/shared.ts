import type { Deviation } from "../types.js";

/**
 * Owner decision 2026-10-12 (ISS-0029): the sync line reads "Free. Keep your block settings
 * consistent across every supported device and browser." on every screen. Reference frames still
 * carry the earlier "every device and browser" wording. The region is the implementation element
 * holding the new wording, so a failing frame reports how many differing pixels sit on that line
 * and how many remain elsewhere.
 */
export const OWNER_SYNC_COPY: Deviation = {
  reason:
    'owner-approved copy (sync line "every supported device and browser"; reference says "every device and browser")',
  text: "every supported device and browser",
};

/** The latest reference restores demo banners; their omission also moves subsequent cards. */
export const REFERENCE_DEMO_ACCOUNT: Deviation = {
  reason:
    "reference-only demonstration banner omitted from the real account card; account actions and subsequent cards flow upward",
  selector: ".card:has(.synced), .card:has(.synced) ~ .card",
};
