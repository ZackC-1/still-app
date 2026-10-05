// The packaged store review page each browser rating card opens (U13-P3). Fixed here, never
// remotely supplied: the remote rating policy is only an on/off allowance and carries no URL. Kept
// apart from rating-allowance.ts so the background's invitation handler, which uses that module,
// never pulls UI configuration into the popup's or options page's shared code.

import { CHROME_WEB_STORE_REVIEW_URL, FIREFOX_ADDONS_REVIEW_URL } from "../ui/config.js";
import type { RatingCardSurface } from "./rating-allowance.js";

/** The packaged store review page a card surface opens. Never a remotely supplied link. */
export function ratingReviewUrl(surface: RatingCardSurface): string {
  return surface === "firefox" ? FIREFOX_ADDONS_REVIEW_URL : CHROME_WEB_STORE_REVIEW_URL;
}
