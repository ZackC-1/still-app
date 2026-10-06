// The unconfigured (V3) build is the default QA lane. CI also runs the legacy 2.x lane
// (STILL_TEST_SYNC_CONFIGURED=true); V3-only journeys skip there, or assert legacy.
export const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
export const V3_ONLY = "A V3 screen: configured 2.x builds keep the legacy surfaces";
export const NEEDS_BACKEND =
  "Needs the QA-P7 local backend recipe (sign-in, sync); enable when that lands";
