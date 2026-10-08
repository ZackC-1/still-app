import type postgres from "postgres";
import type { AccessEnvironment } from "@still/shared-types";
import {
  isAccountAccessRemovals, type AccountAccessRemovals, type AccountRight,
  type AccessRightStore, type CommittedAccess, type ProviderRight,
} from "./access-issuer.ts";
import type { VerifiedAppleTransaction } from "./apple-access.ts";
import type { AppleAccountAccessStore, AppleAccessCommit, AppleAccessLink } from "./apple-access-store.ts";
import { CodedError } from "./coded-error.ts";
import type { RateLimiter } from "./rate-limit.ts";

type Sql = ReturnType<typeof postgres>;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const key = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const accountRight = (value: unknown): value is AccountRight => object(value) && uuid(value.right) && uuid(value.holder) && safe(value.revision) && safe(value.verified_at);

function scope(environment: AccessEnvironment, ...ids: string[]): void {
  if (environment !== "sandbox" || ids.some(id => !uuid(id))) throw new Error("Invalid QA sandbox scope");
}
function transaction(tx: VerifiedAppleTransaction): void {
  if (tx.environment !== "sandbox" || !key(tx.key) || tx.productId !== "still_pro_v3" ||
      typeof tx.bundleId !== "string" || tx.bundleId.length > 160 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(tx.bundleId) ||
      typeof tx.originalTransactionId !== "string" || !/^[1-9][0-9]{0,39}$/.test(tx.originalTransactionId) ||
      typeof tx.transactionId !== "string" || !/^[1-9][0-9]{0,39}$/.test(tx.transactionId) ||
      typeof tx.active !== "boolean" || (tx.localOnly !== undefined && tx.localOnly !== true)) throw new Error("Invalid QA Apple transaction");
}
function confirmed(rows: readonly { confirmed: unknown }[]): boolean {
  if (rows.length !== 1 || typeof rows[0]?.confirmed !== "boolean") throw new Error("QA confirmation unavailable");
  return rows[0].confirmed;
}

