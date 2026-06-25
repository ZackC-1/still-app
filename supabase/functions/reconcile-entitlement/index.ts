import { handleReconcile } from "./handler.ts";
import { authenticatedClaims } from "../_shared/jwt.ts";
import { HttpRevenueCatClient } from "../_shared/revenuecat.ts";
import { PgEntitlementStore } from "../_shared/pg-store.ts";

// Entrypoint (config.toml: verify_jwt=true). The platform verifies the JWT; the handler verifies it
// again and derives the subject only from it. Writes via the narrow entitlement-writer role.
const store = new PgEntitlementStore(Deno.env.get("ENTITLEMENT_WRITER_DB_URL") ?? "");
const rc = new HttpRevenueCatClient(Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "");
// HS256 secret for local Supabase; the JWKS for the hosted project's ES256 tokens. verifyJwt picks
// the right one per the token's alg.
const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const jwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined;
const expected = authenticatedClaims(supabaseUrl || undefined);

Deno.serve((req) => handleReconcile(req, { jwtSecret, jwksUrl, expected, store, rc }));
