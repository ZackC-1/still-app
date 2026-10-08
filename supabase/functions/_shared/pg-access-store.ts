import type postgres from "postgres";
import type { AccessEnvironment } from "@still/shared-types";
import { isAccountAccessRemovals, type AccountAccessRemovals, type AccessRightStore, type CommittedAccess, type ProviderRight } from "./access-issuer.ts";

/** Same narrow connection as the existing entitlement writer; no direct ledger privileges. */
export class PgAccessRightStore implements AccessRightStore {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  async begin(holder: string, environment: AccessEnvironment): Promise<string> {
    const rows = await this.sql<{ token: string }[]>`select public.begin_access_observation(${holder}::uuid, ${environment}) as token`;
    const token = rows[0]?.token;
    if (!token || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(token)) throw new Error("Access observation unavailable");
    return token;
  }
  async commit(holder: string, environment: AccessEnvironment, token: string, rights: readonly ProviderRight[]): Promise<CommittedAccess> {
    const rows = await this.sql<{ result: CommittedAccess }[]>`
      select public.commit_access_observation(${holder}::uuid, ${environment}, ${token}::uuid, ${this.sql.json(rights.map(({ key, product, state }) => ({ key, product, ...(state === undefined ? {} : { state }) })))}::jsonb) as result`;
    const result = rows[0]?.result;
    if (!result || !["committed", "conflict", "stale"].includes(result.status)) throw new Error("Access commit unavailable");
    if (result.status !== "stale" && (!Array.isArray(result.rights) || result.rights.length > 16 ||
        !Number.isSafeInteger(result.issuer_time) || result.issuer_time < 0 ||
        !Array.isArray(result.revocations) || result.revocations.length > 64 ||
        result.rights.some(right => right.holder !== holder) ||
        (result.observed_rights !== undefined && (!Array.isArray(result.observed_rights) || result.observed_rights.length > 16 ||
          result.observed_rights.some(observed => !result.rights.some(right => right.right === observed.right && right.holder === observed.holder &&
            right.revision === observed.revision && right.verified_at === observed.verified_at)))))) throw new Error("Invalid access commit");
    return result;
  }
  async removals(holder: string, environment: AccessEnvironment, token: string): Promise<AccountAccessRemovals | null> {
    const rows = await this.sql<{ result: unknown }[]>`select public.read_access_removals(${holder}::uuid, ${environment}, ${token}::uuid) as result`;
    const result = rows[0]?.result;
    if (result === null) return null;
    if (!isAccountAccessRemovals(result, holder, environment)) throw new Error("Invalid access removals");
    return result;
  }
  async confirm(holder: string, environment: AccessEnvironment, token: string): Promise<boolean> {
    const rows = await this.sql<{ confirmed: boolean }[]>`
      select public.confirm_access_observation(${holder}::uuid, ${environment}, ${token}::uuid) as confirmed`;
    if (typeof rows[0]?.confirmed !== "boolean") throw new Error("Access confirmation unavailable");
    return rows[0].confirmed;
  }
}
