import { authenticatedClaims } from "../_shared/jwt.ts";
import { createWriterSql, PgRateLimiter } from "../_shared/pg-store.ts";
import { postHogConfigFromEnv } from "../_shared/posthog.ts";
import { createAppleAccessVerifier } from "../_shared/apple-access.ts";
import { PgAppleAnalyticsStore } from "./store.ts";
import { capabilityHash, handleApplePurchaseAnalytics } from "./handler.ts";
const read = (name: string) => Deno.env.get(name);
const url = read("SUPABASE_URL") ?? "";
const db = read("ANALYTICS_ERASER_DB_URL");
const sql = db ? createWriterSql(db) : null;
const project = postHogConfigFromEnv(read).projectKey?.trim();
const digest = project ? capabilityHash(project) : Promise.resolve(null);
const verifier = createAppleAccessVerifier({
  environment: "production",
  productsJson: read("ACCESS_APPLE_PRODUCTS_JSON"),
  apiPrivateKey: read("APP_STORE_SERVER_PRIVATE_KEY"),
  apiKeyId: read("APP_STORE_SERVER_KEY_ID"),
  apiIssuerId: read("APP_STORE_SERVER_ISSUER_ID"),
});
Deno.serve(async (req) =>
  handleApplePurchaseAnalytics(req, {
    jwtSecret: read("SUPABASE_JWT_SECRET") ?? "",
    jwksUrl: url ? `${url}/auth/v1/.well-known/jwks.json` : undefined,
    expected: authenticatedClaims(url || undefined),
    enabled: read("ANALYTICS_SUBJECTS_ENABLED") === "true" &&
      read("ACCESS_PROOF_ENVIRONMENT") === "production",
    projectKeySha256: await digest,
    limiter: sql ? new PgRateLimiter(sql) : null,
    store: sql ? new PgAppleAnalyticsStore(sql) : null,
    verifier,
  })
);
