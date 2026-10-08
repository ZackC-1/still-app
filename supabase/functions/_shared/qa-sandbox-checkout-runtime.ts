import type postgres from "postgres";
import { bytesToHex } from "@noble/hashes/utils.js";
import { withAuthenticatedUser, confirmedAccountExpiry as authorized, type AuthDeps } from "./auth.ts";
import { authenticatedClaims } from "./jwt.ts";
import { isUuid } from "./types.ts";
import { jsonResponse } from "./store.ts";
import { enforceRateLimit, type RateLimiter } from "./rate-limit.ts";
import type { ConfirmedAppleAccountPort } from "./apple-fulfillment.ts";
import type { QaSandboxMembership } from "./qa-sandbox-auth.ts";
import { readQaSandboxAppleConfig, type QaSandboxAppleConfig } from "./qa-sandbox-config.ts";
import { createQaSandboxRuntime } from "./qa-sandbox-runtime.ts";
import { createWriterSql } from "./pg-store.ts";
import { HttpRevenueCatAccessClient, parseAccessProductMappings, type AccessProductMapping } from "./revenuecat-access.ts";
import { QaSandboxManagedCheckout, QA_STRIPE_API_VERSION, type QaManagedCheckoutConfig, type QaCheckoutOperation, type QaCheckoutRecovery } from "./qa-sandbox-managed-checkout.ts";
import { PgQaPurchaseOperationStore, type QaPurchaseOperation, type QaPurchaseOperationStore } from "./qa-purchase-operation-store.ts";
import { reconcileScopedAccess, type ScopedReconcileAccess } from "../reconcile-entitlement/handler.ts";

const PREFIX = "STILL_QA_SANDBOX_";
const PAYMENT_INPUTS = ["STRIPE_SECRET_API_KEY", "STRIPE_ACCOUNT_ID", "STRIPE_API_VERSION", "STRIPE_PRICE_ID", "STRIPE_PRODUCT_ID", "REVENUECAT_STRIPE_PUBLIC_API_KEY", "WEB_RETURN_ORIGIN", "WEB_RETURN_PATHS_JSON", "REVENUECAT_PROJECT_ID", "REVENUECAT_ACCESS_SECRET_API_KEY", "ACCESS_PROVIDER_PRODUCTS_JSON"] as const;
const AUTHORITY_INPUTS = ["ACCESS_PROOF_KEY_ID", "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", "ACCESS_PROOF_PUBLIC_KEY_HEX", "ACCESS_APPLE_PRODUCTS_JSON", "APP_STORE_SERVER_PRIVATE_KEY", "APP_STORE_SERVER_KEY_ID", "APP_STORE_SERVER_ISSUER_ID", "ENTITLEMENT_WRITER_DB_URL"] as const;
const CHECKOUT_RATE = { maxPerUser: 5, maxPerIp: 20, windowSeconds: 60 };

