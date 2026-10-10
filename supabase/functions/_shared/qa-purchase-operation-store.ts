import type postgres from "postgres";
import { isUuid } from "./types.ts";

export type QaPurchaseOperationStatus =
  | "prepared" | "session_bound" | "paid_verified" | "import_pending" | "imported"
  | "access_observed" | "recovery_required" | "refunded" | "closed_unpaid";

/** Server-owned SQL receipt; these states never constitute an access proof. */
export interface QaPurchaseOperation {
  readonly operation_id: string;
  readonly holder: string;
  readonly environment: "sandbox";
  readonly configuration_hash: string;
  readonly stripe_session_id: string | null;
  readonly status: QaPurchaseOperationStatus;
  readonly creation_started_at: string | null;
  readonly paid_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A refunded operation whose account was deleted (0022 keeps the payment record, clears the account id). */
export type DeletedAccountQaPurchaseOperation = Omit<QaPurchaseOperation, "holder" | "status"> & {
  readonly holder: null;
  readonly status: "refunded";
};

export interface QaPurchaseOperationStore {
  prepare(operation: string, holder: string, configurationHash: string): Promise<QaPurchaseOperation>;
  claimCreation(operation: string, holder: string, configurationHash: string): Promise<{ operation: QaPurchaseOperation; claimed: boolean }>;
  bindSession(operation: string, holder: string, session: string, configurationHash: string): Promise<QaPurchaseOperation>;
  read(operation: string, holder: string): Promise<QaPurchaseOperation | null>;
  recordStatus(operation: string, session: string | null, status: QaPurchaseOperationStatus): Promise<QaPurchaseOperation>;
  /** Record a canonical full refund on the exact bound Session of an operation whose account was
   * deleted. Rejects (after the write) when the stored operation still names an account. */
  recordDeletedAccountRefund(operation: string, session: string): Promise<DeletedAccountQaPurchaseOperation>;
}

type Sql = ReturnType<typeof postgres>;
const STATUSES: readonly string[] = ["prepared", "session_bound", "paid_verified", "import_pending", "imported", "access_observed", "recovery_required", "refunded", "closed_unpaid"];
const PAID_STATUSES = ["paid_verified", "import_pending", "imported", "access_observed", "refunded"];
const KEYS = ["operation_id", "holder", "environment", "configuration_hash", "stripe_session_id", "status", "creation_started_at", "paid_at", "created_at", "updated_at"];
const SESSION = /^cs_test_[A-Za-z0-9_]{1,240}$/;
const HASH = /^[0-9a-f]{64}$/;

function unavailable(): Error {
  return Object.assign(new Error("QA purchase operation unavailable"), { code: "qa_purchase_operation_unavailable" });
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && Number.isFinite(Date.parse(value));
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw unavailable();
  return value.toLowerCase();
}
function configuration(value: string): void {
  if (typeof value !== "string" || !HASH.test(value)) throw unavailable();
}
function sessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION.test(value);
}
function receipt(value: unknown): QaPurchaseOperation;
function receipt(value: unknown, deletedAccount: true): DeletedAccountQaPurchaseOperation;
function receipt(value: unknown, deletedAccount = false): QaPurchaseOperation | DeletedAccountQaPurchaseOperation {
  if (!object(value) || !exactKeys(value, KEYS) || value.environment !== "sandbox" ||
    typeof value.configuration_hash !== "string" || !HASH.test(value.configuration_hash) ||
    typeof value.status !== "string" || !STATUSES.includes(value.status) ||
    (value.stripe_session_id !== null && !sessionId(value.stripe_session_id)) ||
    !timestamp(value.created_at) || !timestamp(value.updated_at) ||
    (value.creation_started_at !== null && !timestamp(value.creation_started_at)) ||
    (value.paid_at !== null && !timestamp(value.paid_at))) throw unavailable();
  // Only a deleted account's kept record has no account id; every scoped read still requires one.
  const operation = uuid(value.operation_id), holder = deletedAccount ? deletedHolder(value.holder) : uuid(value.holder);
  // Only an unstarted/prepared operation may lack a creation fence. Unknown outcomes keep it.
  if ((value.creation_started_at === null && value.status !== "prepared") ||
    (value.stripe_session_id !== null && value.creation_started_at === null) ||
    (value.status === "prepared" && (value.stripe_session_id !== null || value.paid_at !== null)) ||
    (value.status !== "prepared" && value.status !== "recovery_required" && value.stripe_session_id === null) ||
    (PAID_STATUSES.includes(value.status) && value.paid_at === null) ||
    ((value.status === "session_bound" || value.status === "closed_unpaid") && value.paid_at !== null) ||
    (value.paid_at !== null && value.stripe_session_id === null)) throw unavailable();
  return { ...value, operation_id: operation, holder } as unknown as QaPurchaseOperation;
}
function deletedHolder(value: unknown): null {
  if (value !== null) throw unavailable();
  return null;
}
function result(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length !== 1 || !object(rows[0]) || !exactKeys(rows[0], ["result"])) throw unavailable();
  return rows[0].result;
}
function scope(value: QaPurchaseOperation, operation: string | null, holder: string | null, hash?: string): void {
  if ((operation !== null && value.operation_id !== operation) || (holder !== null && value.holder !== holder) ||
    (hash !== undefined && value.configuration_hash !== hash)) throw unavailable();
}

