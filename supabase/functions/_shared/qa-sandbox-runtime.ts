import type postgres from "postgres";
import { authenticatedClaims } from "./jwt.ts";
import { withAuthenticatedUser, confirmedAccountExpiry as confirmed, type AuthDeps } from "./auth.ts";
import { type AppleAccessVerifier } from "./apple-access.ts";
import { createAppleFulfillmentRuntimeFromConfig } from "./apple-access-runtime.ts";
import { HttpConfirmedAppleAccounts, type AppleFulfillmentDeps, type ConfirmedAppleAccountPort } from "./apple-fulfillment.ts";
import { VerifiedAppleAccountRefresher } from "./apple-account-access.ts";
import { PgQaSandboxMembership, type QaSandboxMembership } from "./qa-sandbox-auth.ts";
import { QaSandboxAccessRightStore, QaSandboxAppleAccessStore, QaSandboxPgRateLimiter } from "./qa-sandbox-store.ts";
import { readQaSandboxAppleConfig, type QaSandboxAppleConfig } from "./qa-sandbox-config.ts";
import { createWriterSql } from "./pg-store.ts";
import { HttpRevenueCatAccessClient, parseAccessProductMappings, type RevenueCatAccessClient } from "./revenuecat-access.ts";
import { enforceRateLimit, type RateLimiter } from "./rate-limit.ts";
import { jsonResponse, optionsResponse } from "./store.ts";
import { accessRequest, reconcileScopedAccess, RECONCILE_RATE_LIMIT, type ScopedReconcileAccess } from "../reconcile-entitlement/handler.ts";

export interface QaSandboxReconcileDeps extends AuthDeps {
  readonly limiter: RateLimiter;
  readonly accounts: ConfirmedAppleAccountPort;
  readonly membership: QaSandboxMembership;
  readonly access?: ScopedReconcileAccess;
}
export interface QaSandboxRuntime { readonly apple: AppleFulfillmentDeps; readonly reconcile: QaSandboxReconcileDeps; }
/** Trusted server/test ports only. No HTTP input selects a store, provider, environment or config. */
export interface QaSandboxRuntimePorts {
  readonly sql: ReturnType<typeof postgres>;
  readonly accounts?: ConfirmedAppleAccountPort;
  readonly appleVerifier?: AppleAccessVerifier;
  readonly provider?: RevenueCatAccessClient;
}

/** Preserve existing Apple fulfillment and fixed QA RPCs; local verification requires no account. */
export async function createQaSandboxRuntime(config: QaSandboxAppleConfig, ports: QaSandboxRuntimePorts): Promise<QaSandboxRuntime> {
  if (config.environment !== "sandbox") throw new Error("Invalid QA environment");
  const limiter = new QaSandboxPgRateLimiter(ports.sql);
  const store = new QaSandboxAppleAccessStore(ports.sql);
  const accounts = ports.accounts ?? new HttpConfirmedAppleAccounts(config.auth.supabaseUrl, config.auth.publicApiKey);
  const apple = await createAppleFulfillmentRuntimeFromConfig(config, { limiter, accounts, createStore: () => store });
  const signer = apple.access?.signer;
  const verifier = ports.appleVerifier ?? apple.access?.verifier;
  const access = signer && verifier ? { signer, verifier, store } : undefined;
  return { apple: { ...apple, access }, reconcile: {
    jwtSecret: config.auth.jwtSecret, jwksUrl: `${config.auth.supabaseUrl}/auth/v1/.well-known/jwks.json`,
    expected: authenticatedClaims(config.auth.supabaseUrl), limiter, accounts, membership: new PgQaSandboxMembership(ports.sql),
    access: signer && verifier ? { signer, provider: ports.provider ?? { getRights: () => Promise.resolve({ status: "unavailable" as const }) },
      rights: new QaSandboxAccessRightStore(ports.sql), apple: new VerifiedAppleAccountRefresher(store, verifier) } : undefined,
  } };
}

/** Missing QA inputs never use live provider secrets or a production SQL client. */
export async function readQaSandboxRuntime(read: (name: string) => string | undefined,
  createSql: (url: string) => ReturnType<typeof postgres> = createWriterSql): Promise<QaSandboxRuntime | null> {
  const config = await readQaSandboxAppleConfig(read);
  if (!config) return null;
  const products = parseAccessProductMappings(read("STILL_QA_SANDBOX_ACCESS_PROVIDER_PRODUCTS_JSON") ?? "");
  const project = read("STILL_QA_SANDBOX_REVENUECAT_PROJECT_ID") ?? "";
  const secret = read("STILL_QA_SANDBOX_REVENUECAT_ACCESS_SECRET_API_KEY") ?? "";
  const provider = products && /^[A-Za-z0-9_-]{1,96}$/.test(project) && secret
    ? new HttpRevenueCatAccessClient(secret, project, products) : undefined;
  return await createQaSandboxRuntime(config, { sql: createSql(config.writerDbUrl), provider });
}

/** Live Auth remains separate from membership: disabled subjects can process known refunds. */
export function handleQaSandboxReconcile(req: Request, deps: QaSandboxReconcileDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async holder => {
    const limited = await enforceRateLimit(deps.limiter, "reconcile", holder, req, RECONCILE_RATE_LIMIT);
    if (limited) return limited;
    if (await accessRequest(req) !== "scoped") return jsonResponse(400, { error: "invalid_access_request" });
    const bearer = req.headers.get("Authorization")!.slice(7);
    const expiresAt = await confirmed(bearer, holder, deps);
    if (!expiresAt) return jsonResponse(403, { error: "confirmed_account_required" });
    const current = () => expiresAt > Date.now();
    const authorize = async () => !!await confirmed(bearer, holder, deps) && current();
    let token: string | null = null;
    try { token = await deps.access?.rights.begin(holder, "sandbox") ?? null; } catch { /* No new authority. */ }
    return reconcileScopedAccess(holder, deps.access, token, {}, { authorize, current,
      canGrant: async () => await authorize() && await deps.membership.enabled(holder) && current() });
  });
}

/** Even an unavailable paid composition keeps the route's authenticated-request contract. */
export function handleQaSandboxUnavailable(req: Request, read: (name: string) => string | undefined,
  kind: "apple-local" | "apple-account" | "reconcile"): Promise<Response> {
  const reply = () => jsonResponse(200, kind === "reconcile" ? { access: { status: "unavailable" } } : { status: "unavailable" });
  if (kind === "apple-local") return Promise.resolve(req.method === "OPTIONS" ? optionsResponse() :
    req.method !== "POST" ? jsonResponse(405, { error: "method_not_allowed" }) : reply());
  const url = read("SUPABASE_URL") ?? "";
  return withAuthenticatedUser(req, { jwtSecret: read("SUPABASE_JWT_SECRET") ?? "",
    jwksUrl: url ? `${url.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json` : undefined,
    expected: authenticatedClaims(url ? url.replace(/\/$/, "") : undefined) }, () => Promise.resolve(reply()));
}
