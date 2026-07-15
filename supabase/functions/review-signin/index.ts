import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createWriterSql, PgRateLimiter } from "../_shared/pg-store.ts";
import {
  handleReviewSignin,
  type ReviewAdmin,
  type ReviewSession,
  type ReviewUser,
} from "./handler.ts";

// Entrypoint (config.toml: verify_jwt=false — the gate lives in the handler: review-email
// allowlist + constant-time fixed-code compare + fail-closed rate limiting). Missing env reaches
// the handler as unset config, which refuses every request (fail closed) — never throw here.

/** GoTrue-admin adapter for the session mint (supported admin APIs only — plan U3 KTD). */
class GoTrueReviewAdmin implements ReviewAdmin {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async findUserByEmail(email: string): Promise<ReviewUser | null> {
    // The admin JS API has no direct email lookup; page through the list. Bounded in practice:
    // this path is reachable only for the single review address and rate-limited to 5/email/10min.
    const perPage = 1000;
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await this.client.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const match = data.users.find((u) => (u.email ?? "").trim().toLowerCase() === email);
      if (match) return { id: match.id, emailConfirmed: Boolean(match.email_confirmed_at) };
      if (data.users.length < perPage) return null;
    }
    throw new Error("auth user list exceeded the review-lookup page cap");
  }

  async createConfirmedUser(email: string): Promise<ReviewUser | null> {
    const { data, error } = await this.client.auth.admin.createUser({ email, email_confirm: true });
    if (error) {
      // "already registered" (email_exists/422): a concurrent first sign-in won the race — the
      // handler re-looks-up and adopts the winner's row.
      if (error.code === "email_exists" || error.status === 422) return null;
      throw error;
    }
    return { id: data.user.id, emailConfirmed: true };
  }

  async confirmEmail(userId: string): Promise<void> {
    const { error } = await this.client.auth.admin.updateUserById(userId, { email_confirm: true });
    if (error) throw error;
  }

  async generateMagicLinkTokenHash(email: string): Promise<string> {
    const { data, error } = await this.client.auth.admin.generateLink({ type: "magiclink", email });
    if (error) throw error;
    const tokenHash = data.properties?.hashed_token;
    if (!tokenHash) throw new Error("generateLink returned no hashed token");
    return tokenHash;
  }

  async verifyMagicLinkTokenHash(tokenHash: string): Promise<ReviewSession> {
    const { data, error } = await this.client.auth.verifyOtp({ type: "email", token_hash: tokenHash });
    if (error) throw error;
    const userId = data.user?.id ?? data.session?.user.id;
    if (!data.session || !userId) throw new Error("verifyOtp returned no session");
    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user_id: userId,
    };
  }
}

// Both secrets are set only via `supabase secrets set` at deploy time (U5) — never committed.
// Unset (e.g. deliberately, to disable the mechanism) → the handler refuses everything.
const config = {
  reviewEmail: Deno.env.get("REVIEW_SIGNIN_EMAIL") ?? "",
  reviewCode: Deno.env.get("REVIEW_SIGNIN_CODE") ?? "",
};
const admin = new GoTrueReviewAdmin(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);
// Rate limiting rides the narrow writer credential — consume_rate_limit's EXECUTE is granted to
// still_entitlement_writer only (0010); a service-role PostgREST call would be denied.
const limiter = new PgRateLimiter(createWriterSql(Deno.env.get("ENTITLEMENT_WRITER_DB_URL") ?? ""));

Deno.serve((req) => handleReviewSignin(req, { config, limiter, admin }));