/** Existing pure transport; no injectable path may mint benefits directly. */
export interface QaCheckoutBilling {
  createCheckout(operation: QaCheckoutOperation, creationStartedAtMs: number): Promise<QaCheckoutRecovery | { readonly status: "unavailable" }>;
  recoverCheckout(operation: QaCheckoutOperation, session: string): Promise<QaCheckoutRecovery>;
  recoverUnknownCheckout(operation: QaCheckoutOperation, startedAtMs: number): Promise<QaCheckoutRecovery>;
  trackCompletedPurchase(operation: QaCheckoutOperation, session: string): Promise<{ readonly status: "tracked" | "unavailable" }>;
}
export interface QaSandboxCheckoutDeps extends AuthDeps {
  readonly configurationHash: string;
  readonly accounts: ConfirmedAppleAccountPort;
  readonly membership: QaSandboxMembership;
  readonly limiter: RateLimiter;
  readonly operations: QaPurchaseOperationStore;
  readonly billing: QaCheckoutBilling;
  readonly access?: ScopedReconcileAccess;
}
export interface QaSandboxCheckoutConfig {
  readonly apple: QaSandboxAppleConfig;
  readonly billing: QaManagedCheckoutConfig;
  readonly project: string;
  readonly revenueCatSecret: string;
  readonly mappings: readonly AccessProductMapping[];
  readonly configurationHash: string;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Fingerprint the complete immutable producer/authority binding, including private credential
 * material, without persisting/logging its input. Unresolved rows require this exact fingerprint.
 * Webhook delivery secret is independently rotated: it never changes Session/import production. */
export async function readQaSandboxCheckoutConfig(read: (name: string) => string | undefined): Promise<QaSandboxCheckoutConfig | null> {
  const values: Record<string,string> = {};
  for (const suffix of [...PAYMENT_INPUTS, ...AUTHORITY_INPUTS]) values[PREFIX + suffix] = read(PREFIX + suffix) ?? "";
  for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET"]) values[name] = read(name) ?? "";
  const apple = await readQaSandboxAppleConfig(name => values[name]);
  if (!apple) return null;
  const get = (suffix: string) => values[PREFIX + suffix] ?? "";
  try {
    const origin = new URL(get("WEB_RETURN_ORIGIN"));
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.pathname !== "/" || origin.search || origin.hash ||
      origin.origin !== get("WEB_RETURN_ORIGIN")) return null;
    const paths: unknown = JSON.parse(get("WEB_RETURN_PATHS_JSON"));
    if (!object(paths) || Object.keys(paths).length !== 2 || !Object.hasOwn(paths,"success") || !Object.hasOwn(paths,"cancel")) return null;
    for (const path of [paths.success,paths.cancel]) {
      if (typeof path !== "string" || path.length > 512 || !/^\/[A-Za-z0-9/_-]*$/.test(path) || path.includes("//") ||
        new URL(path,origin).pathname !== path) return null;
    }
    if (paths.success === paths.cancel || get("STRIPE_API_VERSION") !== QA_STRIPE_API_VERSION) return null;
    const mappings = parseAccessProductMappings(get("ACCESS_PROVIDER_PRODUCTS_JSON"));
    const stripe = mappings?.filter(mapping => mapping.store === "stripe");
    if (!mappings || stripe?.length !== 1 || !/^[A-Za-z0-9_-]{1,96}$/.test(get("REVENUECAT_PROJECT_ID")) ||
      !/^[!-~]{1,1024}$/.test(get("REVENUECAT_ACCESS_SECRET_API_KEY"))) return null;
    const billing: QaManagedCheckoutConfig = Object.freeze({ stripeTestKey: get("STRIPE_SECRET_API_KEY"), stripeAccountId: get("STRIPE_ACCOUNT_ID"),
      priceId: get("STRIPE_PRICE_ID"), productId: get("STRIPE_PRODUCT_ID"), revenueCatStripePublicKey: get("REVENUECAT_STRIPE_PUBLIC_API_KEY"),
      successUrl: origin.origin + paths.success, cancelUrl: origin.origin + paths.cancel });
    // Constructor is pure; validates the existing pinned managed contract, no provider requests.
    new QaSandboxManagedCheckout(billing);
    const bytes = new TextEncoder().encode(JSON.stringify(["still-qa-checkout-binding-v1", "sandbox", QA_STRIPE_API_VERSION, 999, values]));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    bytes.fill(0);
    const configurationHash = bytesToHex(new Uint8Array(digest));
    return Object.freeze({ apple, billing, project: get("REVENUECAT_PROJECT_ID"), revenueCatSecret: get("REVENUECAT_ACCESS_SECRET_API_KEY"), mappings, configurationHash });
  } catch { return null; }
}

export async function readQaSandboxCheckoutRuntime(read: (name: string) => string | undefined,
  createSql: (url: string) => ReturnType<typeof postgres> = createWriterSql): Promise<QaSandboxCheckoutDeps | null> {
  const config = await readQaSandboxCheckoutConfig(read);
  if (!config) return null;
  const sql = createSql(config.apple.writerDbUrl);
  const provider = new HttpRevenueCatAccessClient(config.revenueCatSecret, config.project, config.mappings);
  const runtime = await createQaSandboxRuntime(config.apple, { sql, provider });
  return { ...runtime.reconcile, configurationHash: config.configurationHash,
    operations: new PgQaPurchaseOperationStore(sql), billing: new QaSandboxManagedCheckout(config.billing) };
}

