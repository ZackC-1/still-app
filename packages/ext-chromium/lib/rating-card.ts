// The browser rating card's presentation (U13-P3). The background reserves it through the shared
// invitation handler and the popup commits it before it renders (popup-invitation-flow.ts), so by
// the time this presentation exists the once-per-install attempt is already spent. Either button
// removes the card for good; "Rate Still" opens the packaged store review page in a new tab
// (tabs.create, no new permission). Nothing here records analytics: no event, no outcome, no "did
// they rate" signal.

import { ratingReviewUrl, type RatingCardSurface } from "../../core/src/invitations/rating-allowance.js";
import type { InvitationIdentity, PopupInvitationPresentation } from "../../core/src/ui/v3/invitation-presentation.js";

export function ratingCardPresentation(input: {
  readonly installation: string;
  readonly opening: string;
  readonly surface: RatingCardSurface;
  /** The committed reservation's generation: this card's admission receipt. */
  readonly generation: number;
  readonly closed: boolean;
  readonly onRate: () => void;
  readonly onNotNow: () => void;
}): PopupInvitationPresentation {
  const identity: InvitationIdentity = { installation: input.installation, opening: input.opening, surface: input.surface };
  return {
    identity,
    kind: "rating",
    verified: true,
    fresh: true,
    status: input.closed ? "consumed" : "ready",
    ordinaryOpening: true,
    rating: {
      // The background admitted this card only after a fresh owner On for this opening.
      allowance: { verified: true, fresh: true, global: true, surface: true },
      // The packaged minimums the background's ledger enforced (seven days, three days of use, a
      // later opening); the popup never sees the ledger itself.
      eligibility: { verified: true, ageDays: 7, distinctUseDays: 3, laterOpening: true },
      display: { verified: true, fresh: true, status: "admitted", receiptId: `rating-${input.generation}`, identity },
    },
    accept: { identity, verified: true, status: "ready", request: input.onRate },
    dismiss: { identity, verified: true, status: "ready", request: input.onNotNow },
  };
}

/** Open the packaged review page for this popup's store. Never throws. */
export function openRatingReview(
  surface: RatingCardSurface,
  open: (url: string) => Promise<unknown> = url => chrome.tabs.create({ url }),
): void {
  try {
    void Promise.resolve(open(ratingReviewUrl(surface))).catch(() => {});
  } catch {
    /* a tab that cannot open changes nothing: the card is already spent */
  }
}
