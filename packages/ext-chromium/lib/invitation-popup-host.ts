// One popup page's sync invitation host (U13-P2). main.ts configures it only in builds that show
// the V3 popup; the wrapper around DesktopPopup reads it. No ledger access lives here.

import type { PopupInvitationPort } from "@still/core/ui/v3/popup-invitation-flow";

export interface PopupInvitationHost {
  readonly controller: { readonly userId: string | null; openSignIn(): void };
  readonly port: PopupInvitationPort;
  /** Unique id for this popup opening. Opaque, local only. */
  readonly opening: string;
  readonly surface: "chrome" | "firefox";
  /** One presentation attempt per popup page, even if the desktop view remounts. */
  started: boolean;
}

let current: PopupInvitationHost | null = null;
export const configurePopupInvitationHost = (host: PopupInvitationHost | null): void => {
  current = host;
};
export const popupInvitationHost = (): PopupInvitationHost | null => current;
