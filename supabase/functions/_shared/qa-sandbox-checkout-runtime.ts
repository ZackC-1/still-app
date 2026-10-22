import type postgres from "postgres";
import { readManagedCheckoutBindings } from "./managed-checkout-config.ts";
import { handleManagedCheckout } from "./managed-checkout-handler.ts";
import type { ManagedCheckoutBilling } from "./managed-checkout-processor.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { withAuthenticatedUser, type AuthDeps } from "./auth.ts";
import { authenticatedClaims } from "./jwt.ts";
import { jsonResponse } from "./store.ts";
import { type RateLimiter } from "./rate-limit.ts";
import type { ConfirmedAppleAccountPort } from "./apple-fulfillment.ts";
import type { QaSandboxMembership } from "./qa-sandbox-auth.ts";
import { readQaSandboxAppleConfig, type QaSandboxAppleConfig } from "./qa-sandbox-config.ts";
import { createQaSandboxRuntime } from "./qa-sandbox-runtime.ts";
import { createWriterSql } from "./pg-store.ts";
import { HttpRevenueCatAccessClient, type AccessProductMapping } from "./revenuecat-access.ts";
import { QaSandboxManagedCheckout, QA_STRIPE_API_VERSION, type QaManagedCheckoutConfig } from "./qa-sandbox-managed-checkout.ts";
import { PgQaPurchaseOperationStore, type QaPurchaseOperationStore } from "./qa-purchase-operation-store.ts";
import { type ScopedReconcileAccess } from "../reconcile-entitlement/handler.ts";

const PREFIX = "STILL_QA_SANDBOX_";
const PAYMENT_INPUTS = ["STRIPE_SECRET_API_KEY", "STRIPE_ACCOUNT_ID", "STRIPE_API_VERSION", "STRIPE_PRICE_ID", "STRIPE_PRODUCT_ID", "REVENUECAT_STRIPE_PUBLIC_API_KEY", "WEB_RETURN_ORIGIN", "WEB_RETURN_PATHS_JSON", "REVENUECAT_PROJECT_ID", "REVENUECAT_ACCESS_SECRET_API_KEY", "ACCESS_PROVIDER_PRODUCTS_JSON"] as const;
const AUTHORITY_INPUTS = ["ACCESS_PROOF_KEY_ID", "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", "ACCESS_PROOF_PUBLIC_KEY_HEX", "ACCESS_APPLE_PRODUCTS_JSON", "APP_STORE_SERVER_PRIVATE_KEY", "APP_STORE_SERVER_KEY_ID", "APP_STORE_SERVER_ISSUER_ID", "ENTITLEMENT_WRITER_DB_URL"] as const;

export type QaCheckoutBilling = ManagedCheckoutBilling;
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
    const bindings = readManagedCheckoutBindings(get,"sandbox");
    if (!bindings) return null;
    const { stripeSecretKey, environment: _environment, ...shared } = bindings.billing;
    const billing: QaManagedCheckoutConfig = Object.freeze({ ...shared,stripeTestKey: stripeSecretKey });
    const bytes = new TextEncoder().encode(JSON.stringify(["still-qa-checkout-binding-v1", "sandbox", QA_STRIPE_API_VERSION, 999, values]));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    bytes.fill(0);
    const configurationHash = bytesToHex(new Uint8Array(digest));
    return Object.freeze({ apple, billing, project: get("REVENUECAT_PROJECT_ID"), revenueCatSecret: get("REVENUECAT_ACCESS_SECRET_API_KEY"), mappings: bindings.mappings, configurationHash });
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

export function handleQaSandboxCreateCheckout(req: Request, deps: QaSandboxCheckoutDeps): Promise<Response> { return handleManagedCheckout(req,{ ...deps,environment: "sandbox",operationStore: () => deps.operations,canGrant: holder => deps.membership.enabled(holder),admissionError: "qa_membership_required" },false); }
export function handleQaSandboxCompleteCheckout(req: Request, deps: QaSandboxCheckoutDeps): Promise<Response> { return handleManagedCheckout(req,{ ...deps,environment: "sandbox",operationStore: () => deps.operations,canGrant: holder => deps.membership.enabled(holder),admissionError: "qa_membership_required" },true); }

/** Authenticated contract survives missing QA composition; no live payment fallback. */
export function handleQaSandboxCheckoutUnavailable(req: Request, read: (name: string) => string | undefined): Promise<Response> {
  const url = read("SUPABASE_URL") ?? "";
  return withAuthenticatedUser(req,{ jwtSecret: read("SUPABASE_JWT_SECRET") ?? "", jwksUrl: url ? `${url.replace(/\/$/,"")}/auth/v1/.well-known/jwks.json` : undefined,
    expected: authenticatedClaims(url ? url.replace(/\/$/,"") : undefined) },() => Promise.resolve(jsonResponse(502,{ error: "checkout_unavailable" })));
}
