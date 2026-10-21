import type { SupabaseClient } from "@supabase/supabase-js";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { readSettingsOperationRequest, SETTINGS_FIELDS, type StillSettings, type UntrustedSettingsOperationRequest } from "@still/shared-types";
import { readSettingsReceipt, SettingsStorageRecovery, type CanonicalSettingsEnvelope } from "../storage/atomic-settings.js";
import { migrateSettingsV2 } from "../storage/settings-v2.js";
import type { SyncedSettingsEnvelope } from "../storage/adapter.js";
import { parseSyncedSettingsEnvelope } from "../storage/settings-validation.js";
import { readAccountDeletionResult, type AccountDeletionResult } from "./account-deletion.js";
import { isAccessUUID } from "../entitlement/access-proof.js";
import { backendRoutes, type BackendRouteProfile, type BackendRoutes } from "./backend-route-profile.js";
import type {
  BackendPort,
  CheckedReconcilePort,
  EntitlementRead,
  ReconcileCallOutcome,
  WebCheckoutOutcome,
  WebCheckoutCompletion,
  WebCheckoutPort,
} from "./ports.js";

// Entitlement + profile-settings access over Supabase. Reads rely on RLS (a user sees only its own
// rows); the reconcile call self-heals the entitlement on every sign-in (U13/U14).

// Every Edge Function call gets a client-side deadline. `functions.invoke` has no default timeout, so
// a black-holed connection would otherwise leave the popup stranded at "checking…"/"opening-checkout"
// forever (the worker/popup can't cancel a hung fetch). The server side already bounds RevenueCat at
// 8s (supabase/functions/_shared/revenuecat.ts); this carries the same ceiling one hop earlier. A
// timeout surfaces as a FunctionsFetchError (not FunctionsHttpError → status null), so it maps to the
// same calm outcome the network-error path already produces per method.
const EDGE_FN_TIMEOUT_MS = 8_000;
type CheckoutAdmission = { readonly surface: "chrome_desktop" | "firefox_desktop"; readonly build: string };

export class SupabaseBackendPort implements BackendPort, WebCheckoutPort, CheckedReconcilePort {
  readonly modernSettingsEnabled: boolean;
  readonly managedCheckout = true;
  private readonly sandbox: boolean;
  private readonly checkoutAdmission: Promise<CheckoutAdmission | null>;
  private readonly routes: BackendRoutes;
  constructor(private readonly client: SupabaseClient, options: { readonly modernSettings?: boolean; readonly routeProfile?: BackendRouteProfile; readonly checkoutAdmission?: CheckoutAdmission | Promise<CheckoutAdmission | null> } = {}) {
    this.modernSettingsEnabled = options.modernSettings === true;
    this.routes = backendRoutes(options.routeProfile === undefined ? "production" : options.routeProfile);
    this.sandbox = options.routeProfile === "shared-hosted-sandbox";
    const admission = options.checkoutAdmission;
    const validated = (value: CheckoutAdmission | null | undefined) => value && ["chrome_desktop", "firefox_desktop"].includes(value.surface) &&
      /^[a-z0-9][a-z0-9._-]{0,95}$/.test(value.build) ? Object.freeze({ surface: value.surface, build: value.build }) : null;
    this.checkoutAdmission = admission instanceof Promise ? admission.then(validated).catch(() => null) : Promise.resolve(validated(admission));
  }

  readCanonicalSettings(): Promise<CanonicalSettingsEnvelope> {
    return this.invokeSettings({ protocol: 2, action: "read" });
  }
  writeSettingsOperation(request: UntrustedSettingsOperationRequest): Promise<CanonicalSettingsEnvelope> {
    const parsed = readSettingsOperationRequest(request);
    if (parsed.status !== "parsed") return Promise.reject(new SettingsStorageRecovery("request-shape"));
    return this.invokeSettings(parsed.request);
  }
  private async invokeSettings(body: UntrustedSettingsOperationRequest | { protocol: 2; action: "read" }): Promise<CanonicalSettingsEnvelope> {
    if (!this.modernSettingsEnabled) throw new SettingsStorageRecovery("rollout-held");
    const { data, error } = await this.client.functions.invoke(this.routes.settings, {
      body, signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
    });
    if (error) throw error;
    const envelope = parseCanonicalSettingsEnvelope(data);
    if (!envelope) throw new SettingsStorageRecovery("invalid-canonical-settings");
    return envelope;
  }

  async reconcileEntitlement(): Promise<void> {
    // The session JWT is attached automatically; the function derives the subject from it (KTD5).
    const { error } = await this.client.functions.invoke(this.routes.reconcile, {
      body: this.sandbox ? { access_schema: 1 } : {},
      signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
    });
    if (error) throw error;
  }

  /** Status-aware reconcile (plan U5): the same invoke as `reconcileEntitlement` above, but the
   * failure maps by HTTP status instead of throwing — 401 → auth-required (re-sign-in, never
   * teardown), everything else → unavailable. Mirrors `createWebCheckout`'s mapping below. */
  async reconcileEntitlementChecked(): Promise<ReconcileCallOutcome> {
    const { error } = await this.client.functions.invoke(this.routes.reconcile, {
      body: this.sandbox ? { access_schema: 1 } : {},
      signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
    });
    if (!error) return "ok";
    return statusOf(error) === 401 ? "auth-required" : "unavailable";
  }

