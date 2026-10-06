// The analytics identity and erasure store (migrations 0017 and 0018). Handlers depend on the
// interface so tests inject a fake; the Postgres implementation connects ONLY as
// still_analytics_eraser, whose privileges are EXECUTE on the eight private.analytics_* routes and
// the retained limiter.
//
// Two device values reach the server, each 32 bytes sent as 64 lowercase hex characters, and the
// device's private consent handle never does (derive.ts on the client):
//   * the origin proof P = SHA-256(E), sent at sign-in to issue the device's subject;
//   * the erasure key E = HMAC(handle, "still:analytics:erasure"), sent only when the device asks
//     to erase itself. The database derives every target from E; a request names no id.
// The database stores only SHA-256(P), never P or E.

import postgres from "postgres";

/** The issued PostHog identity for one account on one device, or "stopped" for an erased device. */
export type SubjectIssue =
  | { readonly state: "active"; readonly subject: string }
  | { readonly state: "stopped" }
  /** The account reached its daily limit of new devices: try again later. */
  | { readonly state: "limited" };

export const ERASURE_STAGES = [
  "stop_recorded",
  "provider_delete_accepted",
  "provider_delete_confirmed",
  "complete",
] as const;
export type ErasureStage = (typeof ERASURE_STAGES)[number];

/** The fixed outcome words a worker run records; the database refuses anything else. */
export const ERASURE_OUTCOMES = [
  "queued",
  "none_found",
  "provider_unavailable",
  "provider_rejected",
  "provider_partial",
  "provider_shape",
] as const;
export type ErasureOutcome = (typeof ERASURE_OUTCOMES)[number];

export interface ErasureJobRef {
  readonly job: string;
  readonly stage: ErasureStage;
}

export interface ClaimedErasureJob extends ErasureJobRef {
  readonly lease: string;
  readonly sweeps: number;
  readonly attempts: number;
  readonly targets: readonly string[];
}

export interface RecordedOutcome {
  /** False when the lease is no longer held (another run claimed the job). */
  readonly recorded: boolean;
  /** Five or more failures in a row: alert, and keep retrying. */
  readonly overdue: boolean;
}

export interface ErasureStore {
  issueSubject(userId: string, originProof: string): Promise<SubjectIssue>;
  subjectActive(subject: string): Promise<boolean>;
  /** From the erasure key and the last anonymous index the device used; the database derives the
   * targets. Never refused for volume: past the global cap a job is recorded at the lowest priority. */
  beginDeviceErasure(erasureKey: string, anonIndex: number): Promise<ErasureJobRef>;
  erasureStatus(erasureKey: string): Promise<ErasureJobRef | null>;
  claimWork(limit: number, leaseSeconds: number): Promise<ClaimedErasureJob[]>;
  recordOutcome(job: string, lease: string, outcome: ErasureOutcome): Promise<RecordedOutcome>;
}

/** Why an account's subjects are retired: the delete-user pre-step (`account_deleted`), or the
 * account-wide "delete what we shared" action (`account_erasure`, packet B). */
export type AccountErasureReason = "account_deleted" | "account_erasure";

/** The account pre-step's answer: how many active subjects it retired and queued, or "gone" when the
 * account no longer exists (a retry after a lost reply; 0017's snapshot captured everything then). */
export type AccountErasureResult =
  | { readonly state: "captured"; readonly subjects: number }
  | { readonly state: "gone" };

/** Account-level erasure (migration 0018). Separate from ErasureStore so the account functions
 * depend on nothing else. */
export interface AccountErasurePort {
  /** Retire every active subject of the account and queue each in its own random-key job, in one
   * transaction. Idempotent: a second call captures 0. */
  beginAccountErasure(userId: string, reason: AccountErasureReason): Promise<AccountErasureResult>;
  /** The least advanced stage among the account-wide jobs, or null when there is none. */
  accountErasureStatus(userId: string): Promise<ErasureStage | null>;
}

const PROOF = /^[0-9a-f]{64}$/;
/** The last anonymous index a device may name (derive.ts ANON_INDEX_LIMIT). */
export const ANON_INDEX_LIMIT = 255;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isOriginProof(value: unknown): value is string {
  return typeof value === "string" && PROOF.test(value);
}

/** Same shape as a proof; a different value with a different power (see the header). */
export const isErasureKey = isOriginProof;

export function isAnonIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= ANON_INDEX_LIMIT;
}

export function isLowerUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isStage(value: unknown): value is ErasureStage {
  return (ERASURE_STAGES as readonly unknown[]).includes(value);
}

/** Storage failures carry no driver detail: driver errors can include bind parameters. */
export class ErasureStorageUnavailable extends Error {
  constructor() {
    super("Analytics erasure storage unavailable");
    this.name = "ErasureStorageUnavailable";
  }
}

type Sql = ReturnType<typeof postgres>;

export class PgErasureStore implements ErasureStore, AccountErasurePort {
  constructor(private readonly sql: Sql) {}

  private async one(query: () => PromiseLike<readonly { value: unknown }[]>): Promise<unknown> {
    try {
      const rows = await query();
      if (rows.length !== 1) throw new Error("row");
      return rows[0]!.value;
    } catch {
      throw new ErasureStorageUnavailable();
    }
  }

