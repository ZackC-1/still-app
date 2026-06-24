import { handleReconcile } from "./handler.ts";
import { HttpRevenueCatClient } from "../_shared/revenuecat.ts";
import { PgEntitlementStore } from "../_shared/pg-store.ts";

// Entrypoint (config.toml: verify_jwt=true). The platform verifies the JWT; the handler verifies it
// again and derives the subject only from it. Writes via the narrow entitlement-writer role.
const store = new PgEntitlementStore(Deno.env.get("ENTITLEMENT_WRITER_DB_URL") ?? "");
const rc = new HttpRevenueCatClient(Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "");
const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";

Deno.serve((req) => handleReconcile(req, { jwtSecret, store, rc }));
