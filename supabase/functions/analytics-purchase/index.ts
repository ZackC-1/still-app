import { authenticatedClaims } from "../_shared/jwt.ts";
import { createWriterSql, PgRateLimiter } from "../_shared/pg-store.ts";
import { postHogConfigFromEnv } from "../_shared/posthog.ts";
import { PgPurchaseAnalyticsStore } from "./store.ts";
import { sendPurchaseAnalytics } from "./posthog.ts";
import { handlePurchaseAnalytics } from "./handler.ts";

const read = (name: string) => Deno.env.get(name);
const url = read("SUPABASE_URL") ?? "";
const config = postHogConfigFromEnv(read);
const db = read("ANALYTICS_ERASER_DB_URL");
const sql = db ? createWriterSql(db) : null;
const digest = config.projectKey?.trim()
  ? crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(config.projectKey.trim()))
      .then((value) =>
        [...new Uint8Array(value)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      )
  : Promise.resolve(null);
Deno.serve(async (req) =>
  handlePurchaseAnalytics(req, {
    jwtSecret: read("SUPABASE_JWT_SECRET") ?? "",
    jwksUrl: url ? `${url}/auth/v1/.well-known/jwks.json` : undefined,
    expected: authenticatedClaims(url || undefined),
    enabled:
      read("ANALYTICS_SUBJECTS_ENABLED") === "true" &&
      read("ACCESS_PROOF_ENVIRONMENT") === "production",
    store: sql ? new PgPurchaseAnalyticsStore(sql) : null,
    limiter: sql ? new PgRateLimiter(sql) : null,
    projectKeySha256: await digest,
    send: (claim, signal) => sendPurchaseAnalytics(config, claim, signal),
  }),
);
