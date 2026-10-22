import type postgres from "postgres";
import type { AccountRight } from "./access-issuer.ts";
import type { VerifiedAppleTransaction } from "./apple-access.ts";
import type { AppleAccessCommit, AppleAccessLink, AppleAccessStore } from "./apple-access-store.ts";

const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const safe = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function validate(tx: VerifiedAppleTransaction): void {
  if (tx.environment !== "sandbox" || tx.productId !== "still_pro_v3" || !/^[0-9a-f]{64}$/.test(tx.key)) {
    throw new Error("Invalid Apple review transaction");
  }
}

/** Fixed isolated ledger; deliberately has no account-read/link/transfer API. */
export class PgAppleReviewAccessStore implements AppleAccessStore {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  async begin(tx: VerifiedAppleTransaction): Promise<string> {
    validate(tx);
    const rows = await this.sql<{ token: string }[]>`select public.begin_apple_sandbox_review_observation(
      ${tx.key}, ${tx.bundleId}, ${tx.productId}, ${tx.originalTransactionId}) as token`;
    if (!uuid(rows[0]?.token)) throw new Error("Apple review observation unavailable");
    return rows[0].token;
  }
  async commit(tx: VerifiedAppleTransaction, token: string, link?: AppleAccessLink): Promise<AppleAccessCommit> {
    validate(tx);
    if (link || !uuid(token)) throw new Error("Apple review cannot link an account");
    const rows = await this.sql<{ result: AppleAccessCommit }[]>`select public.commit_apple_sandbox_review_observation(
      ${tx.key}, ${token}::uuid, ${tx.active}) as result`;
    const result = rows[0]?.result;
    if (result?.status === "stale" || result?.status === "revoked") return result;
    if (result?.status !== "verified" || !result.right || !uuid(result.right.right) ||
      result.right.holder !== result.right.right || !safe(result.right.revision) ||
      !safe(result.right.verified_at) || result.issuer_time !== result.right.verified_at) {
      throw new Error("Invalid Apple review commit");
    }
    return result;
  }
  async confirm(tx: VerifiedAppleTransaction, token: string, right: AccountRight): Promise<boolean> {
    validate(tx);
    if (!uuid(token) || !uuid(right.right) || right.holder !== right.right || !safe(right.revision) || !safe(right.verified_at)) {
      throw new Error("Invalid Apple review confirmation");
    }
    const rows = await this.sql<{ confirmed: boolean }[]>`select public.confirm_apple_sandbox_review_observation(
      ${tx.key}, ${token}::uuid, ${right.right}::uuid, ${right.revision}::bigint, ${right.verified_at}::bigint) as confirmed`;
    if (typeof rows[0]?.confirmed !== "boolean") throw new Error("Apple review confirmation unavailable");
    return rows[0].confirmed;
  }
}
