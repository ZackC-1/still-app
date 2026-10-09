import type { DesktopPopupProps } from "./presentation.js";
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
    onSignOut?: () => void;
    onDeleteAccount?: () => void;
    /** Account-wide "Delete shared data on all devices" (owner decisions 60, 61, 74). Supplied only
     * where the build offers it (per-device identities wired); absent, nothing renders. */
    sharedData?: SharedDataProps;
  };
  owned?: boolean;
  onSignIn?: () => void;
  /** Actual host status and recovery actions, within the single sync card. */
  accountActions?: Snippet;
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
  /** True where the surface draws the phone-layout inventory (iPhone/iPad, Firefox for Android). */
  phone?: boolean;
  ownership: "none" | "owned" | "checking" | "verify" | "failed";
  channel: "ready" | "unverified" | "unavailable";
  /** Verified caller data; the price is displayed only in the real checkout. */
  offer?: { price: string; priceNote?: string };
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
  state: "confirm" | "pending" | "linked" | "failed";
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
> {
  sync: SyncCardProps;
  pro?: Omit<
    ProOfferCardProps,
    | "confirmedAccount"
    | "accessHeld"
    | "accessChecking"
    | "accessVerify"
    | "restoreHeld"
  >;
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
