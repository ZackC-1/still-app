import type { RestoreStatusCardProps } from "./extension-settings-presentation.js";

interface PurchaseViewCommon {
  /** Actual capability-filtered, ordered controls; no production inventory fallback. */
  controls: readonly { site: string; label: string }[];
  access: {
    state:
      | "none"
      | "owned"
      | "purchased"
      | "protected"
      | "free"
      | "checking"
      | "verify"
      | "failed"
      | "unknown";
    verified: boolean;
  };
  channel: "ready" | "unverified" | "unavailable";
  /** Verified localized offer capability. Price is shown only by the real provider. */
  offer?: { price: string; verified: boolean };
  purchase: {
    state: "idle" | "pending" | "failed" | "success";
    confirmed?: boolean;
    /** Charged/native pending evidence awaiting signed verification; never a new acquisition. */
    verificationRequired?: boolean;
  };
  restore?: {
    state: RestoreStatusCardProps["state"] | "unknown";
    verified: boolean;
    /** Required for restored/nothing; a false boolean native reply is not conclusive. */
    conclusive?: boolean;
    onAction?: () => void;
  };
  onBack?: () => void;
}

export type PurchaseViewProps = PurchaseViewCommon &
  (
    | {
        host: "browser";
        account?: { id: string; confirmed: boolean };
        checkout: { verified: boolean; onRequest?: () => void };
        restorePort: { verified: boolean; onRequest?: () => void };
        /** Purchase and Restore ask for the account with their distinct intent. */
        onSignIn?: (purpose: "purchase" | "restore") => void;
      }
    | {
        host: "apple";
        /** TODO: supplied by the trusted native host; Still sign-in is independent. */
        native: {
          verified: boolean;
          onBuy?: () => void;
          onRestore?: () => void;
          /** Retry the existing local signed fulfillment without asking Apple to charge again. */
          onVerify?: () => void;
        };
      }
  );
