import { handleProductPolicyRead } from "./handler.ts";
import { createWriterSql } from "../_shared/pg-store.ts";
import { PgPolicyReader } from "./pg-policy-reader.ts";
// The reader login is a function secret; it can only call private.read_product_policy.
const sql = createWriterSql(Deno.env.get("PRODUCT_POLICY_READER_DB_URL") ?? "");
const reader = new PgPolicyReader(sql);
Deno.serve((req) => handleProductPolicyRead(req, { reader }));
