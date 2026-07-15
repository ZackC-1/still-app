import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthPort, CodeAuthPort, RequestCodeOutcome, VerifyCodeOutcome } from "./ports.js";

// Passwordless email auth over Supabase (R8, plan U2/R1). EVERY live host — the extensions AND
// the Apple app (since 2026-07-06) — completes with the emailed 6-digit code ({{ .Token }}); the
// magic-link path ({{ .ConfirmationURL }}) is retained for a possible future full-browser host
// but is currently wired by no one (a WKWebView can never receive the link's browser redirect).
// The returned user UUID is later used as the RevenueCat app_user_id (KTD5).

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
   * tapping a link. Structured outcome only; the raw error text never reaches the UI.
   * Classification is by GoTrue's structured `error.code` exclusively (R1): a 429
   * `over_email_send_rate_limit` becomes its own wait-state kind instead of the generic
   * "try again" that invites hammering the very limit that fired. */
  async requestCode(email: string): Promise<RequestCodeOutcome> {
    try {
      const { error } = await this.client.auth.signInWithOtp({ email });
      if (!error) return { kind: "sent" };
      if (error.code === "over_email_send_rate_limit") return { kind: "send-rate-limited" };
      return { kind: "send-failed" };
    } catch {
      return { kind: "send-failed" };
    }
  }

  /** Exchange the emailed 6-digit code for a session. GoTrue deliberately reports a wrong token
   * and an expired token as ONE error (`otp_expired`, anti-enumeration), so both map to
   * `invalid-code` — expired-vs-wrong presentation is the controller's clock-based call. Every
   * other error routes by `error.code` alone (R1/R5): the per-IP verify throttle gets its own
   * non-attempt kind, and anything unrecognized — including non-OTP 403s like `otp_disabled` and
   * code-absent responses — is `verify-failed` (calm retry, not an attempt), NEVER "wrong code";
   * the old `status === 403` catch-all dead-ended those as forever-wrong. */
  async verifyCode(email: string, token: string): Promise<VerifyCodeOutcome> {
    try {
      const { data, error } = await this.client.auth.verifyOtp({ email, token, type: "email" });
      if (error) {
        if (error.code === "otp_expired") return { kind: "invalid-code" };
        if (error.code === "over_request_rate_limit") return { kind: "verify-rate-limited" };
        return { kind: "verify-failed" };
      }
      const userId = data.user?.id ?? data.session?.user.id;
      return userId ? { kind: "verified", userId } : { kind: "verify-failed" };
    } catch {
      return { kind: "verify-failed" };
    }
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
