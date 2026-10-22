import type postgres from "postgres";
import { isUuid } from "./types.ts";

export type PurchaseOperationStatus =
  | "prepared" | "session_bound" | "paid_verified" | "import_pending" | "imported"
  | "access_observed" | "recovery_required" | "refunded" | "closed_unpaid";

/** Server-owned SQL receipt; these states never constitute an access proof. */
export type CheckoutEnvironment = "sandbox" | "production";
export interface CheckoutAdmission { readonly surface: "chrome_desktop" | "firefox_desktop"; readonly build: string; }

export interface PurchaseOperation<E extends CheckoutEnvironment = CheckoutEnvironment> {
  readonly operation_id: string;
  readonly holder: string;
  readonly environment: E;
  readonly configuration_hash: string;
  readonly stripe_session_id: string | null;
  readonly status: PurchaseOperationStatus;
  readonly creation_started_at: string | null;
  readonly paid_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A refunded operation whose account was deleted (0022 keeps the payment record, clears the account id). */
export type DeletedAccountPurchaseOperation<E extends CheckoutEnvironment = CheckoutEnvironment> = Omit<PurchaseOperation<E>, "holder" | "status"> & {
  readonly holder: null;
  readonly status: "refunded";
};

export interface PurchaseOperationStore<E extends CheckoutEnvironment = CheckoutEnvironment> {
  prepare(operation: string, holder: string, configurationHash: string): Promise<PurchaseOperation<E>>;
  claimCreation(operation: string, holder: string, configurationHash: string): Promise<{ operation: PurchaseOperation<E>; claimed: boolean }>;
  bindSession(operation: string, holder: string, session: string, configurationHash: string): Promise<PurchaseOperation<E>>;
  read(operation: string, holder: string): Promise<PurchaseOperation<E> | null>;
  recordStatus(operation: string, session: string | null, status: PurchaseOperationStatus): Promise<PurchaseOperation<E>>;
  /** Record a canonical full refund on the exact bound Session of an operation whose account was
   * deleted. Rejects (after the write) when the stored operation still names an account. */
  recordDeletedAccountRefund(operation: string, session: string): Promise<DeletedAccountPurchaseOperation<E>>;
}

type Sql = ReturnType<typeof postgres>;
const STATUSES: readonly string[] = ["prepared", "session_bound", "paid_verified", "import_pending", "imported", "access_observed", "recovery_required", "refunded", "closed_unpaid"];
const PAID_STATUSES = ["paid_verified", "import_pending", "imported", "access_observed", "refunded"];
const KEYS = ["operation_id", "holder", "environment", "configuration_hash", "stripe_session_id", "status", "creation_started_at", "paid_at", "created_at", "updated_at"];
const SESSIONS = { sandbox: /^cs_test_[A-Za-z0-9_]{1,240}$/, production: /^cs_live_[A-Za-z0-9_]{1,240}$/ } as const;
const HASH = /^[0-9a-f]{64}$/;

function unavailable(environment?: CheckoutEnvironment): Error {
  return Object.assign(new Error(environment === "sandbox" ? "QA purchase operation unavailable" : "Purchase operation unavailable"),
    { code: environment === "sandbox" ? "qa_purchase_operation_unavailable" : "purchase_operation_unavailable" });
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
function sessionId(value: unknown, environment: CheckoutEnvironment): value is string {
  return typeof value === "string" && SESSIONS[environment].test(value);
}
function receipt<E extends CheckoutEnvironment>(value: unknown, environment: E): PurchaseOperation<E>;
function receipt<E extends CheckoutEnvironment>(value: unknown, environment: E, deletedAccount: true): DeletedAccountPurchaseOperation<E>;
function receipt<E extends CheckoutEnvironment>(value: unknown, environment: E, deletedAccount = false): PurchaseOperation<E> | DeletedAccountPurchaseOperation<E> {
  if (!object(value) || !exactKeys(value, KEYS) || value.environment !== environment ||
    typeof value.configuration_hash !== "string" || !HASH.test(value.configuration_hash) ||
    typeof value.status !== "string" || !STATUSES.includes(value.status) ||
    (value.stripe_session_id !== null && !sessionId(value.stripe_session_id, environment)) ||
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
  return { ...value, operation_id: operation, holder } as unknown as PurchaseOperation<E>;
}
function deletedHolder(value: unknown): null {
  if (value !== null) throw unavailable();
  return null;
}
function result(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length !== 1 || !object(rows[0]) || !exactKeys(rows[0], ["result"])) throw unavailable();
  return rows[0].result;
}
function scope(value: PurchaseOperation, operation: string | null, holder: string | null, hash?: string): void {
  if ((operation !== null && value.operation_id !== operation) || (holder !== null && value.holder !== holder) ||
    (hash !== undefined && value.configuration_hash !== hash)) throw unavailable();
}

/** Closed environment selects fixed RPCs. SQL owns admission, locks and transitions; no retry/release is inferred here. */
export class PgPurchaseOperationStore<E extends CheckoutEnvironment> implements PurchaseOperationStore<E> {
  private readonly admission: Readonly<CheckoutAdmission> | undefined;
  constructor(private readonly sql: Sql, private readonly environment: E, admission?: CheckoutAdmission, private readonly analyticsOrigin?: string) {
    if (environment !== "sandbox" && environment !== "production") throw unavailable();
    if (admission && (!["chrome_desktop", "firefox_desktop"].includes(admission.surface) || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(admission.build))) throw unavailable();
    this.admission = admission ? Object.freeze({ ...admission }) : undefined;
  }

  async prepare(operation: string, holder: string, configurationHash: string): Promise<PurchaseOperation<E>> {
    try {
      operation = uuid(operation); holder = uuid(holder); configuration(configurationHash);
      const rows = this.environment === "production" ? await this.sql`select public.production_prepare_checkout_operation(${operation}::uuid, ${holder}::uuid, ${configurationHash}, ${this.admission?.surface ?? null}, ${this.admission?.build ?? null}) as result` :
        await this.sql`select public.qa_sandbox_prepare_checkout_operation(${operation}::uuid, ${holder}::uuid, ${configurationHash}) as result`;
      const value = receipt(result(rows), this.environment);
      scope(value, null, holder, configurationHash);
      // An existing unresolved attempt may replace the requested ID, never a foreign/closed one.
      if (value.operation_id !== operation && (value.status === "refunded" || value.status === "closed_unpaid")) throw unavailable();
      return value;
    } catch { throw unavailable(this.environment); }
  }

  async claimCreation(operation: string, holder: string, configurationHash: string): Promise<{ operation: PurchaseOperation<E>; claimed: boolean }> {
    try {
      operation = uuid(operation); holder = uuid(holder); configuration(configurationHash);
      const rows = this.environment === "production" && this.analyticsOrigin
        ? await this.sql`select public.production_claim_checkout_with_analytics(${operation}::uuid, ${holder}::uuid, ${configurationHash}, ${this.admission?.surface ?? null}, ${this.admission?.build ?? null}, ${this.analyticsOrigin}) as result`
        : this.environment === "production" ? await this.sql`select public.production_claim_checkout_creation(${operation}::uuid, ${holder}::uuid, ${configurationHash}, ${this.admission?.surface ?? null}, ${this.admission?.build ?? null}) as result` :
        await this.sql`select public.qa_sandbox_claim_checkout_creation(${operation}::uuid, ${holder}::uuid, ${configurationHash}) as result`;
      const value = result(rows);
      if (!object(value) || !exactKeys(value, ["operation", "claimed"]) || typeof value.claimed !== "boolean") throw unavailable();
      const stored = receipt(value.operation, this.environment);
      scope(stored, operation, holder, configurationHash);
      if (stored.creation_started_at === null || (value.claimed && (stored.status !== "prepared" || stored.stripe_session_id !== null || stored.paid_at !== null))) throw unavailable();
      return { operation: stored, claimed: value.claimed };
    } catch { throw unavailable(this.environment); }
  }

  async bindSession(operation: string, holder: string, session: string, configurationHash: string): Promise<PurchaseOperation<E>> {
    try {
      operation = uuid(operation); holder = uuid(holder); configuration(configurationHash);
      if (!sessionId(session, this.environment)) throw unavailable();
      const rows = this.environment === "production" ? await this.sql`select public.production_bind_checkout_session(${operation}::uuid, ${holder}::uuid, ${session}, ${configurationHash}) as result` :
        await this.sql`select public.qa_sandbox_bind_checkout_session(${operation}::uuid, ${holder}::uuid, ${session}, ${configurationHash}) as result`;
      const value = receipt(result(rows), this.environment);
      scope(value, operation, holder, configurationHash);
      if (value.stripe_session_id !== session || value.creation_started_at === null) throw unavailable();
      return value;
    } catch { throw unavailable(this.environment); }
  }

  async read(operation: string, holder: string): Promise<PurchaseOperation<E> | null> {
    try {
      operation = uuid(operation); holder = uuid(holder);
      const rows = this.environment === "production" ? await this.sql`select public.production_read_checkout_operation(${operation}::uuid, ${holder}::uuid) as result` :
        await this.sql`select public.qa_sandbox_read_checkout_operation(${operation}::uuid, ${holder}::uuid) as result`;
      const raw = result(rows);
      if (raw === null) return null;
      const value = receipt(raw, this.environment);
      scope(value, operation, holder);
      return value;
    } catch { throw unavailable(this.environment); }
  }

  async recordStatus(operation: string, session: string | null, status: PurchaseOperationStatus): Promise<PurchaseOperation<E>> {
    try {
      operation = uuid(operation);
      if (!STATUSES.includes(status) || (session !== null && !sessionId(session, this.environment)) ||
        (session === null && status !== "recovery_required")) throw unavailable();
      const rows = this.environment === "production" ? await this.sql`select public.production_record_checkout_status(${operation}::uuid, ${session}, ${status}) as result` :
        await this.sql`select public.qa_sandbox_record_checkout_status(${operation}::uuid, ${session}, ${status}) as result`;
      const value = receipt(result(rows), this.environment);
      scope(value, operation, null);
      if (value.stripe_session_id !== session || value.status !== status) throw unavailable();
      return value;
    } catch { throw unavailable(this.environment); }
  }

  async recordDeletedAccountRefund(operation: string, session: string): Promise<DeletedAccountPurchaseOperation<E>> {
    try {
      operation = uuid(operation);
      if (!sessionId(session, this.environment)) throw unavailable();
      // The same exact operation+Session transition as recordStatus; SQL needs no account for it.
      const rows = this.environment === "production" ? await this.sql`select public.production_record_checkout_status(${operation}::uuid, ${session}, 'refunded') as result` :
        await this.sql`select public.qa_sandbox_record_checkout_status(${operation}::uuid, ${session}, 'refunded') as result`;
      const value = receipt(result(rows), this.environment, true);
      if (value.operation_id !== operation || value.stripe_session_id !== session || value.status !== "refunded") throw unavailable();
      return value;
    } catch { throw unavailable(this.environment); }
  }
}
