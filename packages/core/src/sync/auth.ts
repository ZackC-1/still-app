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
    await this.client.auth.signOut();
  }

  async currentUserId(): Promise<string | null> {
    const { data } = await this.client.auth.getUser();
    return data.user?.id ?? null;
  }
}
