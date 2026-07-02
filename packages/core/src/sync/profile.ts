import type { SupabaseClient } from "@supabase/supabase-js";
import { FunctionsHttpError } from "@supabase/supabase-js";
import type { StillSettings } from "@still/shared-types";
import { parseSettings } from "../storage/settings-validation.js";
import type {
  BackendPort,
  CheckedReconcilePort,
  EntitlementRead,
  ReconcileCallOutcome,
  WebCheckoutOutcome,
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

export class SupabaseBackendPort implements BackendPort, WebCheckoutPort, CheckedReconcilePort {
  constructor(private readonly client: SupabaseClient) {}

  async reconcileEntitlement(): Promise<void> {
    // The session JWT is attached automatically; the function derives the subject from it (KTD5).
    const { error } = await this.client.functions.invoke("reconcile-entitlement", {
      body: {},
      signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
    });
    if (error) throw error;
  }

  /** Status-aware reconcile (plan U5): the same invoke as `reconcileEntitlement` above, but the
   * failure maps by HTTP status instead of throwing — 401 → auth-required (re-sign-in, never
   * teardown), everything else → unavailable. Mirrors `createWebCheckout`'s mapping below. */
  async reconcileEntitlementChecked(): Promise<ReconcileCallOutcome> {
    const { error } = await this.client.functions.invoke("reconcile-entitlement", {
      body: {},
      signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
    });
    if (!error) return "ok";
    return statusOf(error) === 401 ? "auth-required" : "unavailable";
  }

  /** Start a Web Billing checkout (plan U4/R3/R5). Maps the create-web-checkout contract by HTTP
   * status ONLY — 200 → checkout-url, 409 → already-entitled, 401 → auth-required, everything else
   * (502, network, malformed body) → unavailable. `functions.invoke` buries the status inside
   * `FunctionsHttpError.context` (the raw Response), so the mapping reads it from there; the
   * response's error strings are never matched. */
  async createWebCheckout(): Promise<WebCheckoutOutcome> {
    const { data, error } = await this.client.functions.invoke("create-web-checkout", {
      body: {},
      signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
    });
    if (!error) {
      const url = (data as { checkout_url?: unknown } | null)?.checkout_url;
      // A 200 without a usable, https URL is a malformed success — fail calm, never open a garbage or
      // non-https tab. The extension is the last gate before opening a trusted-looking checkout tab,
      // so it validates the scheme even though the URL comes from our own authenticated backend.
      return typeof url === "string" && isHttpsUrl(url)
        ? { kind: "checkout-url", url }
        : { kind: "unavailable" };
    }
    const status = statusOf(error);
    if (status === 409) return { kind: "already-entitled" }; // cross-device restore — a success (R5/AE4)
    if (status === 401) return { kind: "auth-required" }; // session death — re-sign-in, never teardown
    return { kind: "unavailable" }; // 502 / network / timeout / unexpected — one calm retry line (R3)
  }

  async readEntitlement(): Promise<EntitlementRead> {
    const { data, error } = await this.client
      .from("entitlements")
      .select("still_sync")
      .maybeSingle<{ still_sync: boolean }>();
    if (error) return "unknown";
    return data?.still_sync === true ? "entitled" : "not-entitled";
  }

  async readProfile(): Promise<StillSettings | null> {
    const { data } = await this.client
      .from("profiles")
      .select("settings")
      .maybeSingle<{ settings: unknown }>();
    return parseSettings(data?.settings);
  }

  async writeProfile(settings: StillSettings): Promise<void> {
    const { data: userData } = await this.client.auth.getUser();
    const id = userData.user?.id;
    if (!id) return;
    await this.client.from("profiles").upsert({
      id,
      settings,
      updated_at: new Date(settings.updatedAt).toISOString(),
    });
  }

  async deleteAccount(): Promise<void> {
    // The session JWT is attached automatically; the function derives the subject from it and deletes
    // the auth user (cascades profile + entitlement, U11/U15). Surface the failure so the UI can show
    // it rather than appearing to delete when it didn't.
    const { error } = await this.client.functions.invoke("delete-user", {
      body: {},
      signal: AbortSignal.timeout(EDGE_FN_TIMEOUT_MS),
    });
    if (error) throw error;
  }
}

/** The HTTP status of a failed `functions.invoke`, or null when it isn't an HTTP error (network,
 * timeout/abort, malformed) — those map to the calm `unavailable` branch. `functions.invoke` buries
 * the status inside `FunctionsHttpError.context` (the raw Response); everything else has no status. */
function statusOf(error: unknown): number | null {
  if (!(error instanceof FunctionsHttpError)) return null;
  const status = (error.context as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/** True only for a well-formed https URL — the scheme gate before opening a checkout tab. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
