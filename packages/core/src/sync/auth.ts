import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthPort } from "./ports.js";

// Magic-link auth over Supabase (R8). Email magic link is the universal cross-platform sign-in;
// Sign in with Apple is wired only in the Apple app (U19). The returned user UUID is later used as
// the RevenueCat app_user_id (KTD5).

export class SupabaseAuthPort implements AuthPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly emailRedirectTo?: string,
  ) {}

  async signInWithMagicLink(email: string): Promise<{ error?: string }> {
    const { error } = await this.client.auth.signInWithOtp({
      email,
      options: this.emailRedirectTo ? { emailRedirectTo: this.emailRedirectTo } : undefined,
    });
    return error ? { error: error.message } : {};
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }

  async currentUserId(): Promise<string | null> {
    const { data } = await this.client.auth.getUser();
    return data.user?.id ?? null;
  }
}
