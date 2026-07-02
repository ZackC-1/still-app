import type { SupabaseClient } from "@supabase/supabase-js";
import { FunctionsHttpError } from "@supabase/supabase-js";
import type { StillSettings } from "@still/shared-types";
import { parseSettings } from "../storage/settings-validation.js";
import type { BackendPort, EntitlementRead, WebCheckoutOutcome, WebCheckoutPort } from "./ports.js";

// Entitlement + profile-settings access over Supabase. Reads rely on RLS (a user sees only its own
// rows); the reconcile call self-heals the entitlement on every sign-in (U13/U14).

export class SupabaseBackendPort implements BackendPort, WebCheckoutPort {
  constructor(private readonly client: SupabaseClient) {}

  async reconcileEntitlement(): Promise<void> {
    // The session JWT is attached automatically; the function derives the subject from it (KTD5).
    const { error } = await this.client.functions.invoke("reconcile-entitlement", { body: {} });
    if (error) throw error;
  }

  /** Start a Web Billing checkout (plan U4/R3/R5). Maps the create-web-checkout contract by HTTP
   * status ONLY — 200 → checkout-url, 409 → already-entitled, 401 → auth-required, everything else
   * (502, network, malformed body) → unavailable. `functions.invoke` buries the status inside
   * `FunctionsHttpError.context` (the raw Response), so the mapping reads it from there; the
   * response's error strings are never matched. */
  async createWebCheckout(): Promise<WebCheckoutOutcome> {
    const { data, error } = await this.client.functions.invoke("create-web-checkout", { body: {} });
    if (!error) {
      const url = (data as { checkout_url?: unknown } | null)?.checkout_url;
      // A 200 without a usable URL is a malformed success — fail calm, never open a garbage tab.
      return typeof url === "string" && url.length > 0
        ? { kind: "checkout-url", url }
        : { kind: "unavailable" };
    }
    const status = error instanceof FunctionsHttpError ? httpStatus(error.context) : null;
    if (status === 409) return { kind: "already-entitled" }; // cross-device restore — a success (R5/AE4)
    if (status === 401) return { kind: "auth-required" }; // session death — re-sign-in, never teardown
    return { kind: "unavailable" }; // 502 / network / unexpected — one calm retry line (R3)
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
    const { error } = await this.client.functions.invoke("delete-user", { body: {} });
    if (error) throw error;
  }
}

/** The status from a FunctionsHttpError's context (the raw Response), read defensively — a context
 * without a numeric status maps to null (→ unavailable), never to a throw or a bogus branch. */
function httpStatus(context: unknown): number | null {
  const status = (context as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}
