import type {
  CheckoutPendingRecord,
  DeleteAccountSessionOutcome,
  ExtensionSessionState,
  RequestCodeOutcome,
  SessionReconcileOutcome,
  SignOutSessionOutcome,
  VerifyCodeOutcome,
  WebCheckoutOutcome,
} from "@still/core/sync";

// The popup/options ↔ background session protocol (plan U6/R2). One discriminator (`kind`) so the
// background's routers can split cleanly: this protocol is PRIVILEGED (extension-page senders
// only — the router enforces `sender.id === runtime.id` and no `sender.tab`), while the content
// scripts' low-privilege `{kind: "reconcile"}` nudge stays its own message. Every response is a
// structured outcome from @still/core — never a thrown error across the messaging boundary — and
// `unavailableResponse` is the shared fail-safe answer for a spine-less build (no Supabase env),
// an unreachable background, or a torn handler.

export const SESSION_MESSAGE_KIND = "still:session";

interface Base {
  readonly kind: typeof SESSION_MESSAGE_KIND;
}

export type SessionRequest =
  | (Base & { readonly action: "getState" })
  | (Base & { readonly action: "requestCode"; readonly email: string })
  | (Base & { readonly action: "verifyCode"; readonly email: string; readonly token: string })
  | (Base & { readonly action: "signOut" })
  | (Base & { readonly action: "deleteAccount" })
  | (Base & { readonly action: "reconcile" })
  | (Base & { readonly action: "restore" })
  | (Base & { readonly action: "createCheckout" })
  | (Base & {
      readonly action: "setPendingOtp";
      readonly pending: { readonly email: string; readonly requestedAt: number } | null;
    })
  | (Base & { readonly action: "setPurchaseIntent"; readonly active: boolean })
  | (Base & {
      readonly action: "setCheckoutPending";
      readonly pending: CheckoutPendingRecord | null;
    });

export type SessionAction = SessionRequest["action"];

/** Response type per action — the session's own outcome vocabulary; setters ack with "ok" (an
 * undefined response is indistinguishable from an unreachable background, so never send one). */
export interface SessionResponses {
  getState: ExtensionSessionState;
  requestCode: RequestCodeOutcome;
  verifyCode: VerifyCodeOutcome;
  signOut: SignOutSessionOutcome;
  deleteAccount: DeleteAccountSessionOutcome;
  reconcile: SessionReconcileOutcome;
  restore: SessionReconcileOutcome;
  createCheckout: WebCheckoutOutcome;
  setPendingOtp: "ok";
  setPurchaseIntent: "ok";
  setCheckoutPending: "ok";
}

export function isSessionRequest(message: unknown): message is SessionRequest {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { kind?: unknown; action?: unknown };
  return m.kind === SESSION_MESSAGE_KIND && typeof m.action === "string";
}

/** The fail-safe answers (plan KTD: absent config → the spine is absent, structured outcomes
 * only): everything reads as signed-out / couldn't-do-it, which the UI already renders calmly —
 * and which never downgrades a cached entitlement (AE6). */
const UNAVAILABLE: SessionResponses = {
  getState: { userId: null, entitled: false, checkoutPending: null, pendingOtp: null },
  requestCode: { kind: "send-failed" },
  verifyCode: { kind: "verify-failed" },
  signOut: "signed-out",
  deleteAccount: "delete-failed",
  reconcile: "unknown",
  restore: "unknown",
  createCheckout: { kind: "unavailable" },
  setPendingOtp: "ok",
  setPurchaseIntent: "ok",
  setCheckoutPending: "ok",
};

export function unavailableResponse<A extends SessionAction>(action: A): SessionResponses[A] {
  return UNAVAILABLE[action];
}
