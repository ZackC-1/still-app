// Extension-page side of the sync invitation (popup and options). Messages only: the ledger lives
// in the background service worker's serialized queue, never behind a port opened here.

import type { InvitationControl, InvitationReservation } from "../../core/src/invitations/index.js";
import type { PopupInvitationPort } from "../../core/src/ui/v3/popup-invitation-flow.js";
import { INVITATION_MESSAGE_KIND, type InvitationReply } from "./invitation-background.js";

const TIMEOUT_MS = 5_000;

async function ask(message: object): Promise<InvitationReply | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply: unknown = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), TIMEOUT_MS); }),
    ]);
    return reply !== null && typeof reply === "object" ? (reply as InvitationReply) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const invitationPort: PopupInvitationPort = {
  async present(opening) {
    const reply = await ask({ kind: INVITATION_MESSAGE_KIND, op: "present", opening });
    return reply?.status === "present" ? reply.card : null;
  },
  async commit(reservation: InvitationReservation) {
    const reply = await ask({ kind: INVITATION_MESSAGE_KIND, op: "commit", reservation });
    return reply?.status === "commit" && reply.committed === true;
  },
};

/** One successful direct control. Fire and forget: counting never changes a saved outcome. */
export function reportDirectControl(control: InvitationControl): void {
  void ask({ kind: INVITATION_MESSAGE_KIND, op: "control", control });
}
