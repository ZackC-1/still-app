import { handleReconcile } from "./handler.ts";
import { authenticatedClaims } from "../_shared/jwt.ts";
import { HttpRevenueCatClient } from "../_shared/revenuecat.ts";
import { createWriterSql, PgEntitlementStore, PgRateLimiter } from "../_shared/pg-store.ts";
import { createAccessSigner } from "../_shared/access-issuer.ts";
import { PgAppleAccessStore } from "../_shared/apple-access-store.ts";
import { createAppleAccessVerifier } from "../_shared/apple-access.ts";
import { VerifiedAppleAccountRefresher } from "../_shared/apple-account-access.ts";
import { PgAccessRightStore } from "../_shared/pg-access-store.ts";
import { HttpRevenueCatAccessClient, parseAccessProductMappings } from "../_shared/revenuecat-access.ts";

// Entrypoint (config.toml: verify_jwt=true). The platform verifies the JWT; the handler verifies it
// again and derives the subject only from it. Writes via the narrow entitlement-writer role.
// One shared client to the narrow writer role — the store and limiter run over the same pool.
const sql = createWriterSql(Deno.env.get("ENTITLEMENT_WRITER_DB_URL") ?? "");
const store = new PgEntitlementStore(sql);
const limiter = new PgRateLimiter(sql);
const rc = new HttpRevenueCatClient(Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "");
// HS256 secret for local Supabase; the JWKS for the hosted project's ES256 tokens. verifyJwt picks
// the right one per the token's alg.
const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const jwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined;
const expected = authenticatedClaims(supabaseUrl || undefined);
// Independently provisioned issuer key and reviewed provider mapping. Missing/bad material keeps
// scoped issuance unavailable while the existing endpoint/free sync continue normally.
const signer = await createAccessSigner({
  environment: Deno.env.get("ACCESS_PROOF_ENVIRONMENT"), kid: Deno.env.get("ACCESS_PROOF_KEY_ID"),
  privateKeyPkcs8Base64: Deno.env.get("ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64"),
  publicKeyHex: Deno.env.get("ACCESS_PROOF_PUBLIC_KEY_HEX"),
});
const products = parseAccessProductMappings(Deno.env.get("ACCESS_PROVIDER_PRODUCTS_JSON") ?? "");
const project = Deno.env.get("REVENUECAT_PROJECT_ID") ?? "";
const accessSecret = Deno.env.get("REVENUECAT_ACCESS_SECRET_API_KEY") ?? "";
const appleVerifier = createAppleAccessVerifier({ environment: signer?.environment,
  productsJson: Deno.env.get("ACCESS_APPLE_PRODUCTS_JSON"), apiPrivateKey: Deno.env.get("APP_STORE_SERVER_PRIVATE_KEY"),
  apiKeyId: Deno.env.get("APP_STORE_SERVER_KEY_ID"), apiIssuerId: Deno.env.get("APP_STORE_SERVER_ISSUER_ID") });
// Missing Apple configuration still checks for linked Apple rows; absence is safe, existing rows
// hold issuance until their current ownership can be verified rather than renewing an old clock.
const apple = signer ? new VerifiedAppleAccountRefresher(new PgAppleAccessStore(sql, signer.environment),
  appleVerifier ?? { authenticate: () => Promise.resolve(null), refresh: () => Promise.resolve(null) }) : undefined;
const access = signer && products && project && accessSecret ? {
  signer, apple, rights: new PgAccessRightStore(sql), provider: new HttpRevenueCatAccessClient(accessSecret, project, products),
} : undefined;

Deno.serve((req) => handleReconcile(req, { jwtSecret, jwksUrl, expected, store, rc, limiter, access }));
