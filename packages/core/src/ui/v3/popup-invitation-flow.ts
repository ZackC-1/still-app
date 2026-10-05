// The popup half of the sync invitation (U13-P2). Pure and port-based: the browser entrypoint
// supplies a port whose every operation is a message to the background, which runs each ledger
// transaction in its single serialized queue. This module never opens a ledger of its own.
//
// Ordering rule (U13-P1 review): the reservation is committed BEFORE the card renders. Render
// first and a crash between the two would let the next opening show the same card again. A
// rejected or failed commit means the card is not shown.

import type { InvitationReservation } from "../../invitations/ledger.js";
import type { InvitationIdentity, PopupInvitationPresentation } from "./invitation-presentation.js";

export interface PopupInvitationReservation {
  /** Opaque local installation id, used only to identify this card. Never sent anywhere. */
  readonly installation: string;
  readonly reservation: InvitationReservation;
}

export interface PopupInvitationPort {
  /** Background: record this opening, decide and reserve. Null means no card for this opening. */
  present(opening: string): Promise<PopupInvitationReservation | null>;
  /** Background: consume the reservation. False means another host or state won: show nothing. */
  commit(reservation: InvitationReservation): Promise<boolean>;
}

/**
 * Reserve, commit, then (and only then) call `show`. Returns whether the card was shown. Any
 * failure before the commit result is known shows nothing; the next ordinary opening releases an
 * abandoned reservation.
 */
export async function presentInvitation(
  port: PopupInvitationPort,
  opening: string,
  show: (reserved: PopupInvitationReservation) => void,
): Promise<boolean> {
  let reserved: PopupInvitationReservation | null;
  try {
    reserved = await port.present(opening);
  } catch {
    return false;
  }
  if (!reserved) return false;
  let committed: boolean;
  try {
    committed = await port.commit(reserved.reservation);
  } catch {
    return false;
  }
  if (committed !== true) return false;
  show(reserved);
  return true;
}

/** The D28 sync card for the current popup opening. The card consumes on commit, so both buttons
 * only close it (Sign in also opens the existing sign-in flow). */
export function syncInvitationPresentation(input: {
  readonly installation: string;
  readonly opening: string;
  readonly surface: "chrome" | "firefox";
  readonly closed: boolean;
  readonly onSignIn: () => void;
  readonly onNotNow: () => void;
}): PopupInvitationPresentation {
  const identity: InvitationIdentity = {
    installation: input.installation,
    opening: input.opening,
    surface: input.surface,
  };
  return {
    identity,
    kind: "sync",
    verified: true,
    fresh: true,
    status: input.closed ? "consumed" : "ready",
    ordinaryOpening: true,
    accept: { identity, verified: true, status: "ready", request: input.onSignIn },
    dismiss: { identity, verified: true, status: "ready", request: input.onNotNow },
  };
}