  /** Start or recover a Managed Payments checkout. Maps the create-web-checkout contract by HTTP
   * status ONLY — 200 → checkout-url, 409 → already-entitled, 401 → auth-required, everything else
   * (502, network, malformed body) → unavailable. `functions.invoke` buries the status inside
   * `FunctionsHttpError.context` (the raw Response), so the mapping reads it from there; the
   * response's error strings are never matched. */
  async createWebCheckout(operationId?: string): Promise<WebCheckoutOutcome> {
    try {
      const admission = this.sandbox ? null : await this.checkoutAdmission;
      if ((!this.sandbox && !admission) || (operationId !== undefined && !isAccessUUID(operationId))) return { kind: "unavailable" };
      const { data, error } = await this.client.functions.invoke(this.routes.createCheckout, {
        body: { access_schema: 1, ...admission, ...(operationId ? { operation_id: operationId } : {}) },
        signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
      });
      if (!error) {
        const result = readManagedCheckoutResponse(data, this.sandbox, operationId);
        if (!result) return { kind: "unavailable" };
        return result.url ? { kind: "checkout-url", url: result.url, operationId: result.operationId }
          : { kind: "unavailable", operationId: result.operationId };
      }
      const status = statusOf(error);
      if (status === 409) return { kind: "already-entitled" }; // cross-device restore — a success (R5/AE4)
      if (status === 401) return { kind: "auth-required" }; // session death — re-sign-in, never teardown
      return { kind: "unavailable" }; // 502 / network / timeout / unexpected — one calm retry line (R3)
    } catch { return { kind: "unavailable" }; }
  }

  async completeWebCheckout(operationId: string): Promise<WebCheckoutCompletion> {
    const admission = this.sandbox ? null : await this.checkoutAdmission;
    if ((!this.sandbox && !admission) || !this.routes.completeCheckout || !isAccessUUID(operationId)) return { kind: "unavailable" };
    try {
      const { data, error } = await this.client.functions.invoke(this.routes.completeCheckout, {
        body: { access_schema: 1, ...admission, operation_id: operationId }, signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
      });
      if (error) return { kind: statusOf(error) === 401 ? "auth-required" : "unavailable" };
      const result = readManagedCheckoutResponse(data, this.sandbox, operationId);
      return result ? { kind: "observed", operationId: result.operationId,
        terminal: ["refunded", "closed_unpaid", "access_observed"].includes(result.status) } : { kind: "unavailable" };
    } catch { return { kind: "unavailable" }; }
  }

  async readEntitlement(): Promise<EntitlementRead> {
    // The QA lane consumes scoped proofs through the host's existing fenced reconciler.
    // Reading the shared legacy Boolean here would bypass its environment/registry boundary.
    if (this.sandbox) return "unknown";
    const { data, error } = await this.client
      .from("entitlements")
      .select("still_sync")
      .maybeSingle<{ still_sync: boolean }>();
    if (error) return "unknown";
    return data?.still_sync === true ? "entitled" : "not-entitled";
  }

  /**
   * The account's saved settings, or null when the account has never saved any.
   *
   * The null answer is load-bearing: the reconcile treats an account with nothing in it as one it
   * may start from scratch, so "there is no row" and "the row could not be read" have to stay
   * different answers. PostgREST reports no row as data null with no error, so a failure is raised
   * here rather than being passed on as an empty account.
   */
  async readProfile(): Promise<SyncedSettingsEnvelope | null> {
    if (this.sandbox) throw new SettingsStorageRecovery("rollout-held");
    const { data, error } = await this.client
      .from("profiles")
      .select("settings,settings_version,settings_server_updated_at,settings_last_write_id")
      .maybeSingle<{
        settings: unknown;
        settings_version: unknown;
        settings_server_updated_at: unknown;
        settings_last_write_id: unknown;
      }>();
    if (error) throw error;
    return parseSyncedSettingsEnvelope(data);
  }

