import type { SupabaseClient } from "@supabase/supabase-js";
import type { StillSettings } from "@still/shared-types";
import { parseSettings } from "../storage/settings-validation.js";
import type { BackendPort, EntitlementRead } from "./ports.js";

// Entitlement + profile-settings access over Supabase. Reads rely on RLS (a user sees only its own
// rows); the reconcile call self-heals the entitlement on every sign-in (U13/U14).

export class SupabaseBackendPort implements BackendPort {
  constructor(private readonly client: SupabaseClient) {}

  async reconcileEntitlement(): Promise<void> {
    // The session JWT is attached automatically; the function derives the subject from it (KTD5).
    const { error } = await this.client.functions.invoke("reconcile-entitlement", { body: {} });
    if (error) throw error;
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
