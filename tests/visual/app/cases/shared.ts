/**
 * Owner decision 2026-10-05: the sync line reads "Free. Keep your settings updated across every
 * supported surface." on every screen. Reference frames still carry the earlier "every device and
 * browser" wording, so a frame showing the signed-out sync line is reported FAIL with this reason
 * when it exceeds the gate. It is a recorded deviation, never a mask or a waiver of other drift.
 */
export const OWNER_SYNC_COPY =
  'owner-approved copy (sync line "every supported surface"; reference says "every device and browser")';
