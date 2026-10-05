import { createClient } from "@supabase/supabase-js";
import { handleAnalyticsIdentify } from "./handler.ts";
import { authenticatedClaims } from "../_shared/jwt.ts";
import { HttpPostHog, postHogConfigFromEnv } from "../_shared/posthog.ts";
import { HttpPostHogErasure } from "../_shared/posthog-erasure.ts";
import { PgErasureStore } from "../_shared/erasure-store.ts";
import { createWriterSql, PgRateLimiter } from "../_shared/pg-store.ts";

// Entrypoint (config.toml: verify_jwt=true). Reads the caller's email with the service role; the
// subject is only ever the verified JWT's.
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false },
});
const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const jwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined;
const expected = authenticatedClaims(supabaseUrl || undefined);
const postHogConfig = postHogConfigFromEnv((name) => Deno.env.get(name));
const posthog = new HttpPostHog(postHogConfig);
// Per-device identities (0017) need the eraser login, a separate owner operation. Without it the
// released 2.1 path works exactly as before and the per-device path answers 503.
const eraserUrl = Deno.env.get("ANALYTICS_ERASER_DB_URL") ?? "";
const eraserSql = eraserUrl ? createWriterSql(eraserUrl) : null;
const subjects = eraserSql
  ? {
    store: new PgErasureStore(eraserSql),
    limiter: new PgRateLimiter(eraserSql),
    posthog: new HttpPostHogErasure(postHogConfig),
  }
  : null;

// The marker lives in app_metadata: writable only with the service role, never by the user.
const SEEN_KEY = "still_analytics_seen";
const accounts = {
  async account(userId: string) {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) throw error;
    const user = data.user;
    if (!user) return null;
    return {
      email: user.email ?? null,
      createdAt: user.created_at ?? null,
      analyticsSeen: user.app_metadata?.[SEEN_KEY] === true,
    };
  },
  async markAnalyticsSeen(userId: string) {
    const { data } = await admin.auth.admin.getUserById(userId);
    const { error } = await admin.auth.admin.updateUserById(userId, {
      app_metadata: { ...(data.user?.app_metadata ?? {}), [SEEN_KEY]: true },
    });
    if (error) throw error;
  },
};

// HARD GATE: off unless exactly "true". Not before the account-deletion reorder and the subject
// snapshot (migration 0017) are deployed and verified.
const subjectsEnabled = Deno.env.get("ANALYTICS_SUBJECTS_ENABLED") === "true";

Deno.serve((req) =>
  handleAnalyticsIdentify(req, { jwtSecret, jwksUrl, expected, accounts, posthog, subjectsEnabled, subjects })
);
