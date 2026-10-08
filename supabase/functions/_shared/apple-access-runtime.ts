import { authenticatedClaims } from "./jwt.ts";
import { createWriterSql, PgRateLimiter } from "./pg-store.ts";
import { createAccessSigner } from "./access-issuer.ts";
import { createAppleAccessVerifier } from "./apple-access.ts";
import { PgAppleAccessStore } from "./apple-access-store.ts";
import { HttpConfirmedAppleAccounts, type AppleFulfillmentDeps } from "./apple-fulfillment.ts";

/** Server environment only; absent reviewed mappings/secrets keep dependent issuance unavailable. */
export async function createAppleFulfillmentRuntime(): Promise<AppleFulfillmentDeps> {
  const sql = createWriterSql(Deno.env.get("ENTITLEMENT_WRITER_DB_URL") ?? "");
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const signer = await createAccessSigner({ environment: Deno.env.get("ACCESS_PROOF_ENVIRONMENT"),
    kid: Deno.env.get("ACCESS_PROOF_KEY_ID"), privateKeyPkcs8Base64: Deno.env.get("ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64"),
    publicKeyHex: Deno.env.get("ACCESS_PROOF_PUBLIC_KEY_HEX") });
  const verifier = createAppleAccessVerifier({ environment: signer?.environment,
    productsJson: Deno.env.get("ACCESS_APPLE_PRODUCTS_JSON"), apiPrivateKey: Deno.env.get("APP_STORE_SERVER_PRIVATE_KEY"),
    apiKeyId: Deno.env.get("APP_STORE_SERVER_KEY_ID"), apiIssuerId: Deno.env.get("APP_STORE_SERVER_ISSUER_ID") });
  return { jwtSecret: Deno.env.get("SUPABASE_JWT_SECRET") ?? "", jwksUrl: url ? `${url}/auth/v1/.well-known/jwks.json` : undefined,
    expected: authenticatedClaims(url || undefined), limiter: new PgRateLimiter(sql),
    accounts: new HttpConfirmedAppleAccounts(url, Deno.env.get("SUPABASE_ANON_KEY") ?? ""),
    access: signer && verifier ? { signer, verifier, store: new PgAppleAccessStore(sql, signer.environment) } : undefined };
}
