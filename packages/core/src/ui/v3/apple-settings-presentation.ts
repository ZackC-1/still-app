import type { Snippet } from "svelte";
import type { DesktopPopupProps } from "./presentation.js";
import type {
  SyncCardProps,
  ProOfferCardProps,
  RestoreStatusCardProps,
  AccountLinkCardProps,
  SharingCardProps,
} from "./extension-settings-presentation.js";

/** Supplied trusted native offer/ports; optional sync identity never authorizes purchase. */
export interface NativeProOfferCardProps extends Omit<
  ProOfferCardProps,
  "confirmedAccount" | "onSignIn" | "offer"
> {
  offer?: { price: string; priceNote?: string; refundNote?: string };
}

type AppleSettingsAccount = Omit<
  NonNullable<SyncCardProps["account"]>,
  // The shared card's later optional fields are restated here with the native contract.
  "onDeleteAccount" | "address" | "identity" | "revision"
> & { address: string } & (
    | {
        onDeleteAccount?: undefined;
        identity?: string;
        revision?: string | number;
      }
    | {
        onDeleteAccount?: () => void;
        /** Stable actual account identity, never inferred from its address. */
        identity: string;
        /** Nonreused session/destructive epoch; advance on reauthentication or replacement. */
        revision: string | number;
      }
  );

export interface AppleSettingsProps extends Pick<
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
> {
  platform: "ios" | "mac";
  sync: Omit<SyncCardProps, "account"> & {
    account?: AppleSettingsAccount;
  };
  /**
   * Absent while no trusted paid producer is supplied; never fabricate an offer. The held
   * flags are not caller inputs: AppleSettings derives `accessChecking` (any Pro row
   * "checking") and `accessVerify` (any Pro row "verification_required") separately from
   * `access.states`, plus `accessHeld`/`restoreHeld` from rights not known missing and Restore.
   */
  pro?: Omit<
    NativeProOfferCardProps,
    "accessHeld" | "accessChecking" | "accessVerify" | "restoreHeld"
  >;
  restore?: RestoreStatusCardProps;
  /**
   * Free-period Restore (owner decision 17): a plain "Restore purchase" link for past purchasers,
   * shown only while no paid producer (`pro`) is supplied; the Still Pro card carries its own
   * Restore otherwise. Never a Buy, a price or an offer.
   */
  onRestore?: () => void;
  link?: AccountLinkCardProps;
  /** Eligibility is supplied only for a later ordinary visit, never inferred from buying. */
  linkInvitation?: {
    eligibleLaterVisit: boolean;
    onLink?: () => void;
    onDismiss?: () => void;
  };
  sharing?: SharingCardProps;
  /** Existing real privacy actions when no genuine combined-consent producer is supplied. */
  privacyActions?: Snippet;
  /** TODO: exact iOS/macOS setup wording/action must come from the approved host. */
  setup?: {
    title: string;
    detail: string;
    steps: readonly string[];
    actionLabel: string;
    onAction?: () => void;
  };
  /** TODO: approved guide/support/privacy destinations belong to host integration. */
  help: {
    onGuide?: () => void;
    onSupport?: () => void;
    onPrivacy?: () => void;
  };
}
