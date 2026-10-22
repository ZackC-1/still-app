import type postgres from "postgres";
import { importPKCS8 } from "jose";
import { bytesToHex } from "@noble/hashes/utils.js";
import { authenticatedClaims } from "./jwt.ts";
import { withAuthenticatedUser } from "./auth.ts";
import { jsonResponse } from "./store.ts";
import { createWriterSql, PgRateLimiter } from "./pg-store.ts";
import { readAppleFulfillmentRuntimeConfig, createAppleFulfillmentRuntimeFromConfig } from "./apple-access-runtime.ts";
import { createAccessSigner } from "./access-issuer.ts";
import { createAppleAccessVerifier } from "./apple-access.ts";
import { PgAppleAccessStore } from "./apple-access-store.ts";
import { VerifiedAppleAccountRefresher } from "./apple-account-access.ts";
import { PgAccessRightStore } from "./pg-access-store.ts";
import { HttpRevenueCatAccessClient } from "./revenuecat-access.ts";
import { ManagedCheckout, STRIPE_API_VERSION } from "./managed-checkout.ts";
import { readManagedCheckoutBindings } from "./managed-checkout-config.ts";
import { PgPurchaseOperationStore } from "./purchase-operation-store.ts";
import { handleManagedCheckout, type ManagedCheckoutRequestDeps } from "./managed-checkout-handler.ts";

const INPUTS = ["STRIPE_SECRET_API_KEY", "STRIPE_ACCOUNT_ID", "STRIPE_API_VERSION", "STRIPE_PRICE_ID", "STRIPE_PRODUCT_ID",
  "REVENUECAT_STRIPE_PUBLIC_API_KEY", "WEB_RETURN_ORIGIN", "WEB_RETURN_PATHS_JSON", "REVENUECAT_PROJECT_ID",
  "REVENUECAT_ACCESS_SECRET_API_KEY", "ACCESS_PROVIDER_PRODUCTS_JSON", "ACCESS_PROOF_ENVIRONMENT", "ACCESS_PROOF_KEY_ID",
  "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", "ACCESS_PROOF_PUBLIC_KEY_HEX", "ACCESS_APPLE_PRODUCTS_JSON",
  "APP_STORE_SERVER_PRIVATE_KEY", "APP_STORE_SERVER_KEY_ID", "APP_STORE_SERVER_ISSUER_ID", "ENTITLEMENT_WRITER_DB_URL",
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET"] as const;

/** Fixed live namespace. Incomplete configuration cannot fall back to QA or the legacy link. */
export async function readProductionCheckoutConfig(read: (name: string) => string | undefined) {
  const values: Record<string, string> = {};
  for (const name of INPUTS) values[name] = read(name) ?? "";
  if (values.ACCESS_PROOF_ENVIRONMENT !== "production") return null;
  const get = (name: string) => values[name] ?? "";
  const bindings = readManagedCheckoutBindings(get,"production");
  if (!bindings) return null;
  const apple = readAppleFulfillmentRuntimeConfig(get);
  try {
    const db = new URL(apple.writerDbUrl), auth = new URL(apple.auth.supabaseUrl);
    const writer = decodeURIComponent(db.username);
    const project = /^([a-z0-9]{20})\.supabase\.co$/.exec(auth.hostname)?.[1];
    // Supabase poolers select the project through the username; bind that suffix to Auth.
    const poolerWriter = project && !auth.port &&
      /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(db.hostname) &&
      ["", "5432", "6543"].includes(db.port) && writer === `still_entitlement_writer.${project}`;
    if (!["postgres:","postgresql:"].includes(db.protocol) || !db.hostname || !db.password || db.hash || db.pathname.length < 2 ||
      (writer !== "still_entitlement_writer" && !poolerWriter) || auth.protocol !== "https:" || auth.username || auth.password ||
      auth.search || auth.hash || auth.pathname !== "/" || !apple.auth.publicApiKey) return null;
    if (!await createAccessSigner({ ...apple.signer,environment: "production" }) ||
      !createAppleAccessVerifier({ ...apple.apple,environment: "production" })) return null;
    await importPKCS8(apple.apple.apiPrivateKey!,"ES256");
    const bytes = new TextEncoder().encode(JSON.stringify(["still-production-checkout-binding-v1","production",STRIPE_API_VERSION,999,values]));
    const digest = await crypto.subtle.digest("SHA-256",bytes);
    bytes.fill(0);
    return Object.freeze({ ...bindings,apple,configurationHash: bytesToHex(new Uint8Array(digest)) });
  } catch { return null; }
}

export async function readProductionCheckoutRuntime(read: (name: string) => string | undefined,
  createSql: (url: string) => ReturnType<typeof postgres> = createWriterSql): Promise<ManagedCheckoutRequestDeps | null> {
  const config = await readProductionCheckoutConfig(read);
  if (!config) return null;
  const sql = createSql(config.apple.writerDbUrl);
  const limiter = new PgRateLimiter(sql);
  const appleStore = new PgAppleAccessStore(sql,"production");
  const apple = await createAppleFulfillmentRuntimeFromConfig(config.apple,{ limiter,createStore: () => appleStore });
  if (!apple.accounts || !apple.access || apple.access.signer.environment !== "production") return null;
  // Optional analytics configuration is deliberately outside the payment configuration hash.
  const key = read("POSTHOG_PROJECT_KEY")?.trim();
  const analyticsDigest = key && read("ANALYTICS_SUBJECTS_ENABLED") === "true"
    ? bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key)))) : null;
  return { jwtSecret: apple.jwtSecret,jwksUrl: apple.jwksUrl,expected: apple.expected,accounts: apple.accounts,limiter,
    environment: "production",configurationHash: config.configurationHash,
    operationStore: (admission,analytics) => new PgPurchaseOperationStore(sql,"production",admission,
      analyticsDigest && analytics?.projectKeySha256 === analyticsDigest ? analytics.originProof : undefined),
    billing: new ManagedCheckout(config.billing),
    // Stopped sales blocks new SQL admission, not fulfilment of already-paid purchases.
    // Confirmed Auth, canonical provider evidence and SQL observations still fence every proof.
    canGrant: () => Promise.resolve(true),admissionError: "sales_unavailable",
    access: { signer: apple.access.signer,rights: new PgAccessRightStore(sql),
      provider: new HttpRevenueCatAccessClient(config.revenueCatSecret,config.project,config.mappings,"production"),
      apple: new VerifiedAppleAccountRefresher(appleStore,apple.access.verifier) } };
}

export function handleProductionCheckout(req: Request, deps: ManagedCheckoutRequestDeps, complete: boolean): Promise<Response> {
  // The route cannot be switched to sandbox through a supplied composition object.
  if (deps.environment !== "production") return Promise.resolve(jsonResponse(502,{ error: "checkout_unavailable" }));
  return handleManagedCheckout(req,deps,complete);
}

export function handleProductionCheckoutUnavailable(req: Request, read: (name: string) => string | undefined): Promise<Response> {
  const url = read("SUPABASE_URL")?.replace(/\/$/,"") ?? "";
  return withAuthenticatedUser(req,{ jwtSecret: read("SUPABASE_JWT_SECRET") ?? "",jwksUrl: url ? `${url}/auth/v1/.well-known/jwks.json` : undefined,
    expected: authenticatedClaims(url || undefined) },() => Promise.resolve(jsonResponse(502,{ error: "checkout_unavailable" })));
}