  async issueSubject(userId: string, originProof: string): Promise<SubjectIssue> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`
        select private.analytics_issue_subject(${userId}::uuid, pg_catalog.decode(${originProof}, 'hex')) as value`
    ) as Record<string, unknown> | null;
    if (value?.state === "stopped") return { state: "stopped" };
    if (value?.state === "limited") return { state: "limited" };
    if (value?.state === "active" && isLowerUuid(value.subject)) return { state: "active", subject: value.subject };
    throw new ErasureStorageUnavailable();
  }

  async subjectActive(subject: string): Promise<boolean> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`select private.analytics_subject_active(${subject}::uuid) as value`
    );
    if (typeof value !== "boolean") throw new ErasureStorageUnavailable();
    return value;
  }

  async beginDeviceErasure(erasureKey: string, anonIndex: number): Promise<ErasureJobRef> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`
        select private.analytics_begin_device_erasure(pg_catalog.decode(${erasureKey}, 'hex'),
          ${anonIndex}::integer) as value`
    );
    return jobRef(value);
  }

  async erasureStatus(erasureKey: string): Promise<ErasureJobRef | null> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`
        select private.analytics_erasure_status(pg_catalog.decode(${erasureKey}, 'hex')) as value`
    ) as Record<string, unknown> | null;
    if (value && value.stage === null) return null;
    return jobRef(value);
  }

  async claimWork(limit: number, leaseSeconds: number): Promise<ClaimedErasureJob[]> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`
        select private.analytics_claim_erasure_work(${limit}::integer, ${leaseSeconds}::integer) as value`
    );
    if (!Array.isArray(value)) throw new ErasureStorageUnavailable();
    return value.map((raw) => {
      const v = raw as Record<string, unknown>;
      const ref = jobRef(v);
      const targets = v.targets;
      if (
        !isLowerUuid(v.lease) || !Number.isSafeInteger(v.sweeps) || !Number.isSafeInteger(v.attempts) ||
        !Array.isArray(targets) || !targets.every(isLowerUuid)
      ) throw new ErasureStorageUnavailable();
      return { ...ref, lease: v.lease, sweeps: v.sweeps as number, attempts: v.attempts as number, targets };
    });
  }

  async beginAccountErasure(userId: string, reason: AccountErasureReason): Promise<AccountErasureResult> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`
        select private.analytics_begin_account_erasure(${userId}::uuid, ${reason}) as value`
    );
    return accountErasureResult(value);
  }

  async accountErasureStatus(userId: string): Promise<ErasureStage | null> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`select private.analytics_account_erasure_status(${userId}::uuid) as value`
    ) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["stage"])) {
      throw new ErasureStorageUnavailable();
    }
    if (value.stage === null) return null;
    if (!isStage(value.stage)) throw new ErasureStorageUnavailable();
    return value.stage;
  }

  async recordOutcome(job: string, lease: string, outcome: ErasureOutcome): Promise<RecordedOutcome> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`
        select private.analytics_record_erasure_outcome(${job}::uuid, ${lease}::uuid, ${outcome}) as value`
    ) as Record<string, unknown> | null;
    if (typeof value?.recorded !== "boolean") throw new ErasureStorageUnavailable();
    return { recorded: value.recorded, overdue: value.overdue === true };
  }
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && [...keys].sort().every((k, i) => own[i] === k);
}

/** Only `{state: "captured", subjects: n >= 0}` or `{state: "gone"}`; anything else is a storage
 * failure, never a capture. */
export function accountErasureResult(value: unknown): AccountErasureResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ErasureStorageUnavailable();
  const v = value as Record<string, unknown>;
  if (v.state === "gone" && exactKeys(v, ["state"])) return { state: "gone" };
  if (
    v.state === "captured" && exactKeys(v, ["state", "subjects"]) && Number.isSafeInteger(v.subjects) &&
    (v.subjects as number) >= 0
  ) return { state: "captured", subjects: v.subjects as number };
  throw new ErasureStorageUnavailable();
}

function jobRef(value: unknown): ErasureJobRef {
  const v = value as Record<string, unknown> | null;
  if (!v || !isLowerUuid(v.job) || !isStage(v.stage)) throw new ErasureStorageUnavailable();
  return { job: v.job, stage: v.stage };
}

/** What a device is told about its erasure. Pending is never success: "deleted" only at
 * `complete`, which the database reaches no sooner than 8 days after PostHog accepted the deletion
 * and only after a sweep then finds nobody. A person that is gone says nothing about its events,
 * which PostHog deletes in a later batch (weekends on PostHog Cloud), so a confirmed person
 * deletion still reads as "verifying". Later sweeps continue in the background. */
export type DeviceErasureState = "none" | "requested" | "verifying" | "deleted";

export function deviceErasureState(ref: ErasureJobRef | null): DeviceErasureState {
  if (!ref) return "none";
  switch (ref.stage) {
    case "stop_recorded":
      return "requested";
    case "provider_delete_accepted":
    case "provider_delete_confirmed":
      return "verifying";
    case "complete":
      return "deleted";
  }
}
