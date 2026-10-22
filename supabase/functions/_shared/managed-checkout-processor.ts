import { jsonResponse } from "./store.ts";
import type { CheckoutOperation, CheckoutRecovery } from "./managed-checkout.ts";
import type { CheckoutEnvironment, PurchaseOperation, PurchaseOperationStore } from "./purchase-operation-store.ts";
import { reconcileScopedAccess, type ScopedReconcileAccess } from "../reconcile-entitlement/handler.ts";

export interface ManagedCheckoutBilling {
  createCheckout(operation: CheckoutOperation, creationStartedAtMs: number): Promise<CheckoutRecovery | { readonly status: "unavailable" }>;
  recoverCheckout(operation: CheckoutOperation, session: string): Promise<CheckoutRecovery>;
  recoverUnknownCheckout(operation: CheckoutOperation, startedAtMs: number): Promise<CheckoutRecovery>;
  trackCompletedPurchase(operation: CheckoutOperation, session: string): Promise<{ readonly status: "tracked" | "unavailable" }>;
}
export interface ManagedCheckoutProcessingDeps {
  readonly environment: CheckoutEnvironment;
  readonly configurationHash: string;
  readonly operations: PurchaseOperationStore;
  readonly billing: ManagedCheckoutBilling;
  readonly access?: ScopedReconcileAccess;
}

function identity(operation: PurchaseOperation): CheckoutOperation { return { operationId: operation.operation_id, holderId: operation.holder }; }
function scoped(operation: PurchaseOperation, holder: string, deps: ManagedCheckoutProcessingDeps): boolean {
  return operation.holder === holder && operation.environment === deps.environment && operation.configuration_hash === deps.configurationHash;
}
const statusResponse = (operation: PurchaseOperation, extra: Record<string,unknown> = {}) => jsonResponse(200, {
  operation_id: operation.operation_id, status: operation.status, ...extra,
});
const unavailable = () => jsonResponse(502,{ error: "checkout_unavailable" });

/** Shared processing of a server-owned operation and canonical provider readback. Notification
 * handlers may reuse this only AFTER signature and exact existing holder/Session binding checks.
 * Receipt ACK and operation states never create access; only scoped reconciliation can do so. */
