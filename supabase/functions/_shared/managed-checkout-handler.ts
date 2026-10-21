import { withAuthenticatedUser, confirmedAccountExpiry as authorized, type AuthDeps } from "./auth.ts";
import { isUuid } from "./types.ts";
import { jsonResponse } from "./store.ts";
import { enforceRateLimit, type RateLimiter } from "./rate-limit.ts";
import type { ConfirmedAppleAccountPort } from "./apple-fulfillment.ts";
import type { CheckoutEnvironment, CheckoutAdmission, PurchaseOperation, PurchaseOperationStore } from "./purchase-operation-store.ts";
import type { CheckoutOperation, CheckoutRecovery } from "./managed-checkout.ts";
import { processManagedCheckout, type ManagedCheckoutProcessingDeps } from "./managed-checkout-processor.ts";
import { reconcileScopedAccess } from "../reconcile-entitlement/handler.ts";

export interface ManagedCheckoutRequestDeps extends AuthDeps, Omit<ManagedCheckoutProcessingDeps, "operations"> {
  readonly accounts: ConfirmedAppleAccountPort;
  readonly limiter: RateLimiter;
  readonly operationStore: (admission?: CheckoutAdmission) => PurchaseOperationStore;
  readonly canGrant: (holder: string) => Promise<boolean>;
  readonly admissionError: "qa_membership_required" | "sales_unavailable";
}
const CHECKOUT_RATE = { maxPerUser: 5, maxPerIp: 20, windowSeconds: 60 };
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

async function body(req: Request, complete: boolean, environment: CheckoutEnvironment): Promise<{ operation?: string; admission?: CheckoutAdmission } | null> {
  const reader = req.body?.getReader();
  if (!reader) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const chunks: Uint8Array[] = []; let size = 0;
  const deadline = new Promise<{ done: true; value: undefined }>(resolve => { timer = setTimeout(() => {
    expired = true; void reader.cancel().catch(() => {}); resolve({ done: true, value: undefined });
  }, 2000); });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(),deadline]);
      if (expired) return null;
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8",{ fatal: true }).decode(bytes));
    if (!object(value) || value.access_schema !== 1 || Object.keys(value).some(key => !(environment === "production" ? ["access_schema","operation_id","surface","build"] : ["access_schema","operation_id"]).includes(key)) ||
      (complete && !Object.hasOwn(value,"operation_id")) ||
      (Object.hasOwn(value,"operation_id") && (typeof value.operation_id !== "string" || !isUuid(value.operation_id)))) return null;
    let admission: CheckoutAdmission | undefined;
    if (environment === "production") {
      if ((value.surface !== "chrome_desktop" && value.surface !== "firefox_desktop") ||
        typeof value.build !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(value.build)) return null;
      admission = { surface: value.surface, build: value.build };
    }
    return { ...(admission ? { admission } : {}), ...(typeof value.operation_id === "string" ? { operation: value.operation_id.toLowerCase() } : {}) };
  } catch { return null; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
function identity(operation: PurchaseOperation): CheckoutOperation { return { operationId: operation.operation_id, holderId: operation.holder }; }
function scoped(operation: PurchaseOperation, holder: string, deps: ManagedCheckoutProcessingDeps): boolean {
  return operation.holder === holder && operation.environment === deps.environment && operation.configuration_hash === deps.configurationHash;
}
const statusResponse = (operation: PurchaseOperation, extra: Record<string,unknown> = {}) => jsonResponse(200, {
  operation_id: operation.operation_id, status: operation.status, ...extra,
});
const unavailable = () => jsonResponse(502,{ error: "checkout_unavailable" });

export function handleManagedCheckout(req: Request, runtime: ManagedCheckoutRequestDeps, complete: boolean): Promise<Response> {
  return withAuthenticatedUser(req,runtime,async holder => {
    const limited = await enforceRateLimit(runtime.limiter,"checkout",holder,req,CHECKOUT_RATE);
    if (limited) return limited;
    const input = await body(req,complete,runtime.environment);
    if (!input) return jsonResponse(400,{ error: "invalid_checkout_request" });
    const deps = { ...runtime,operations: runtime.operationStore(input.admission) };
    const bearer = req.headers.get("Authorization")!.slice(7);
    let validUntil = 0;
    const authorize = async () => { validUntil = await authorized(bearer,holder,deps) ?? 0; return validUntil > Date.now(); };
    const isCurrent = () => validUntil > Date.now();
    const canGrant = async () => await authorize() && await runtime.canGrant(holder) && isCurrent();
    if (!await authorize()) return jsonResponse(403,{ error: "confirmed_account_required" });
    try {
      let operation = input.operation ? await deps.operations.read(input.operation,holder) : null;
      if (input.operation && !operation) return jsonResponse(404,{ error: "checkout_operation_not_found" });
      if (!operation) {
        if (complete || !await canGrant()) return jsonResponse(403,{ error: runtime.admissionError });
        operation = await deps.operations.prepare(crypto.randomUUID(),holder,deps.configurationHash);
      }
      if (!scoped(operation,holder,deps)) return unavailable();
      if (["refunded","closed_unpaid"].includes(operation.status)) return await authorize() ? statusResponse(operation) : unavailable();
      let recovery: CheckoutRecovery | { readonly status: "unavailable" };
      if (operation.stripe_session_id) recovery = await deps.billing.recoverCheckout(identity(operation),operation.stripe_session_id);
      else if (operation.creation_started_at) recovery = await deps.billing.recoverUnknownCheckout(identity(operation),Date.parse(operation.creation_started_at));
      else {
        if (complete || !await canGrant()) return await authorize() ? statusResponse(operation) : unavailable();
        // Refuse a known current account purchase before a NEW payment handoff. An unknown
        // first-customer RC lookup cannot prove absence and supplies no grant, but is not a
        // blanket first-purchase prohibition. The one-open operation still fences retries.
        if (deps.access) {
          const observation = await deps.access.rights.begin(holder,deps.environment);
          const existing = await (await reconcileScopedAccess(holder,deps.access,observation,{}, { authorize,canGrant })).json();
          if (existing.access?.status === "verified" && existing.access.proofs?.length) return jsonResponse(409,{ error: "already_entitled", operation_id: operation.operation_id });
        }
        if (!await canGrant()) return await authorize() ? statusResponse(operation) : unavailable();
        const claim = await deps.operations.claimCreation(operation.operation_id,holder,deps.configurationHash);
        operation = claim.operation;
        if (!scoped(operation,holder,deps)) return unavailable();
        if (claim.claimed) {
          if (!await canGrant()) return await authorize() ? statusResponse(operation) : unavailable();
          recovery = await deps.billing.createCheckout(identity(operation),Date.parse(operation.creation_started_at!));
        } else if (operation.stripe_session_id) recovery = await deps.billing.recoverCheckout(identity(operation),operation.stripe_session_id);
        else recovery = await deps.billing.recoverUnknownCheckout(identity(operation),Date.parse(operation.creation_started_at!));
      }
      return processManagedCheckout(operation,recovery,deps,{ authorize,canGrant,isCurrent });
    } catch { return unavailable(); }
  });
}