/** Fixed sandbox RPCs only. Anonymous local verification has no account/link arguments. */
export class QaSandboxAppleAccessStore implements AppleAccountAccessStore {
  constructor(private readonly sql: Sql) {}
  async begin(tx: VerifiedAppleTransaction): Promise<string> {
    transaction(tx);
    const rows = await this.sql<{ token: unknown }[]>`select public.qa_sandbox_begin_apple_access_observation(
      ${tx.key}, ${tx.bundleId}, ${tx.productId}, ${tx.originalTransactionId}) as token`;
    if (rows.length !== 1 || !uuid(rows[0]?.token)) throw new Error("QA Apple observation unavailable");
    return rows[0].token;
  }
  async commit(tx: VerifiedAppleTransaction, token: string, link?: AppleAccessLink): Promise<AppleAccessCommit> {
    transaction(tx); scope(tx.environment, token);
    // Canonical refunds must ignore rejected/disabled link intent and cannot mint either proof.
    const positiveLink = tx.active ? link : undefined;
    if (positiveLink) {
      scope(tx.environment, positiveLink.holder, positiveLink.operation, ...(positiveLink.sourceHolder === undefined ? [] : [positiveLink.sourceHolder]));
      if (tx.localOnly || !safe(positiveLink.expectedRevision) || positiveLink.expectedRevision >= Number.MAX_SAFE_INTEGER ||
          positiveLink.sourceHolder === positiveLink.holder) throw new Error("Invalid QA Apple link");
    }
    const rows = positiveLink
      ? await this.sql<{ result: unknown }[]>`select public.qa_sandbox_commit_apple_link(
        ${tx.key}, ${token}::uuid, ${tx.active}, ${positiveLink.holder}::uuid,
        ${positiveLink.operation}::uuid, ${positiveLink.expectedRevision}::bigint,
        ${positiveLink.sourceHolder ?? null}::uuid) as result`
      : await this.sql<{ result: unknown }[]>`select public.qa_sandbox_commit_apple_local(
        ${tx.key}, ${token}::uuid, ${tx.active}) as result`;
    const result = rows[0]?.result;
    if (rows.length !== 1 || !object(result)) throw new Error("QA Apple commit unavailable");
    if (result.status === "stale" || result.status === "revoked" || (tx.active && result.status === "owned_elsewhere")) return { status: result.status } as AppleAccessCommit;
    if (!tx.active || result.status !== (positiveLink ? "linked" : "verified") && !(positiveLink && result.status === "already_linked") ||
        !accountRight(result.right) || !safe(result.issuer_time) || result.issuer_time < result.right.verified_at ||
        result.right.holder !== (positiveLink?.holder ?? result.right.right) ||
        (positiveLink && result.right.revision !== positiveLink.expectedRevision && result.right.revision !== positiveLink.expectedRevision + 1)) throw new Error("Invalid QA Apple commit");
    return result as AppleAccessCommit;
  }
  async confirm(tx: VerifiedAppleTransaction, token: string, right: AccountRight): Promise<boolean> {
    transaction(tx); scope(tx.environment, token);
    if (!tx.active || !accountRight(right)) throw new Error("Invalid QA Apple confirmation");
    // A local receipt deliberately uses right==holder even when its transaction is linked.
    const rows = right.holder === right.right
      ? await this.sql<{ confirmed: unknown }[]>`select public.qa_sandbox_confirm_apple_local(
        ${tx.key}, ${token}::uuid, ${right.right}::uuid, ${right.revision}::bigint, ${right.verified_at}::bigint) as confirmed`
      : await this.sql<{ confirmed: unknown }[]>`select public.qa_sandbox_confirm_apple_account(
        ${tx.key}, ${token}::uuid, ${right.right}::uuid, ${right.holder}::uuid,
        ${right.revision}::bigint, ${right.verified_at}::bigint) as confirmed`;
    return confirmed(rows);
  }
  async linkedTransactions(holder: string, environment: AccessEnvironment): Promise<readonly VerifiedAppleTransaction[]> {
    scope(environment, holder);
    const rows = await this.sql<{ result: unknown }[]>`select public.qa_sandbox_read_linked_apple_transactions(${holder}::uuid) as result`;
    const result = rows[0]?.result;
    if (rows.length !== 1 || !Array.isArray(result) || result.length > 16) throw new Error("Invalid QA Apple account transactions");
    for (const tx of result) {
      if (!object(tx)) throw new Error("Invalid QA Apple account transaction");
      transaction(tx as unknown as VerifiedAppleTransaction);
      if (tx.transactionId !== tx.originalTransactionId || tx.active !== true || tx.localOnly !== undefined) throw new Error("Invalid QA Apple account transaction");
    }
    if (new Set(result.map(tx => tx.key)).size !== result.length) throw new Error("Duplicate QA Apple account transaction");
    return result as VerifiedAppleTransaction[];
  }
}

