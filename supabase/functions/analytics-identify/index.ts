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
// Per-device identities (0017) need the eraser login, a separate owner operation. Without it,
// per-device requests answer 503; released clients may use the narrow writer's abuse limiter.
const eraserUrl = Deno.env.get("ANALYTICS_ERASER_DB_URL") ?? "";
const eraserSql = eraserUrl ? createWriterSql(eraserUrl) : null;
// Released clients still need an abuse budget when per-device identity setup is disabled.
// Reuse an existing narrow role: both roles already hold the limiter RPC, never client grants.
// The released (2.1) body prefers the writer login, which is already proven in production, so a
// problem with the newer eraser login can never break it; the eraser is the fallback.
const writerUrl = Deno.env.get("ENTITLEMENT_WRITER_DB_URL") ?? "";
const limiterSql = (writerUrl ? createWriterSql(writerUrl) : null) ?? eraserSql;
const limiter = limiterSql ? new PgRateLimiter(limiterSql) : null;
const subjects = eraserSql
  ? {
    store: new PgErasureStore(eraserSql),
    limiter: new PgRateLimiter(eraserSql),
    posthog: new HttpPostHogErasure(postHogConfig, fetch, Deno.env.get("ANALYTICS_EVENT_ID_SECRET")),
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

// The PostHog project this server writes emails and account_created into, as a SHA-256 digest: a
// V3 client must claim the same project to get an identity (handler.ts, server-enforced channel).
const projectKey = postHogConfig.projectKey?.trim() ?? "";
const projectKeyDigest: Promise<string | null> = projectKey
  ? crypto.subtle.digest("SHA-256", new TextEncoder().encode(projectKey)).then((digest) =>
    [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
  )
  : Promise.resolve(null);

// HARD GATE: off unless exactly "true". Not before the account-deletion reorder and the subject
// snapshot (migration 0017) are deployed and verified.
const subjectsEnabled = Deno.env.get("ANALYTICS_SUBJECTS_ENABLED") === "true";

Deno.serve(async (req) =>
  handleAnalyticsIdentify(req, {
    jwtSecret,
    jwksUrl,
    expected,
    accounts,
    posthog,
    limiter,
    subjectsEnabled,
    subjects,
    projectKeySha256: await projectKeyDigest,
  })
);
