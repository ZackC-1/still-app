import type {
  OperationStatus,
  SharingCardProps,
} from "./extension-settings-presentation.js";

/** Actual caller acknowledgement; a requested choice alone is never saved. */
export type FirstRunConsent = Pick<
  SharingCardProps,
  "purposes" | "purposesVerified" | "onShare" | "onDecline"
> &
  (
    | { status: "saved"; choice: "on" | "off"; operation?: OperationStatus }
    | {
        status: "unasked" | "saving" | "failed";
        choice?: "on" | "off";
        operation?: OperationStatus;
      }
  );

/** Actual supplied host copy; unresolved browser instructions have no defaults. */
export interface FirstRunGuidance {
  verified: boolean;
  text: string;
}

/** Dormant presentation ports. No permission, session, consent or install persistence. */
export interface FirstRunProps {
  browser: "chrome" | "firefox";
  permission: {
    state: "needed" | "pending" | "denied" | "granted" | "unknown";
    verified: boolean;
    requestVerified?: boolean;
    onRequest?: () => void;
    /** TODO: actual approved browser permission wording. */
    guidance?: FirstRunGuidance;
    operation?: OperationStatus;
  };
  blocking: { state: "on" | "off" | "unknown"; verified: boolean };
  /** TODO: actual host setup guidance; permission alone does not prove blocking. */
  setupDescription?: FirstRunGuidance;
  pin: {
    pinned: boolean;
    verified: boolean;
    /** TODO: owner-confirmed browser pinning steps. */
    guidance?: FirstRunGuidance;
  };
  sync: {
    account?: { address: string; confirmed: boolean };
    onSignIn?: () => void;
  };
  /** TODO: actual approved combined purposes/providers and acknowledged storage. */
  consent: FirstRunConsent;
  /** TODO: verified actual settings/privacy destinations. No invented URLs. */
  settings: { verified: boolean; onOpen?: () => void };
  privacy: { verified: boolean; onOpen?: () => void };
}