/** Membership is enforced atomically in SQL; disabled subjects may still commit known negatives. */
export class QaSandboxAccessRightStore implements AccessRightStore {
  constructor(private readonly sql: Sql) {}
  async begin(holder: string, environment: AccessEnvironment): Promise<string> {
    scope(environment, holder);
    const rows = await this.sql<{ token: unknown }[]>`select public.qa_sandbox_begin_access_observation(${holder}::uuid) as token`;
    if (rows.length !== 1 || !uuid(rows[0]?.token)) throw new Error("QA access observation unavailable");
    return rows[0].token;
  }
  async commit(holder: string, environment: AccessEnvironment, token: string, rights: readonly ProviderRight[]): Promise<CommittedAccess> {
    scope(environment, holder, token);
    if (!Array.isArray(rights) || rights.length > 16 || rights.some(right => !object(right) || !key(right.key) ||
      (right.product !== "still_pro_v3" && right.product !== "still_sync") || (right.state !== undefined && right.state !== "revoked")) ||
      new Set(rights.map(right => right.key)).size !== rights.length) throw new Error("Invalid QA provider snapshot");
    const snapshot = rights.map(({ key, product, state }) => ({ key, product, ...(state === undefined ? {} : { state }) }));
    const rows = await this.sql<{ result: unknown }[]>`select public.qa_sandbox_commit_access_observation(
      ${holder}::uuid, ${token}::uuid, ${this.sql.json(snapshot)}::jsonb) as result`;
    const result = rows[0]?.result;
    if (rows.length !== 1 || !object(result)) throw new Error("QA access commit unavailable");
    if (result.status === "stale") return { status: "stale" };
    if (!["committed", "conflict"].includes(result.status as string) || !safe(result.issuer_time) ||
        !Array.isArray(result.rights) || result.rights.length > 16 ||
        result.rights.some(right => !accountRight(right) || right.holder !== holder || right.verified_at > (result.issuer_time as number)) ||
        new Set(result.rights.map(right => right.right)).size !== result.rights.length ||
        !Array.isArray(result.revocations) || result.revocations.length > 64 ||
        result.revocations.some(r => !object(r) || !uuid(r.right) || !safe(r.revision)) ||
        new Set(result.revocations.map(r => r.right)).size !== result.revocations.length ||
        (result.observed_rights !== undefined && (!Array.isArray(result.observed_rights) || result.observed_rights.length > 16 ||
          new Set(result.observed_rights.map(observed => object(observed) ? observed.right : undefined)).size !== result.observed_rights.length ||
          result.observed_rights.some(observed => !accountRight(observed) || !(result.rights as AccountRight[]).some(right =>
            right.right === observed.right && right.holder === observed.holder && right.revision === observed.revision && right.verified_at === observed.verified_at))))) throw new Error("Invalid QA access commit");
    return result as CommittedAccess;
  }
  async confirm(holder: string, environment: AccessEnvironment, token: string): Promise<boolean> {
    scope(environment, holder, token);
    return confirmed(await this.sql<{ confirmed: unknown }[]>`select public.qa_sandbox_confirm_access_observation(
      ${holder}::uuid, ${token}::uuid) as confirmed`);
  }
  async removals(holder: string, environment: AccessEnvironment, token: string): Promise<AccountAccessRemovals | null> {
    scope(environment, holder, token);
    const rows = await this.sql<{ result: unknown }[]>`select public.qa_sandbox_read_access_removals(${holder}::uuid, ${token}::uuid) as result`;
    const result = rows[0]?.result;
    if (rows.length !== 1) throw new Error("QA removals unavailable");
    if (result === null) return null;
    if (!isAccountAccessRemovals(result, holder, "sandbox")) throw new Error("Invalid QA removals");
    return result;
  }
}

const QUOTAS = { "apple-access": { user: 10, ip: 30 }, checkout: { user: 5, ip: 20 }, reconcile: { user: 10, ip: 60 } } as const;

/** Translate existing handlers' closed surfaces, never invoke the general production limiter. */
export class QaSandboxPgRateLimiter implements RateLimiter {
  constructor(private readonly sql: Sql) {}
  async consume(bucketKey: string, maxRequests: number, windowSeconds: number): Promise<number> {
    try {
      const match = /^(?:qa-sandbox-)?(apple-access|checkout|reconcile):(user|ip):(.+)$/.exec(bucketKey);
      if (!match || bucketKey.length > 1024 || windowSeconds !== 60) throw new Error("Invalid QA rate policy");
      const surface = match[1] as keyof typeof QUOTAS, kind = match[2] as "user" | "ip", subject = match[3]!;
      const qaKey = `qa-sandbox-${surface}:${kind}:${subject}`;
      if (qaKey.length > 1024 || maxRequests !== QUOTAS[surface][kind] || (kind === "user" && !uuid(subject))) throw new Error("Invalid QA rate quota");
      const rows = await this.sql<{ wait: unknown }[]>`select public.qa_sandbox_consume_rate_limit(${qaKey}, ${maxRequests}, ${windowSeconds}) as wait`;
      if (rows.length !== 1 || !safe(rows[0]?.wait) || rows[0].wait > 60) throw new Error("Invalid QA rate result");
      return rows[0].wait;
    } catch {
      // Driver errors may echo the account/address. Expose only the fixed operator category.
      throw new CodedError("rate_limiter_unavailable", "Rate limiter unavailable");
    }
  }
}
