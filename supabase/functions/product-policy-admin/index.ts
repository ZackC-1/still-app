import { handleProductPolicyAdmin, ownerAuthDeps } from "./handler.ts";
import { createWriterSql } from "../_shared/pg-store.ts";
import { PgPolicyAdminStore } from "./pg-policy-admin-store.ts";
import { PAID_CUTOFF_SNAPSHOT } from "./cutoff.ts";
// The admin login is a function secret; it can only call the three owner routes, each of which
// checks the verified subject against the database's owner allowlist.
const sql = createWriterSql(Deno.env.get("PRODUCT_POLICY_ADMIN_DB_URL") ?? "");
const auth = ownerAuthDeps(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_JWT_SECRET") ?? "",
);
const store = new PgPolicyAdminStore(sql);
Deno.serve((req) =>
  handleProductPolicyAdmin(req, {
    ...auth,
    store,
    cutoffSnapshot: PAID_CUTOFF_SNAPSHOT,
  })
);
