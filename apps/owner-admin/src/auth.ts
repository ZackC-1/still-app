// Sign-in for the owner page: the same emailed 6-digit code as every Still surface, through the
// public anon key. Signing in proves only who someone is; whether they may use this page is decided
// by the server's owner allowlist on every admin call, never here.
//
// The session lives in memory only (persistSession: false): closing or reloading the tab signs out,
// and nothing about it is written to this origin's storage, which the public website shares.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type RequestCodeOutcome = "sent" | "failed";
export type VerifyCodeOutcome = "verified" | "wrong-code" | "failed";

export interface OwnerAuth {
  requestCode(email: string): Promise<RequestCodeOutcome>;
  verifyCode(email: string, code: string): Promise<VerifyCodeOutcome>;
  /** The current session's access token (refreshed by the client while the tab is open). */
  accessToken(): Promise<string | null>;
  signOut(): Promise<void>;
}

export function supabaseOwnerAuth(url: string, anonKey: string, client?: SupabaseClient): OwnerAuth {
  const supabase =
    client ??
    createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    });
  return {
    async requestCode(email) {
      try {
        // Never creates an account: this page is for an existing account only.
        const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        return error ? "failed" : "sent";
      } catch {
        return "failed";
      }
    },
    async verifyCode(email, code) {
      try {
        const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
        // GoTrue reports a wrong and an expired code as one error, on purpose.
        if (error) return error.code === "otp_expired" ? "wrong-code" : "failed";
        return data.session ? "verified" : "failed";
      } catch {
        return "failed";
      }
    },
    async accessToken() {
      try {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token ?? null;
      } catch {
        return null;
      }
    },
    async signOut() {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // Local sign-out clears the in-memory session even when the revoke request fails.
      }
    },
  };
}
