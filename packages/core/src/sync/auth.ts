import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthPort, CodeAuthPort, RequestCodeOutcome, VerifyCodeOutcome } from "./ports.js";

// Passwordless email auth over Supabase (R8, plan U2/R1). EVERY live host — the extensions AND
// the Apple app (since 2026-07-06) — completes with the emailed 6-digit code ({{ .Token }}); the
// magic-link path ({{ .ConfirmationURL }}) is retained for a possible future full-browser host
// but is currently wired by no one (a WKWebView can never receive the link's browser redirect).
// The returned user UUID is later used as the RevenueCat app_user_id (KTD5).

/** The deterministic App Review sign-in (plan 2026-07-15-002, R8–R13): when configured, the ONE
 * designated review address routes send/verify through the review-signin edge function instead of
 * GoTrue — no email is ever sent; the reviewer types the fixed code from the App Review notes.
 * Config is Apple-build-only and injected explicitly (gate-production-trust-by-build-mode:
 * absence → this branch is unreachable and every address gets normal OTP). The address value
 * never lives in the repo — it arrives via build-time env. */
export interface ReviewSigninConfig {
  readonly email: string;
}

/** Exact-match after the same normalization GoTrue applies — a case/whitespace miss would
 * silently drop to the normal path and burn the real SMTP budget (AE8). */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The review-signin 429 body carries the rate-limit RPC's genuine wait seconds. */
function retryAfter(body: Record<string, unknown>): number | undefined {
  const v = body["retry_after"];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

export class SupabaseAuthPort implements AuthPort, CodeAuthPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly emailRedirectTo?: string,
    private readonly review?: ReviewSigninConfig,
  ) {}

  /** WARNING: deliberately NOT review-aware. This path is wired by no live host; if a future host
   * wires it, pointing it at the review address would send a REAL magic-link email (and consume
   * the shared one-per-user token). The review branch exists only on the code flow below. */
  async signInWithMagicLink(email: string): Promise<{ error?: string }> {
    const { error } = await this.client.auth.signInWithOtp({
      email,
      options: this.emailRedirectTo ? { emailRedirectTo: this.emailRedirectTo } : undefined,
    });
    return error ? { error: error.message } : {};
  }

  private isReviewEmail(email: string): boolean {
    return (
      this.review !== undefined &&
      normalizeEmail(email) === normalizeEmail(this.review.email)
    );
  }

  /** Invoke the review-signin function and report `{status, body}`; null on transport failure
   * (network / relay errors carry no status). Uses the supabase-js functions transport — base
   * URL, anon-key headers, and CORS shape come with the client, so no URL config is needed. */
  private async invokeReviewSignin(
    body: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> } | null> {
    try {
      const { data, error } = await this.client.functions.invoke("review-signin", { body });
      if (!error) return { status: 200, body: (data ?? {}) as Record<string, unknown> };
      // FunctionsHttpError carries the Response as `context`; fetch/relay errors do not.
      const ctx = (error as { context?: unknown }).context;
      if (ctx instanceof Response) {
        const parsed = (await ctx.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: ctx.status, body: parsed };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Code flow: same OTP email, but no redirect option — the user types the code instead of
   * tapping a link. Structured outcome only; the raw error text never reaches the UI.
   * Classification is by GoTrue's structured `error.code` exclusively (R1): a 429
   * `over_email_send_rate_limit` becomes its own wait-state kind instead of the generic
   * "try again" that invites hammering the very limit that fired. */
  async requestCode(email: string): Promise<RequestCodeOutcome> {
    // Review branch (R8/R9): a server PREFLIGHT, not a client-side silent no-op — it proves the
    // server half of the config exists before rendering "code sent". 429 renders the wait state
    // (falling through would convert every throttled review request into a real email); the
    // not-configured refusal (404) and transport failures fall through to the normal send, so
    // client/server config drift degrades to ordinary OTP instead of stranding the address.
    if (this.isReviewEmail(email)) {
      const res = await this.invokeReviewSignin({
        action: "request",
        email: normalizeEmail(email),
      });
      if (res?.status === 200) return { kind: "sent" };
      if (res?.status === 429)
        return { kind: "send-rate-limited", retryAfterSeconds: retryAfter(res.body) };
    }
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
    // Review branch (R8/R9): the function mints a real session (admin generateLink + verifyOtp
    // server-side) and returns its tokens; setSession makes it indistinguishable from an
    // OTP-minted session (refresh, sign-out, deletion all behave normally). Status contract is
    // stable (U3): 401 = wrong fixed code; 429 = rate-limited with a GENUINE retry-after; 404 =
    // not configured — fall through to normal GoTrue verify so a drift-window fallback email's
    // real code can still complete (without this, drift bricks the address: the whole reason the
    // fallback exists). 5xx/network → calm retry.
    if (this.isReviewEmail(email)) {
      const res = await this.invokeReviewSignin({
        action: "verify",
        email: normalizeEmail(email),
        code: token,
      });
      if (res?.status === 200) {
        const { access_token, refresh_token, user_id } = res.body as {
          access_token?: string;
          refresh_token?: string;
          user_id?: string;
        };
        if (access_token && refresh_token) {
          const { data, error } = await this.client.auth.setSession({
            access_token,
            refresh_token,
          });
          const userId = user_id ?? data?.user?.id;
          if (!error && userId) return { kind: "verified", userId };
        }
        return { kind: "verify-failed" };
      }
      if (res?.status === 401) return { kind: "invalid-code" };
      if (res?.status === 429)
        return { kind: "verify-rate-limited", retryAfterSeconds: retryAfter(res.body) };
      if (res !== null && res.status !== 404) return { kind: "verify-failed" };
      // 404 (not configured) or transport failure: fall through to the normal verify below.
    }
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
