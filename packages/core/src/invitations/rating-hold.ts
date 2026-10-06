// What the Apple app's web UI is in the middle of, reported to native so Apple's rating sheet is
// held meanwhile (U13-P3). Native (StillKit RatingHold) keeps the last report for the launch and
// holds until the first one arrives. Only a calm settings screen reports "none".
//
// The report is one closed word over the existing `still` bridge: no account, setting or page
// detail. Nothing here records analytics.

export const RATING_HOLD_FLOWS = ["none", "setup", "signIn", "consent", "restore", "purchase", "delete", "error"] as const;
export type RatingHoldFlow = (typeof RATING_HOLD_FLOWS)[number];

/** The controller and screen facts the Apple settings host already has. */
export interface AppleRatingHoldInputs {
  readonly authFlow: string;
  readonly signInOpen: boolean;
  readonly usageNoticeVisible: boolean;
  readonly deleteFlow: string;
  readonly purchaseFlow: string;
  readonly checkoutFlow: string;
  readonly paywallOpen: boolean;
  readonly successScreen: string;
  readonly signedIn: boolean;
  readonly cloudReachable: boolean;
  /** A Restore card is on screen (checking or its outcome). */
  readonly restoreShown: boolean;
  /** Committed settings are held or unavailable. */
  readonly settingsHeld: boolean;
}

/** The one flow to report, most specific first. */
export function appleRatingHold(i: AppleRatingHoldInputs): RatingHoldFlow {
  if (i.deleteFlow !== "idle") return "delete";
  if (i.restoreShown) return "restore";
  if (i.purchaseFlow !== "idle" || i.checkoutFlow !== "none" || i.paywallOpen || i.successScreen !== "none") return "purchase";
  // Includes a return from Mail with a code: the code entry is restored with the sheet open.
  if (i.signInOpen || i.authFlow !== "idle") return "signIn";
  if (i.usageNoticeVisible) return "consent";
  if (i.settingsHeld || (i.signedIn && !i.cloudReachable)) return "error";
  return "none";
}

interface StillPortWindow {
  readonly webkit?: { readonly messageHandlers?: { readonly still?: { postMessage(message: unknown): Promise<unknown> } } };
}

/** Tell the app the current flow. Outside the Apple app (no `still` handler) it does nothing. */
export function reportRatingHold(flow: RatingHoldFlow, win: StillPortWindow = globalThis as StillPortWindow): void {
  const port = win.webkit?.messageHandlers?.still;
  if (!port) return;
  try {
    void Promise.resolve(port.postMessage({ kind: "ratingHold", flow })).catch(() => {});
  } catch {
    /* the app keeps holding; a lost report can only keep the sheet back */
  }
}
