import { authenticatedClaims } from "./jwt.ts";
import { createWriterSql, PgRateLimiter } from "./pg-store.ts";
import { createAccessSigner } from "./access-issuer.ts";
import { createAppleAccessVerifier } from "./apple-access.ts";
import { PgAppleAccessStore } from "./apple-access-store.ts";
import { HttpConfirmedAppleAccounts, type AppleFulfillmentDeps } from "./apple-fulfillment.ts";
import type { AccessEnvironment } from "@still/shared-types";
import type { AppleAccessStore } from "./apple-access-store.ts";

export interface AppleFulfillmentRuntimeConfig {
  readonly environment?: string;
  readonly writerDbUrl: string;
  readonly signer: Omit<Parameters<typeof createAccessSigner>[0], "environment">;
  readonly apple: Omit<Parameters<typeof createAppleAccessVerifier>[0], "environment">;
  readonly auth: { readonly supabaseUrl: string; readonly jwtSecret: string; readonly publicApiKey: string };
}

/** Explicit storage is mandatory: QA composition must supply fixed-sandbox RPC adapters. */
export interface AppleFulfillmentRuntimePorts {
  readonly limiter: AppleFulfillmentDeps["limiter"];
  readonly createStore: (environment: AccessEnvironment) => AppleAccessStore;
  readonly accounts?: AppleFulfillmentDeps["accounts"];
}

/** Existing live names/defaults only; shared Auth identity is separate from paid authority. */
export function readAppleFulfillmentRuntimeConfig(read: (name: string) => string | undefined): AppleFulfillmentRuntimeConfig {
  return { environment: read("ACCESS_PROOF_ENVIRONMENT"), writerDbUrl: read("ENTITLEMENT_WRITER_DB_URL") ?? "",
    signer: { kid: read("ACCESS_PROOF_KEY_ID"), privateKeyPkcs8Base64: read("ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64"),
      publicKeyHex: read("ACCESS_PROOF_PUBLIC_KEY_HEX") },
    apple: { productsJson: read("ACCESS_APPLE_PRODUCTS_JSON"), apiPrivateKey: read("APP_STORE_SERVER_PRIVATE_KEY"),
      apiKeyId: read("APP_STORE_SERVER_KEY_ID"), apiIssuerId: read("APP_STORE_SERVER_ISSUER_ID") },
    auth: { supabaseUrl: read("SUPABASE_URL") ?? "", jwtSecret: read("SUPABASE_JWT_SECRET") ?? "",
      publicApiKey: read("SUPABASE_ANON_KEY") ?? "" } };
}

/** No environment reads or fallback SQL construction at this explicit composition boundary. */
export async function createAppleFulfillmentRuntimeFromConfig(config: AppleFulfillmentRuntimeConfig,
  ports: AppleFulfillmentRuntimePorts): Promise<AppleFulfillmentDeps> {
  const signer = await createAccessSigner({ ...config.signer, environment: config.environment });
  const verifier = createAppleAccessVerifier({ ...config.apple, environment: signer?.environment });
  const { supabaseUrl: url, jwtSecret, publicApiKey } = config.auth;
  return { jwtSecret, jwksUrl: url ? `${url}/auth/v1/.well-known/jwks.json` : undefined,
    expected: authenticatedClaims(url || undefined), limiter: ports.limiter,
    accounts: ports.accounts ?? new HttpConfirmedAppleAccounts(url, publicApiKey),
    access: signer && verifier ? { signer, verifier, store: ports.createStore(signer.environment) } : undefined };
}

/** Server environment only; absent reviewed mappings/secrets keep dependent issuance unavailable. */
export async function createAppleFulfillmentRuntime(): Promise<AppleFulfillmentDeps> {
  const config = readAppleFulfillmentRuntimeConfig(name => Deno.env.get(name));
  const sql = createWriterSql(config.writerDbUrl);
  return await createAppleFulfillmentRuntimeFromConfig(config, { limiter: new PgRateLimiter(sql),
    createStore: environment => new PgAppleAccessStore(sql, environment) });
}
