import type { DesktopPopupProps } from "./presentation.js";
import type { FeatureId } from "@still/shared-types";
import type { Snippet } from "svelte";

export interface OperationStatus {
  tone: "pending" | "success" | "failed" | "caution" | "info";
  text: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface SyncCardProps {
  account?: {
    address?: string;
    /** Actual account and session revision supplied by the host, never inferred from email. */
    identity?: string;
    revision?: number;
    /** Actual caller-confirmed session; an address alone is not checkout authority. */
    confirmed: boolean;
    status?: OperationStatus;
    /** Last successful cloud exchange, shown beside the status as on the popups ("Synced · Today
     * at 2:10 PM"). The Apple app and the browser Settings page supply it; absent, the status line
     * is unchanged. */
    lastSyncedAt?: number | null;
    onSignOut?: () => void;
    onDeleteAccount?: () => void;
    /** Account-wide "Delete shared data on all devices" (owner decisions 60, 61, 74). Supplied only
     * where the build offers it (per-device identities wired); absent, nothing renders. */
    sharedData?: SharedDataProps;
  };
  onSignIn?: () => void;
  /** Actual host status and recovery actions, within the single sync card. */
  accountActions?: Snippet;
  /** Apple accountless Still Pro holder, signed out (ISS-0071; moved into this card by the owner
   * on 19 Oct): Sign in runs the explicit link flow, Not now hides the line until the next launch,
   * and the card says "You have Still Pro. Sign in to keep Still Pro with your account." */
  invitation?: { onAccept?: () => void; onDismiss?: () => void };
  /**
   * ISS-0073: true only while Still Pro is verified as purchased (`proPurchased` of the real
   * access). The account row then shows the "Still Pro" tag beside the address, or beside Sign in.
   */
  stillPro?: boolean;
}

export interface SharedDataProps {
  /** The approved withdrawal line to show for the account, or "none". */
  withdrawal: "none" | "requested" | "verifying" | "deleted" | "failed";
  /** This device was stopped by a deletion asked on another device. */
  stoppedElsewhere?: boolean;
  /** Asks (the settings page confirms first). Absent while a request is on its way. */
  onDelete?: () => void;
  /** "Try again" after the request could not be sent. */
  onRetry?: () => void;
}

export interface ProOfferCardProps {
  /** Descriptive, capability-filtered inventory; no switches, saved-choice changes or authority. */
  controls?: readonly { site: string; label: string }[];
  /**
   * The rows this surface draws (a phone omits the desktop-layout extras); omitted: all. With no
   * `controls`, the conclusively locked card lists what these extras hide on each site.
   */
  features?: readonly FeatureId[];
  /** False while the surface's device answer is pending: the value list waits (see ExtensionSettingsProps). */
  platformKnown?: boolean;
  /** True where the surface draws the phone-layout inventory (iPhone/iPad, Firefox for Android).
   * Unread since 12 Oct 2026: no Still Pro copy states a number of extras (owner rule). */
  phone?: boolean;
  ownership: "none" | "owned" | "checking" | "verify" | "failed";
  /**
   * "offline": Still could not check because the browser is offline. With ownership "none" the
   * card says so instead of claiming Still Pro can't be bought here, and instead of "verify again"
   * for a held known none (ISS-0090). Buy still needs "ready" and a conclusive locked snapshot.
   */
  channel: "ready" | "unverified" | "unavailable" | "offline";
  /**
   * Verified caller data; the price is displayed only in the real checkout. A checkout-priced
   * offer (`checkoutPriced: true`, `price: ""`) has no price on this surface at all: the browser
   * extensions carry no verified price, so the checkout page shows it (owner decision,
   * 10 October 2026). It enables Buy only in builds compiled with the paid tier on.
   */
  offer?: { price: string; priceNote?: string; checkoutPriced?: true };
  confirmedAccount: boolean;
  accessHeld?: boolean;
  /** Actual pending observation, separate from a held or completed access result. */
  accessChecking?: boolean;
  accessVerify?: boolean;
  restoreHeld?: boolean;
  state?: "idle" | "pending" | "failed" | "success";
  onSignIn?: () => void;
  onBuy?: () => void;
  onRestore?: () => void;
  onRetry?: () => void;
}

export interface RestoreStatusCardProps {
  /** "nothing" requires a conclusive caller result. Uncertainty is checking/failed. */
  state: "checking" | "restored" | "nothing" | "failed" | "verify";
  onAction?: () => void;
  /**
   * Replaces the "nothing" wording for a host whose check is against something other than a Still
   * account: the Apple app passes its Apple Account wording (owner decision 26). Browser hosts
   * leave it unset and keep the card's own wording.
   */
  nothingCopy?: { readonly text: string; readonly detail: string };
}

export interface AccountLinkCardProps {
  /** `elsewhere`: the purchase is linked to a different account (ISS-0104); a fact, no action. */
  state: "confirm" | "pending" | "linked" | "failed" | "elsewhere";
  email: string;
  onConfirm?: () => void;
  onChooseOther?: () => void;
  onRetry?: () => void;
  signOutNote?: boolean;
}

export interface SharingCardProps {
  state: "unasked" | "on" | "off";
  /** Approved combined email-plus-usage purposes, supplied by the caller. */
  purposes?: readonly { name: string; text: string }[];
  purposesVerified?: boolean;
  withdrawal?: "none" | "requested" | "verifying" | "deleted" | "failed";
  onShare?: () => void;
  onDecline?: () => void;
  onChange?: (next: boolean) => void;
  onRequestDeletion?: () => void;
  onRetry?: () => void;
}

export type SettingsSiteListProps = Pick<
  DesktopPopupProps,
  | "settings"
  | "access"
  | "onServiceChange"
  | "onFeatureChange"
  | "sectionMemory"
  | "services"
  | "features"
  | "labels"
  | "commandsDisabled"
> & {
  /** A locked row's action while Still Pro is offered; the opener is that row's lock button. */
  onProAction?: (opener: HTMLElement) => void;
  /** "safari": a lock chip names the Still app as its destination (see proHandoff). */
  host?: "browser" | "safari";
};

export interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  /** Omission retains the existing destructive confirmation appearance. */
  tone?: "danger" | "primary";
  cancelLabel?: string;
  onConfirm?: () => void;
  onCancel: () => void;
}

