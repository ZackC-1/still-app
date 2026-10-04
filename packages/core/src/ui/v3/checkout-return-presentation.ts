export interface CheckoutReturnAction {
  requestId: string;
  verified: boolean;
  onRequest?: () => void;
}

export interface CheckoutReturnProps {
  requestId: string;
  outcome?:
    | {
        requestId: string;
        verified: boolean;
        source: "server";
        state: "confirming" | "ready" | "unconfirmed";
      }
    | {
        requestId: string;
        verified: boolean;
        source: "provider";
        state: "cancelled";
      }
    | {
        requestId: string;
        verified: boolean;
        source: "unknown";
        state: "unknown";
      };
  retry?: CheckoutReturnAction & { pending: boolean };
  settings?: CheckoutReturnAction;
  support?: CheckoutReturnAction;
  privacy?: CheckoutReturnAction;
}