export async function processManagedCheckout(operation: PurchaseOperation, recovery: CheckoutRecovery | { readonly status: "unavailable" },
  deps: ManagedCheckoutProcessingDeps, guards: { readonly authorize: () => Promise<boolean>; readonly canGrant: () => Promise<boolean>; readonly isCurrent?: () => boolean }): Promise<Response> {
  if (!scoped(operation,operation.holder,deps) || (deps.access && deps.access.signer.environment !== deps.environment)) return unavailable();
  let current = operation;
  const refresh = async () => {
    const stored = await deps.operations.read(current.operation_id,current.holder);
    if (!stored || !scoped(stored,current.holder,deps) || stored.stripe_session_id !== current.stripe_session_id) throw new Error("checkout binding changed");
    current = stored;
  };
  const accessGuards = { ...guards, canGrant: async () => {
    if (!await guards.canGrant()) return false;
    await refresh();
    return ["imported","access_observed"].includes(current.status) && current.paid_at !== null && guards.isCurrent?.() !== false;
  } };
  try {
    if (recovery.status === "unavailable") return unavailable();
    if (recovery.sessionId) {
      // Preserve known IDs even if readback timed out, before recording uncertainty.
      if (current.stripe_session_id !== null && current.stripe_session_id !== recovery.sessionId) return unavailable();
      if (!current.stripe_session_id) current = await deps.operations.bindSession(current.operation_id,current.holder,recovery.sessionId,deps.configurationHash);
    }
    if (["refunded","closed_unpaid"].includes(current.status)) return await guards.authorize() ? statusResponse(current) : unavailable();
    if (recovery.status === "unknown") {
      current = await deps.operations.recordStatus(current.operation_id,current.stripe_session_id,"recovery_required");
      return await guards.authorize() ? statusResponse(current) : unavailable();
    }
    if (recovery.status === "created") {
      if (current.paid_at !== null) return unavailable();
      if (!await guards.canGrant()) return await guards.authorize() ? statusResponse(current) : unavailable();
      // Reuse the fixed claim RPC as the last atomic membership/configuration fence. The
      // one-way claim already exists, so this can never dispatch another provider POST.
      const fence = await deps.operations.claimCreation(current.operation_id,current.holder,deps.configurationHash);
      if (!scoped(fence.operation,current.holder,deps) || fence.operation.stripe_session_id !== recovery.sessionId ||
        fence.operation.paid_at !== null || ["refunded","closed_unpaid"].includes(fence.operation.status) || guards.isCurrent?.() === false) return unavailable();
      return statusResponse(fence.operation,{ checkout_url: recovery.checkoutUrl });
    }
    if (recovery.paymentState === "payment_pending") return await guards.authorize() ? statusResponse(current) : unavailable();
    if (recovery.paymentState === "expired_unpaid") {
      // SQL also fences paid_at: a paid/refunded operation cannot be reclassified as unpaid.
      if (current.paid_at !== null) return unavailable();
      current = await deps.operations.recordStatus(current.operation_id,current.stripe_session_id,"closed_unpaid");
      return await guards.authorize() ? statusResponse(current) : unavailable();
    }
    if (current.status === "refunded" || current.status === "closed_unpaid") return statusResponse(current);
    // Resume at the persisted stage; do not regress an imported/observed operation.
    if (!["imported","access_observed"].includes(current.status)) {
      if (["session_bound","recovery_required"].includes(current.status)) current = await deps.operations.recordStatus(current.operation_id,current.stripe_session_id,"paid_verified");
      if (current.status === "paid_verified") current = await deps.operations.recordStatus(current.operation_id,current.stripe_session_id,"import_pending");
      // A refund may have committed while admission or provider readback was pending.
      // Read the same immutable operation before importing and before positive reconciliation.
      await refresh();
      if (!["imported","access_observed"].includes(current.status)) {
        if (current.status !== "import_pending") return await guards.authorize() ? statusResponse(current) : unavailable();
        const tracked = await deps.billing.trackCompletedPurchase(identity(current),current.stripe_session_id!);
        await refresh();
        if (["refunded","closed_unpaid"].includes(current.status)) return await guards.authorize() ? statusResponse(current) : unavailable();
        if (tracked.status !== "tracked") {
          current = await deps.operations.recordStatus(current.operation_id,current.stripe_session_id,"recovery_required");
          return await guards.authorize() ? statusResponse(current) : unavailable();
        }
        if (!["imported","access_observed"].includes(current.status)) current = await deps.operations.recordStatus(current.operation_id,current.stripe_session_id,"imported");
      }
    }
    // Begin before the current provider lookup. Keep canonical negative processing reachable
    // after membership disablement; positive commits and confirmation remain SQL fenced.
    const token = await deps.access?.rights.begin(current.holder,deps.environment) ?? null;
    const response = await reconcileScopedAccess(current.holder,deps.access,token,{},accessGuards);
    const result = await response.json();
    // This is ACCOUNT access observed after this import ACK, not an invented correlation
    // from a Stripe Session to a particular RevenueCat purchase/right identity.
    if (current.status !== "access_observed" && result.access?.status === "verified" && await accessGuards.canGrant()) {
      current = await deps.operations.recordStatus(current.operation_id,current.stripe_session_id,"access_observed");
    }
    if (!await guards.authorize()) return unavailable();
    if (result.access?.proofs?.length) {
      if (!await accessGuards.canGrant() || !token || !await deps.access?.rights.confirm(current.holder,deps.environment,token)) {
        return statusResponse(current,{ access: { status: "unavailable" } });
      }
    }
    if (guards.isCurrent?.() === false) return unavailable();
    return statusResponse(current,{ access: result.access ?? { status: "unavailable" } });
  } catch {
    // Retain an already dispatched or paid attempt. No replacement operation/POST follows.
    try { await refresh(); } catch { return unavailable(); }
    if (current.creation_started_at !== null && !["refunded","closed_unpaid"].includes(current.status)) {
      try { current = await deps.operations.recordStatus(current.operation_id,current.stripe_session_id,"recovery_required"); } catch { /* Durable existing binding remains. */ }
    }
    return await guards.authorize() ? statusResponse(current) : unavailable();
  }
}