async function body(req: Request, complete: boolean): Promise<{ operation?: string } | null> {
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
    if (!object(value) || value.access_schema !== 1 || Object.keys(value).some(key => !["access_schema","operation_id"].includes(key)) ||
      (complete && !Object.hasOwn(value,"operation_id")) ||
      (Object.hasOwn(value,"operation_id") && (typeof value.operation_id !== "string" || !isUuid(value.operation_id)))) return null;
    return { ...(typeof value.operation_id === "string" ? { operation: value.operation_id.toLowerCase() } : {}) };
  } catch { return null; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
function identity(operation: QaPurchaseOperation): QaCheckoutOperation { return { operationId: operation.operation_id, holderId: operation.holder }; }
function scoped(operation: QaPurchaseOperation, holder: string, deps: QaSandboxCheckoutDeps): boolean {
  return operation.holder === holder && operation.environment === "sandbox" && operation.configuration_hash === deps.configurationHash;
}
const statusResponse = (operation: QaPurchaseOperation, extra: Record<string,unknown> = {}) => jsonResponse(200, {
  operation_id: operation.operation_id, status: operation.status, ...extra,
});
const unavailable = () => jsonResponse(502,{ error: "checkout_unavailable" });

/** Shared processing of a server-owned operation and canonical provider readback. Notification
 * handlers may reuse this only AFTER signature and exact existing holder/Session binding checks.
 * Receipt ACK and operation states never create access; only scoped reconciliation can do so. */
export async function processQaSandboxCheckout(operation: QaPurchaseOperation, recovery: QaCheckoutRecovery | { readonly status: "unavailable" },
  deps: QaSandboxCheckoutDeps, guards: { readonly authorize: () => Promise<boolean>; readonly canGrant: () => Promise<boolean>; readonly isCurrent?: () => boolean }): Promise<Response> {
  if (!scoped(operation,operation.holder,deps)) return unavailable();
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
    const token = await deps.access?.rights.begin(current.holder,"sandbox") ?? null;
    const response = await reconcileScopedAccess(current.holder,deps.access,token,{},accessGuards);
    const result = await response.json();
    // This is ACCOUNT access observed after this import ACK, not an invented correlation
    // from a Stripe Session to a particular RevenueCat purchase/right identity.
    if (current.status !== "access_observed" && result.access?.status === "verified" && await accessGuards.canGrant()) {
      current = await deps.operations.recordStatus(current.operation_id,current.stripe_session_id,"access_observed");
    }
    if (!await guards.authorize()) return unavailable();
    if (result.access?.proofs?.length) {
      if (!await accessGuards.canGrant() || !token || !await deps.access?.rights.confirm(current.holder,"sandbox",token)) {
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

function handle(req: Request, deps: QaSandboxCheckoutDeps, complete: boolean): Promise<Response> {
  return withAuthenticatedUser(req,deps,async holder => {
    const limited = await enforceRateLimit(deps.limiter,"checkout",holder,req,CHECKOUT_RATE);
    if (limited) return limited;
    const input = await body(req,complete);
    if (!input) return jsonResponse(400,{ error: "invalid_checkout_request" });
    const bearer = req.headers.get("Authorization")!.slice(7);
    let validUntil = 0;
    const authorize = async () => { validUntil = await authorized(bearer,holder,deps) ?? 0; return validUntil > Date.now(); };
    const isCurrent = () => validUntil > Date.now();
    const canGrant = async () => await authorize() && await deps.membership.enabled(holder) && isCurrent();
    if (!await authorize()) return jsonResponse(403,{ error: "confirmed_account_required" });
    try {
      let operation = input.operation ? await deps.operations.read(input.operation,holder) : null;
      if (input.operation && !operation) return jsonResponse(404,{ error: "checkout_operation_not_found" });
      if (!operation) {
        if (complete || !await canGrant()) return jsonResponse(403,{ error: "qa_membership_required" });
        operation = await deps.operations.prepare(crypto.randomUUID(),holder,deps.configurationHash);
      }
      if (!scoped(operation,holder,deps)) return unavailable();
      if (["refunded","closed_unpaid"].includes(operation.status)) return await authorize() ? statusResponse(operation) : unavailable();
      let recovery: QaCheckoutRecovery | { readonly status: "unavailable" };
      if (operation.stripe_session_id) recovery = await deps.billing.recoverCheckout(identity(operation),operation.stripe_session_id);
      else if (operation.creation_started_at) recovery = await deps.billing.recoverUnknownCheckout(identity(operation),Date.parse(operation.creation_started_at));
      else {
        if (complete || !await canGrant()) return await authorize() ? statusResponse(operation) : unavailable();
        // Refuse a known current account purchase before a NEW payment handoff. An unknown
        // first-customer RC lookup cannot prove absence and supplies no grant, but is not a
        // blanket first-purchase prohibition. The one-open operation still fences retries.
        if (deps.access) {
          const observation = await deps.access.rights.begin(holder,"sandbox");
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
      return processQaSandboxCheckout(operation,recovery,deps,{ authorize,canGrant,isCurrent });
    } catch { return unavailable(); }
  });
}
export function handleQaSandboxCreateCheckout(req: Request, deps: QaSandboxCheckoutDeps): Promise<Response> { return handle(req,deps,false); }
export function handleQaSandboxCompleteCheckout(req: Request, deps: QaSandboxCheckoutDeps): Promise<Response> { return handle(req,deps,true); }

/** Authenticated contract survives missing QA composition; no live payment fallback. */
export function handleQaSandboxCheckoutUnavailable(req: Request, read: (name: string) => string | undefined): Promise<Response> {
  const url = read("SUPABASE_URL") ?? "";
  return withAuthenticatedUser(req,{ jwtSecret: read("SUPABASE_JWT_SECRET") ?? "", jwksUrl: url ? `${url.replace(/\/$/,"")}/auth/v1/.well-known/jwks.json` : undefined,
    expected: authenticatedClaims(url ? url.replace(/\/$/,"") : undefined) },() => Promise.resolve(unavailable()));
}
