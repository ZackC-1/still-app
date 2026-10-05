// Postgres owner store. Connects ONLY as still_policy_admin (migration 0016), whose privileges are
// EXECUTE on private.read_product_policy_state, private.preview_product_policy and
// private.apply_product_policy. Every call carries the verified JWT subject; the database checks it
// against the owner allowlist itself.
import postgres from "postgres";
import type {
  ProductPolicyEnvironment,
  ProductPolicyNamespace,
} from "../../../packages/shared-types/src/product-policy.ts";
import { PRODUCT_POLICY_BUILD_PATTERN } from "../../../packages/shared-types/src/product-policy.ts";
import type { PaidCutoffSnapshot } from "./cutoff.ts";
import {
  type ApplyRequest,
  type ApplyResult,
  type PolicyAdminStore,
  PolicyOwnerRequired,
  PolicyRequestRejected,
  type PolicyState,
  type PreviewResult,
} from "./store.ts";

type Sql = ReturnType<typeof postgres>;

/** Map database refusals to their typed meaning and strip every other driver detail. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = error instanceof postgres.PostgresError
      ? error.code
      : undefined;
    if (code === "28000") throw new PolicyOwnerRequired();
    if (code === "22023") throw new PolicyRequestRejected();
    throw new Error("Product policy storage unavailable");
  }
}

/** A Postgres text[] literal. Elements are restricted to the packaged id pattern (no quote, comma,
 * brace, backslash or space), which the database checks again. */
function textArray(values: readonly string[]): string {
  if (!values.every((v) => PRODUCT_POLICY_BUILD_PATTERN.test(v))) {
    throw new PolicyRequestRejected();
  }
  return `{${values.join(",")}}`;
}

export class PgPolicyAdminStore implements PolicyAdminStore {
  constructor(private readonly sql: Sql) {}

  state(
    owner: string,
    namespace: ProductPolicyNamespace,
    environment: ProductPolicyEnvironment,
  ): Promise<PolicyState> {
    return call(async () => {
      const rows = await this.sql<{ result: PolicyState }[]>`
        select private.read_product_policy_state(${owner}::uuid, ${namespace}, ${environment}) as result`;
      const result = rows[0]?.result;
      if (!result) throw new Error("missing row");
      return result;
    });
  }

  preview(
    owner: string,
    namespace: ProductPolicyNamespace,
    environment: ProductPolicyEnvironment,
    expectedRevision: number,
    body: string | null,
    rollbackOf: number | null,
  ): Promise<PreviewResult> {
    return call(async () => {
      const rows = await this.sql<{ result: PreviewResult }[]>`
        select private.preview_product_policy(${owner}::uuid, ${namespace}, ${environment},
          ${expectedRevision}::bigint, ${body}::text, ${rollbackOf}::bigint) as result`;
      const result = rows[0]?.result;
      if (!result) throw new Error("missing row");
      return result;
    });
  }

  apply(
    owner: string,
    request: ApplyRequest,
    cutoff: PaidCutoffSnapshot | null,
  ): Promise<ApplyResult> {
    return call(async () => {
      const benefits = cutoff ? textArray(cutoff.benefits) : null;
      const rows = await this.sql<{ result: ApplyResult }[]>`
        select private.apply_product_policy(${owner}::uuid, ${request.operationId}::uuid, ${request.previewHash},
          ${request.namespace}, ${request.environment}, ${request.expectedRevision}::bigint, ${request.body},
          ${cutoff?.product ?? null}::text, ${benefits}::text[]) as result`;
      const result = rows[0]?.result;
      if (!result) throw new Error("missing row");
      return result;
    });
  }
}
