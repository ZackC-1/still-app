import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthPort, CodeAuthPort, RequestCodeOutcome, VerifyCodeOutcome } from "./ports.js";

// Passwordless email auth over Supabase (R8, plan U2/R1). Two completion styles off the same
// signInWithOtp email: Apple keeps the magic link ({{ .ConfirmationURL }}), the extension enters
// the 6-digit code ({{ .Token }}) — one email template serves both (plan KTD). The returned user
// UUID is later used as the RevenueCat app_user_id (KTD5).

export class SupabaseAuthPort implements AuthPort, CodeAuthPort {
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

  /** Code flow: same OTP email, but no redirect option — the user types the code instead of
   * tapping a link. Structured outcome only; the raw error text never reaches the UI. */
  async requestCode(email: string): Promise<RequestCodeOutcome> {
    const { error } = await this.client.auth.signInWithOtp({ email });
    return error ? { kind: "send-failed" } : { kind: "sent" };
  }

  /** Exchange the emailed 6-digit code for a session. Supabase reports a wrong token and an
   * expired token as the same 403 `otp_expired` error, so both map to `invalid-code`; anything
   * else (offline, 5xx) is `verify-failed` — the code may still be good, so it's not an attempt. */
  async verifyCode(email: string, token: string): Promise<VerifyCodeOutcome> {
    const { data, error } = await this.client.auth.verifyOtp({ email, token, type: "email" });
    if (error) {
      const invalid = error.code === "otp_expired" || error.status === 403;
      return invalid ? { kind: "invalid-code" } : { kind: "verify-failed" };
    }
    const userId = data.user?.id ?? data.session?.user.id;
    return userId ? { kind: "verified", userId } : { kind: "verify-failed" };
  }

  async signOut(): Promise<void> {
    // auth-js 2.108.2 returns the error BEFORE removing the local session when the server revoke
    // fails on network/5xx (only 401/403/404 still clear locally), so a plain signOut() can leave a
    // live session persisted after an explicit sign-out. Fall back to scope:"local" so the local
    // session is dropped even when the global revoke couldn't reach the server. The extension teardown
    // also clears the persisted auth storage key directly (createExtensionSession clearAuthStorage),
    // which is the offline-proof guarantee; this keeps the shared AuthPort honest for every host.
    const { error } = await this.client.auth.signOut();
    if (error) await this.client.auth.signOut({ scope: "local" });
  }

  async currentUserId(): Promise<string | null> {
    const { data } = await this.client.auth.getUser();
    return data.user?.id ?? null;
  }
}
