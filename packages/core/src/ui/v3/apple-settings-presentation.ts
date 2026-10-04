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
  sync: SyncCardProps;
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
