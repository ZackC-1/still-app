import { handleProductPolicyAdmin } from "./handler.ts";
import { authenticatedClaims } from "../_shared/jwt.ts";
import { createWriterSql } from "../_shared/pg-store.ts";
import { PgPolicyAdminStore } from "./pg-policy-admin-store.ts";
import { PAID_CUTOFF_SNAPSHOT } from "./cutoff.ts";
// The admin login is a function secret; it can only call the three owner routes, each of which
// checks the verified subject against the database's owner allowlist.
const sql = createWriterSql(Deno.env.get("PRODUCT_POLICY_ADMIN_DB_URL") ?? "");
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const store = new PgPolicyAdminStore(sql);
Deno.serve((req) =>
  handleProductPolicyAdmin(req, {
    jwtSecret: Deno.env.get("SUPABASE_JWT_SECRET") ?? "",
    jwksUrl: supabaseUrl
      ? `${supabaseUrl}/auth/v1/.well-known/jwks.json`
      : undefined,
    expected: authenticatedClaims(supabaseUrl || undefined),
    store,
    cutoffSnapshot: PAID_CUTOFF_SNAPSHOT,
  })
);
