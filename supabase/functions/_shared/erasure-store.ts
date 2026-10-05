// The analytics identity and erasure store (migration 0017). Handlers depend on the interface so
// tests inject a fake; the Postgres implementation connects ONLY as still_analytics_eraser, whose
// privileges are EXECUTE on the six private.analytics_* routes and the retained limiter.
//
// A device is named only by its origin proof: 32 bytes, sent as 64 lowercase hex characters. The
// proof is a one-way hash of the device's private consent handle; the handle itself never reaches
// the server. The database stores only a hash of the proof.

import postgres from "postgres";

/** The issued PostHog identity for one account on one device, or "stopped" for an erased device. */
export type SubjectIssue =
  | { readonly state: "active"; readonly subject: string }
  | { readonly state: "stopped" };

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
  readonly targets: readonly string[];
}

export interface ErasureStore {
  issueSubject(userId: string, originProof: string): Promise<SubjectIssue>;
  subjectActive(subject: string): Promise<boolean>;
  /** "refused" when the request names an account id or another device's subject. */
  beginDeviceErasure(originProof: string, anonymousIds: readonly string[]): Promise<ErasureJobRef | "refused">;
  erasureStatus(originProof: string): Promise<ErasureJobRef | null>;
  claimWork(limit: number, leaseSeconds: number): Promise<ClaimedErasureJob[]>;
  /** False when the lease is no longer held (another run claimed the job, or it completed). */
  recordOutcome(job: string, lease: string, outcome: ErasureOutcome): Promise<boolean>;
}

const PROOF = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isOriginProof(value: unknown): value is string {
  return typeof value === "string" && PROOF.test(value);
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

export class PgErasureStore implements ErasureStore {
  constructor(private readonly sql: Sql) {}

  private async one(query: () => PromiseLike<readonly { value: unknown }[]>): Promise<unknown> {
    try {
      const rows = await query();
      if (rows.length !== 1) throw new Error("row");
      return rows[0]!.value;
    } catch (error) {
      if (error instanceof postgres.PostgresError && error.code === "42501" &&
        error.message === "analytics erasure target refused") {
        throw new TargetRefused();
      }
      throw new ErasureStorageUnavailable();
    }
  }

  async issueSubject(userId: string, originProof: string): Promise<SubjectIssue> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`
        select private.analytics_issue_subject(${userId}::uuid, pg_catalog.decode(${originProof}, 'hex')) as value`
    ) as Record<string, unknown> | null;
    if (value?.state === "stopped") return { state: "stopped" };
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

  async beginDeviceErasure(originProof: string, anonymousIds: readonly string[]): Promise<ErasureJobRef | "refused"> {
    try {
      const value = await this.one(() =>
        this.sql<{ value: unknown }[]>`
          select private.analytics_begin_device_erasure(pg_catalog.decode(${originProof}, 'hex'),
            pg_catalog.string_to_array(${anonymousIds.join(",")}, ',')::uuid[]) as value`
      );
      return jobRef(value);
    } catch (error) {
      if (error instanceof TargetRefused) return "refused";
      throw error;
    }
  }

  async erasureStatus(originProof: string): Promise<ErasureJobRef | null> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`
        select private.analytics_erasure_status(pg_catalog.decode(${originProof}, 'hex')) as value`
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
        !isLowerUuid(v.lease) || !Number.isSafeInteger(v.sweeps) ||
        !Array.isArray(targets) || !targets.every(isLowerUuid)
      ) throw new ErasureStorageUnavailable();
      return { ...ref, lease: v.lease, sweeps: v.sweeps as number, targets };
    });
  }

  async recordOutcome(job: string, lease: string, outcome: ErasureOutcome): Promise<boolean> {
    const value = await this.one(() =>
      this.sql<{ value: unknown }[]>`
        select private.analytics_record_erasure_outcome(${job}::uuid, ${lease}::uuid, ${outcome}) as value`
    ) as Record<string, unknown> | null;
    if (typeof value?.recorded !== "boolean") throw new ErasureStorageUnavailable();
    return value.recorded;
  }
}

class TargetRefused extends Error {}

function jobRef(value: unknown): ErasureJobRef {
  const v = value as Record<string, unknown> | null;
  if (!v || !isLowerUuid(v.job) || !isStage(v.stage)) throw new ErasureStorageUnavailable();
  return { job: v.job, stage: v.stage };
}

/** What a device is told about its erasure. "deleted" once the provider confirmed and the first
 * sweep found nothing; later sweeps continue in the background. Pending is never success. */
export type DeviceErasureState = "none" | "requested" | "verifying" | "deleted";

export function deviceErasureState(ref: ErasureJobRef | null): DeviceErasureState {
  if (!ref) return "none";
  switch (ref.stage) {
    case "stop_recorded":
      return "requested";
    case "provider_delete_accepted":
      return "verifying";
    case "provider_delete_confirmed":
    case "complete":
      return "deleted";
  }
}
