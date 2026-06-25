import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { UserStore } from "./user-store.ts";

// Service-role UserStore for the account functions (U15). delete-user needs admin to remove the
// auth.users row; the cascade FKs then drop the profile + entitlement. Reads are filtered by the
// caller's UUID (taken from the verified JWT in the handler), never trusting client input.

export class SupabaseUserStore implements UserStore {
  private readonly admin: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async deleteUser(userId: string): Promise<void> {
    // GoTrue admin methods resolve with an `error` object rather than throwing — an unchecked call
    // would report a *failed* deletion as success, signing the user out while their account still
    // exists (a real GDPR/5.1.1 hole). Surface failures; tolerate "already gone" (404) for idempotency.
    const { error } = await this.admin.auth.admin.deleteUser(userId);
    if (error && error.status !== 404) throw error;
  }

  async getProfile(userId: string): Promise<unknown | null> {
    const { data } = await this.admin.from("profiles").select("settings, updated_at").eq("id", userId).maybeSingle();
    return data ?? null;
  }

  async getEntitlement(userId: string): Promise<unknown | null> {
    const { data } = await this.admin
      .from("entitlements")
      .select("still_sync, source, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    return data ?? null;
  }
}
