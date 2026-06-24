import type { SupabaseClient } from "@supabase/supabase-js";
import type { StillSettings } from "@still/shared-types";
import type { BackendPort } from "./ports.js";

// Entitlement + profile-settings access over Supabase. Reads rely on RLS (a user sees only its own
// rows); the reconcile call self-heals the entitlement on every sign-in (U13/U14).

export class SupabaseBackendPort implements BackendPort {
  constructor(private readonly client: SupabaseClient) {}

  async reconcileEntitlement(): Promise<void> {
    // The session JWT is attached automatically; the function derives the subject from it (KTD5).
    await this.client.functions.invoke("reconcile-entitlement", { body: {} });
  }

  async readEntitlement(): Promise<boolean> {
    const { data } = await this.client
      .from("entitlements")
      .select("still_sync")
      .maybeSingle<{ still_sync: boolean }>();
    return data?.still_sync ?? false;
  }

  async readProfile(): Promise<StillSettings | null> {
    const { data } = await this.client
      .from("profiles")
      .select("settings")
      .maybeSingle<{ settings: StillSettings }>();
    return data?.settings ?? null;
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
}
