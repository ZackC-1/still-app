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
  };
  owned?: boolean;
  onSignIn?: () => void;
  /** Actual host status and recovery actions, within the single sync card. */
  accountActions?: Snippet;
}

export interface ProOfferCardProps {
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
> & { onProAction?: () => void };

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