  async writeProfile(settings: StillSettings, writeId: string): Promise<SyncedSettingsEnvelope> {
    if (this.sandbox) throw new SettingsStorageRecovery("rollout-held");
    const { data, error } = await this.client.rpc("write_profile_settings", {
      p_settings: settings,
      p_write_id: writeId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    const envelope = parseSyncedSettingsEnvelope(row);
    if (!envelope) throw new Error("Invalid profile settings envelope");
    return envelope;
  }

  subscribeToSettingsChanges(
    userId: string,
    onChange: () => void,
    onStatus?: (status: "subscribed" | "disconnected" | "error") => void,
  ): () => void {
    if (!this.sandbox) return this.subscribeToProfile(userId, () => onChange(), onStatus);
    let active = true;
    const channel = this.client.channel(`qa-settings-v1:${userId}`, { config: { private: true } })
      .on("broadcast", { event: "settings-changed" }, (message) => {
        if (active && message.payload?.schema === 1) onChange();
      })
      .subscribe((status) => {
        if (!active) return;
        if (status === "SUBSCRIBED") onStatus?.("subscribed");
        else if (status === "CHANNEL_ERROR") onStatus?.("error");
        else if (status === "CLOSED" || status === "TIMED_OUT") onStatus?.("disconnected");
      });
    return () => {
      if (!active) return;
      active = false;
      void this.client.removeChannel(channel).catch(() => {});
    };
  }

  subscribeToProfile(
    userId: string,
    onEnvelope: (envelope: SyncedSettingsEnvelope) => void,
    onStatus?: (status: "subscribed" | "disconnected" | "error") => void,
  ): () => void {
    if (this.sandbox) return () => {};
    const channel = this.client
      .channel(`profile-settings:${userId}`)
      .on(
        "postgres_changes",
        {
          // "*" (INSERT + UPDATE): the FIRST cloud write for a user is an INSERT — the profiles row
          // is only ever created by write_profile_settings' insert…on conflict path, so an
          // UPDATE-only stream misses another device's first write until a reconnect.
          event: "*",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${userId}`,
        },
        (payload) => {
          const envelope = parseSyncedSettingsEnvelope(payload.new);
          if (envelope) onEnvelope(envelope);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") onStatus?.("subscribed");
        else if (status === "CHANNEL_ERROR") onStatus?.("error");
        else if (status === "CLOSED" || status === "TIMED_OUT") onStatus?.("disconnected");
      });
    return () => {
      void channel.unsubscribe();
    };
  }

  async deleteAccount(): Promise<AccountDeletionResult> {
    // The session JWT is attached automatically; the function derives the subject from it and deletes
    // the auth user (cascades profile + entitlement, U11/U15). Surface the failure so the UI can show
    // it rather than appearing to delete when it didn't.
    const { data, error } = await this.client.functions.invoke("delete-user", {
      body: {},
      signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
    });
    if (error) throw error;
    const result = readAccountDeletionResult(data);
    if (!result) throw new Error("Account deletion is unconfirmed");
    return result;
  }
}

const MANAGED_CHECKOUT_STATES = new Set(["prepared", "session_bound", "paid_verified",
  "import_pending", "imported", "access_observed", "closed_unpaid", "refunded", "recovery_required"]);

function readManagedCheckoutResponse(value: unknown, sandbox: boolean, requestedOperation?: string): {
  operationId: string; status: string; url?: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["operation_id", "status", "checkout_url", "access"].includes(key)) ||
    !isAccessUUID(row.operation_id) || requestedOperation !== undefined && row.operation_id !== requestedOperation ||
    typeof row.status !== "string" || !MANAGED_CHECKOUT_STATES.has(row.status)) return null;
  const checkoutUrl = sandbox ? /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_[A-Za-z0-9]{1,200}(?:#[A-Za-z0-9_%=+.-]{1,2048})?$/
    : /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_live_[A-Za-z0-9]{1,200}(?:#[A-Za-z0-9_%=+.-]{1,2048})?$/;
  if (Object.hasOwn(row, "checkout_url") && (row.status !== "session_bound" || typeof row.checkout_url !== "string" ||
    row.checkout_url.length > 4096 || !checkoutUrl.test(row.checkout_url))) return null;
  return { operationId: row.operation_id, status: row.status, ...(typeof row.checkout_url === "string" ? { url: row.checkout_url } : {}) };
}

/** The HTTP status of a failed `functions.invoke`, or null when it isn't an HTTP error (network,
 * timeout/abort, malformed) — those map to the calm `unavailable` branch. `functions.invoke` buries
 * the status inside `FunctionsHttpError.context` (the raw Response); everything else has no status. */
function statusOf(error: unknown): number | null {
  if (!(error instanceof FunctionsHttpError)) return null;
  const status = (error.context as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/** Exact fbc62b2 server contract: a public row SELECT never supplies an authenticated anchor. */
export function parseCanonicalSettingsEnvelope(value: unknown): CanonicalSettingsEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const receipt = readSettingsReceipt(row.receipt);
  if (row.status !== "ready" || row.protocol !== 2 || typeof row.empty !== "boolean" ||
    !receipt || row.lineage !== receipt.lineage || row.settingsVersion !== receipt.revision ||
    !(row.settingsServerUpdatedAt === null || typeof row.settingsServerUpdatedAt === "string" && !Number.isNaN(Date.parse(row.settingsServerUpdatedAt))) ||
    !(row.writeId === null || typeof row.writeId === "string")) return null;
  const settings = migrateSettingsV2(row.settings, { kind: "acknowledged-account", revision: receipt.revision,
    provenInitialization: row.empty });
  if (settings.status !== "ready" || settings.migrated || SETTINGS_FIELDS.some(path => settings.settings.clocks[path].baseRevision > receipt.revision)) return null;
  return { protocol: 2, empty: row.empty, settings: { ...settings.settings, pauses: [] },
    version: receipt.revision, serverUpdatedAt: row.settingsServerUpdatedAt as string | null,
    lastWriteId: row.writeId as string | null, lineage: receipt.lineage, receipt };
}
