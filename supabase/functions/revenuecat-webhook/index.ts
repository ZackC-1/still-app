import { handleWebhook } from "./handler.ts";
import { HttpRevenueCatClient } from "../_shared/revenuecat.ts";
import { createWriterSql, PgEntitlementStore } from "../_shared/pg-store.ts";
import { productionWebhookAccess } from "./access-runtime.ts";

// Entrypoint (config.toml: verify_jwt=false). Connects as the narrow entitlement-writer role.
const sql = createWriterSql(Deno.env.get("ENTITLEMENT_WRITER_DB_URL") ?? "");
const store = new PgEntitlementStore(sql);
const rc = new HttpRevenueCatClient(Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "");
const token = Deno.env.get("REVENUECAT_WEBHOOK_TOKEN") ?? "";

const productionAccess = Deno.env.get("ACCESS_PROOF_ENVIRONMENT") === undefined ? undefined : productionWebhookAccess(name => Deno.env.get(name), sql);
Deno.serve((req) => handleWebhook(req, { token, store, rc, productionAccess }));
