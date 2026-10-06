// Extension-page side of the sync invitation (popup and options). Messages only: the ledger lives
// in the background service worker's serialized queue, never behind a port opened here.

import type { InvitationControl, InvitationReservation } from "../../core/src/invitations/index.js";
import type { PopupInvitationPort } from "../../core/src/ui/v3/popup-invitation-flow.js";
import { INVITATION_MESSAGE_KIND, type InvitationReply } from "./invitation-background.js";

/** How long a page waits for any invitation reply (present, commit or control). */
export const INVITATION_REPLY_TIMEOUT_MS = 5_000;
const TIMEOUT_MS = INVITATION_REPLY_TIMEOUT_MS;

/** How long the page waits for the browser to say whether its window is private. */
export const PRIVACY_ANSWER_LIMIT_MS = 1_000;

/** The browser calls the privacy check reads. Injectable so the tests need no browser. */
export interface PrivacySources {
  readonly windows?: { getCurrent(): Promise<{ incognito?: unknown }> };
  readonly extension?: { readonly inIncognitoContext?: unknown };
}

/**
 * Whether this page's window is private, resolved before `present`. Private if the current window
 * says so OR the extension context does. `extension.inIncognitoContext` alone is not enough: in
 * Chrome's default spanning mode a popup over a private window still reports false, so the window
 * itself is asked. A failed, late or missing window answer is private (unknown counts as private),
 * except where the browser has no windows API at all (Firefox for Android), where the extension
 * context's own boolean answers; with neither answer the window is private.
 */
export async function windowIsPrivate(
  sources: PrivacySources | undefined, limitMs = PRIVACY_ANSWER_LIMIT_MS,
): Promise<boolean> {
  const context = sources?.extension?.inIncognitoContext;
  if (context === true) return true;
  const getCurrent = sources?.windows?.getCurrent;
  if (typeof getCurrent !== "function") return context !== false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const window = await Promise.race([
      getCurrent.call(sources!.windows),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), limitMs); }),
    ]);
    if (!window || typeof window.incognito !== "boolean") return true;
    return window.incognito || context !== false;
  } catch {
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  async present(opening, hold) {
    // A private (or unknown) window counts for nothing: the background leaves the ledger untouched.
    const isPrivate = await windowIsPrivate(globalThis.chrome as PrivacySources | undefined);
    const reply = await ask({
      kind: INVITATION_MESSAGE_KIND, op: "present", opening, ...(hold ? { hold } : {}), ...(isPrivate ? { ordinary: false } : {}),
    });
    return reply?.status === "present" ? reply.card : null;
  },
  async commit(reservation: InvitationReservation) {
    const reply = await ask({ kind: INVITATION_MESSAGE_KIND, op: "commit", reservation });
    return reply?.status === "commit" && reply.committed === true;
  },
};

/** One successful direct control. Fire and forget: counting never changes a saved outcome. A
 * control made in a private (or unknown) window is sent with `ordinary: false` and counts for
 * nothing. */
export function reportDirectControl(control: InvitationControl): void {
  void windowIsPrivate(globalThis.chrome as PrivacySources | undefined)
    .then(isPrivate => ask({ kind: INVITATION_MESSAGE_KIND, op: "control", control, ...(isPrivate ? { ordinary: false } : {}) }))
    .catch(() => {});
}
