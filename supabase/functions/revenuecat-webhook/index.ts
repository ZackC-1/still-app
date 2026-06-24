import { handleWebhook } from "./handler.ts";
import { HttpRevenueCatClient } from "../_shared/revenuecat.ts";
import { PgEntitlementStore } from "../_shared/pg-store.ts";

// Entrypoint (config.toml: verify_jwt=false). Connects as the narrow entitlement-writer role.
const store = new PgEntitlementStore(Deno.env.get("ENTITLEMENT_WRITER_DB_URL") ?? "");
const rc = new HttpRevenueCatClient(Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "");
const token = Deno.env.get("REVENUECAT_WEBHOOK_TOKEN") ?? "";

Deno.serve((req) => handleWebhook(req, { token, store, rc }));
