// Postgres read port for the public product policy function. Connects ONLY as still_policy_reader
// (migration 0016), whose one privilege is EXECUTE on private.read_product_policy(text, text).
import postgres from "postgres";
import type { PolicyReader } from "./handler.ts";
import type {
  ProductPolicyEnvironment,
  ProductPolicyNamespace,
} from "../../../packages/shared-types/src/product-policy.ts";

export class PgPolicyReader implements PolicyReader {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  async read(
    namespace: ProductPolicyNamespace,
    environment: ProductPolicyEnvironment,
  ): Promise<string | null> {
    try {
      const rows = await this.sql<{ body: string | null }[]>`
        select private.read_product_policy(${namespace}, ${environment}) as body`;
      const body = rows[0]?.body;
      if (body === undefined) throw new Error("missing row");
      return body;
    } catch {
      // Driver errors can carry connection details; never pass them on.
      throw new Error("Product policy storage unavailable");
    }
  }
}
