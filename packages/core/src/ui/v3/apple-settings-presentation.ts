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
  | "confirmedAccount"
  | "onSignIn"
  | "offer"
  // Browser-only D03 observations; native access is derived from supplied access states.
  | "accessChecking"
  | "accessVerify"
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
  pro: Omit<NativeProOfferCardProps, "accessHeld" | "restoreHeld">;
  restore?: RestoreStatusCardProps;
  link?: AccountLinkCardProps;
  /** Eligibility is supplied only for a later ordinary visit, never inferred from buying. */
  linkInvitation?: {
    eligibleLaterVisit: boolean;
    onLink?: () => void;
    onDismiss?: () => void;
  };
  sharing: SharingCardProps;
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
