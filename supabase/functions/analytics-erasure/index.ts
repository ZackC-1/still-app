import { handleAnalyticsErasure } from "./handler.ts";
import { PgErasureStore } from "../_shared/erasure-store.ts";
import { createWriterSql, PgRateLimiter } from "../_shared/pg-store.ts";
import { HttpPostHogErasure } from "../_shared/posthog-erasure.ts";
import { authenticatedClaims } from "../_shared/jwt.ts";
import { HttpPostHog, postHogConfigFromEnv } from "../_shared/posthog.ts";

// Entrypoint (config.toml: verify_jwt=false; see handler.ts). The eraser login is a function secret
// set by a separate owner operation; until it exists every route answers 503 and nothing changes.
const eraserUrl = Deno.env.get("ANALYTICS_ERASER_DB_URL") ?? "";
const sql = eraserUrl ? createWriterSql(eraserUrl) : null;
const store = sql ? new PgErasureStore(sql) : null;
const limiter = sql ? new PgRateLimiter(sql) : null;
const posthog = new HttpPostHogErasure(postHogConfigFromEnv((name) => Deno.env.get(name)));
const workerToken = Deno.env.get("ANALYTICS_ERASURE_WORKER_TOKEN") ?? "";
// The account-wide routes verify the session themselves (verify_jwt stays false for the device
// routes), with the same settings as every signed-in function, and delete the legacy 2.1 person
// with the account-deletion adapter.
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const auth = {
  jwtSecret: Deno.env.get("SUPABASE_JWT_SECRET") ?? "",
  jwksUrl: supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined,
  expected: authenticatedClaims(supabaseUrl || undefined),
};
const legacy = new HttpPostHog(postHogConfigFromEnv((name) => Deno.env.get(name)));

Deno.serve((req) =>
  handleAnalyticsErasure(req, { store, limiter, posthog, workerToken, auth, account: store, legacy })
);
