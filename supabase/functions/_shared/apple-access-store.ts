import type postgres from "postgres";
import type { AccessEnvironment } from "@still/shared-types";
import type { AccountRight } from "./access-issuer.ts";
import type { VerifiedAppleTransaction } from "./apple-access.ts";

export type AppleAccessCommit = {
  readonly status: "verified" | "linked" | "already_linked";
  readonly right: AccountRight; readonly issuer_time: number;
} | { readonly status: "owned_elsewhere" | "stale" | "revoked" };
export interface AppleAccessLink {
  readonly holder: string; readonly operation: string; readonly expectedRevision: number;
  /** BOTH accounts are independently authenticated on explicit transfer. */
  readonly sourceHolder?: string;
}
export interface AppleAccessStore {
  begin(transaction: VerifiedAppleTransaction): Promise<string>;
  commit(transaction: VerifiedAppleTransaction, token: string, link?: AppleAccessLink): Promise<AppleAccessCommit>;
  confirm(transaction: VerifiedAppleTransaction, token: string, right: AccountRight): Promise<boolean>;
}
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const safe = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export class PgAppleAccessStore implements AppleAccessStore {
  constructor(private readonly sql: ReturnType<typeof postgres>, private readonly environment: AccessEnvironment) {}
  async begin(tx: VerifiedAppleTransaction): Promise<string> {
    if (tx.environment !== this.environment) throw new Error("Apple environment mismatch");
    const rows = await this.sql<{ token: string }[]>`select public.begin_apple_access_observation(
      ${tx.key}, ${tx.environment}, ${tx.bundleId}, ${tx.productId}, ${tx.originalTransactionId}) as token`;
    if (!uuid(rows[0]?.token)) throw new Error("Apple observation unavailable");
    return rows[0].token;
  }
  async commit(tx: VerifiedAppleTransaction, token: string, link?: AppleAccessLink): Promise<AppleAccessCommit> {
    if (tx.environment !== this.environment) throw new Error("Apple environment mismatch");
    const rows = await this.sql<{ result: AppleAccessCommit }[]>`select public.commit_apple_access_observation(
      ${tx.key}, ${tx.environment}, ${token}::uuid, ${tx.active}, ${link?.holder ?? null}::uuid,
      ${link?.operation ?? null}::uuid, ${link?.expectedRevision ?? null}::bigint,
      ${link?.sourceHolder ?? null}::uuid) as result`;
    const result = rows[0]?.result;
    if (!result || !["verified", "linked", "already_linked", "owned_elsewhere", "stale", "revoked"].includes(result.status)) throw new Error("Apple commit unavailable");
    if (result.status === "verified" || result.status === "linked" || result.status === "already_linked") {
      if (!uuid(result.right.right) || !uuid(result.right.holder) || !safe(result.right.revision) ||
        !safe(result.right.verified_at) || !safe(result.issuer_time) || result.issuer_time < result.right.verified_at ||
        result.right.holder !== (link?.holder ?? result.right.right) ||
        (link && result.right.revision !== link.expectedRevision && result.right.revision !== link.expectedRevision + 1)) throw new Error("Invalid Apple commit");
    }
    return result;
  }
  async linkedTransactions(holder: string, environment: AccessEnvironment): Promise<readonly VerifiedAppleTransaction[]> {
    if (environment !== this.environment || !uuid(holder)) throw new Error("Invalid Apple account scope");
    const rows = await this.sql<{ result: unknown }[]>`select public.read_linked_apple_transactions(${holder}::uuid, ${environment}) as result`;
    const value = rows[0]?.result;
    if (!Array.isArray(value) || value.length > 16 || value.some(tx => !tx || typeof tx !== "object" ||
      tx.environment !== environment || !/^[0-9a-f]{64}$/.test(tx.key) || tx.productId !== "still_pro_v3" ||
      typeof tx.bundleId !== "string" || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(tx.bundleId) ||
      typeof tx.originalTransactionId !== "string" || !/^[1-9][0-9]{0,39}$/.test(tx.originalTransactionId) ||
      tx.transactionId !== tx.originalTransactionId || tx.active !== true)) throw new Error("Invalid Apple account transactions");
    return value as VerifiedAppleTransaction[];
  }
  async confirm(tx: VerifiedAppleTransaction, token: string, right: AccountRight): Promise<boolean> {
    const rows = await this.sql<{ confirmed: boolean }[]>`select public.confirm_apple_access_observation(
      ${tx.key}, ${tx.environment}, ${token}::uuid, ${right.right}::uuid, ${right.holder}::uuid,
      ${right.revision}::bigint, ${right.verified_at}::bigint) as confirmed`;
    if (typeof rows[0]?.confirmed !== "boolean") throw new Error("Apple confirmation unavailable");
    return rows[0].confirmed;
  }
}

export interface AppleAccountAccessStore extends AppleAccessStore {
  linkedTransactions(holder: string, environment: AccessEnvironment): Promise<readonly VerifiedAppleTransaction[]>;
}
