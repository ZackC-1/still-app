import type { PurchaseViewProps } from "./purchase-presentation.js";

export interface PurchaseSignInOperation {
  requestId: string;
  ownerId: string;
  purpose: "purchase" | "restore";
}

export interface PurchaseSignInPort<T = PurchaseSignInOperation> {
  operation: PurchaseSignInOperation;
  verified: boolean;
  onRequest?: (intent: T) => void;
}

export interface PurchaseSignInValueIntent {
  operation: PurchaseSignInOperation;
  value: string;
}

export interface PurchaseSignInSheetProps {
  open: boolean;
  operation: PurchaseSignInOperation;
  observation?: {
    operation: PurchaseSignInOperation;
    verified: boolean;
    state:
      | "email"
      | "sending"
      | "code"
      | "verifying"
      | "failed"
      | "confirmed"
      | "unknown";
    /** Failed requests retain the caller's actual input stage. */
    field?: "email" | "code";
    /** Truthful provider/host status, never inferred from a local action. */
    text?: string;
    account?: { id: string; confirmed: boolean };
  };
  email: string;
  code: string;
  emailInput?: PurchaseSignInPort<PurchaseSignInValueIntent>;
  codeInput?: PurchaseSignInPort<PurchaseSignInValueIntent>;
  send?: PurchaseSignInPort<PurchaseSignInValueIntent>;
  verify?: PurchaseSignInPort<PurchaseSignInValueIntent>;
  dismiss?: PurchaseSignInPort;
  /** Display only: every background callback is removed by this component. */
  background: Extract<PurchaseViewProps, { host: "browser" }>;
}