/** Fixed QA RPCs only. SQL owns membership, locks and transitions; no retry/release is inferred here. */
export class PgQaPurchaseOperationStore implements QaPurchaseOperationStore {
  constructor(private readonly sql: Sql) {}

  async prepare(operation: string, holder: string, configurationHash: string): Promise<QaPurchaseOperation> {
    try {
      operation = uuid(operation); holder = uuid(holder); configuration(configurationHash);
      const rows = await this.sql`select public.qa_sandbox_prepare_checkout_operation(${operation}::uuid, ${holder}::uuid, ${configurationHash}) as result`;
      const value = receipt(result(rows));
      scope(value, null, holder, configurationHash);
      // An existing unresolved attempt may replace the requested ID, never a foreign/closed one.
      if (value.operation_id !== operation && (value.status === "refunded" || value.status === "closed_unpaid")) throw unavailable();
      return value;
    } catch { throw unavailable(); }
  }

  async claimCreation(operation: string, holder: string, configurationHash: string): Promise<{ operation: QaPurchaseOperation; claimed: boolean }> {
    try {
      operation = uuid(operation); holder = uuid(holder); configuration(configurationHash);
      const rows = await this.sql`select public.qa_sandbox_claim_checkout_creation(${operation}::uuid, ${holder}::uuid, ${configurationHash}) as result`;
      const value = result(rows);
      if (!object(value) || !exactKeys(value, ["operation", "claimed"]) || typeof value.claimed !== "boolean") throw unavailable();
      const stored = receipt(value.operation);
      scope(stored, operation, holder, configurationHash);
      if (stored.creation_started_at === null || (value.claimed && (stored.status !== "prepared" || stored.stripe_session_id !== null || stored.paid_at !== null))) throw unavailable();
      return { operation: stored, claimed: value.claimed };
    } catch { throw unavailable(); }
  }

  async bindSession(operation: string, holder: string, session: string, configurationHash: string): Promise<QaPurchaseOperation> {
    try {
      operation = uuid(operation); holder = uuid(holder); configuration(configurationHash);
      if (!sessionId(session)) throw unavailable();
      const rows = await this.sql`select public.qa_sandbox_bind_checkout_session(${operation}::uuid, ${holder}::uuid, ${session}, ${configurationHash}) as result`;
      const value = receipt(result(rows));
      scope(value, operation, holder, configurationHash);
      if (value.stripe_session_id !== session || value.creation_started_at === null) throw unavailable();
      return value;
    } catch { throw unavailable(); }
  }

  async read(operation: string, holder: string): Promise<QaPurchaseOperation | null> {
    try {
      operation = uuid(operation); holder = uuid(holder);
      const rows = await this.sql`select public.qa_sandbox_read_checkout_operation(${operation}::uuid, ${holder}::uuid) as result`;
      const raw = result(rows);
      if (raw === null) return null;
      const value = receipt(raw);
      scope(value, operation, holder);
      return value;
    } catch { throw unavailable(); }
  }

  async recordStatus(operation: string, session: string | null, status: QaPurchaseOperationStatus): Promise<QaPurchaseOperation> {
    try {
      operation = uuid(operation);
      if (!STATUSES.includes(status) || (session !== null && !sessionId(session)) ||
        (session === null && status !== "recovery_required")) throw unavailable();
      const rows = await this.sql`select public.qa_sandbox_record_checkout_status(${operation}::uuid, ${session}, ${status}) as result`;
      const value = receipt(result(rows));
      scope(value, operation, null);
      if (value.stripe_session_id !== session || value.status !== status) throw unavailable();
      return value;
    } catch { throw unavailable(); }
  }

  async recordDeletedAccountRefund(operation: string, session: string): Promise<DeletedAccountQaPurchaseOperation> {
    try {
      operation = uuid(operation);
      if (!sessionId(session)) throw unavailable();
      // The same exact operation+Session transition as recordStatus; SQL needs no account for it.
      const rows = await this.sql`select public.qa_sandbox_record_checkout_status(${operation}::uuid, ${session}, 'refunded') as result`;
      const value = receipt(result(rows), true);
      if (value.operation_id !== operation || value.stripe_session_id !== session || value.status !== "refunded") throw unavailable();
      return value;
    } catch { throw unavailable(); }
  }
}