export interface ExtensionSettingsProps extends Pick<
  DesktopPopupProps,
  | "settings"
  | "access"
  | "onGlobalChange"
  | "onServiceChange"
  | "onFeatureChange"
  | "sectionMemory"
  | "services"
  | "features"
  | "labels"
  | "commandsDisabled"
  | "siteAccess"
> {
  sync: SyncCardProps;
  /**
   * True only when the browser confirmed a phone platform (Firefox for Android, iPhone/iPad
   * Safari). Pending or unknown is not a phone here, even while the rows are drawn as phone rows.
   * No Still Pro copy reads it since 12 Oct 2026 (owner rule: never state a number of extras);
   * hosts keep passing it so the device-specific seam stays in one place.
   */
  phone?: boolean;
  /** Host-supplied instructions for returning from the offer to its popup controls. */
  proReturnGuidance?: string;
  /**
   * False while the surface's own device answer is still pending (Firefox asks whether it runs on
   * Android). The Still Pro card's by-site value list waits for it, so the list never visibly
   * changes from the phone rows to the computer rows. Omitted: known.
   */
  platformKnown?: boolean;
  pro?: Omit<
    ProOfferCardProps,
    | "confirmedAccount"
    | "accessHeld"
    | "accessChecking"
    | "accessVerify"
    | "restoreHeld"
  >;
  /**
   * Safari only, where the Still app owns Still Pro (App Store Review Guidelines 3.1.1 and 3.1.3)
   * and no `pro` producer exists: opens the app's Still Pro screen. With access conclusively
   * locked the page shows the Safari popup's compact Still Pro card ("Opens the Still app"; no
   * price, no purchase) and the lock chips open the app too (ISS-0032). Ignored when `pro` is set.
   */
  proHandoff?: () => void;
  restore?: RestoreStatusCardProps;
  /**
   * Free-period Restore (owner decisions 62 and 73): a plain "Restore purchase" link, shown only
   * while the compiled paid flag is off and no paid producer is supplied. It only asks whether the
   * account already owns Still Pro; it never offers Buy, a price or checkout.
   */
  onRestore?: () => void;
  link?: AccountLinkCardProps;
  sharing?: SharingCardProps;
  /** Existing real privacy actions when no genuine combined-consent producer is supplied. */
  privacyActions?: Snippet;
  /** Verified setup instructions and action, supplied without fabricated permission state. */
  setup?: { detail: string; onAction?: () => void };
  help: {
    onGuide?: () => void;
    onSupport?: () => void;
    onPrivacy?: () => void;
  };
}
