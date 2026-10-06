import { handleAnalyticsErasure } from "./handler.ts";
import { PgErasureStore } from "../_shared/erasure-store.ts";
import { createWriterSql, PgRateLimiter } from "../_shared/pg-store.ts";
import { HttpPostHogErasure } from "../_shared/posthog-erasure.ts";
import { postHogConfigFromEnv } from "../_shared/posthog.ts";

// Entrypoint (config.toml: verify_jwt=false; see handler.ts). The eraser login is a function secret
// set by a separate owner operation; until it exists every route answers 503 and nothing changes.
const eraserUrl = Deno.env.get("ANALYTICS_ERASER_DB_URL") ?? "";
const sql = eraserUrl ? createWriterSql(eraserUrl) : null;
const store = sql ? new PgErasureStore(sql) : null;
const limiter = sql ? new PgRateLimiter(sql) : null;
const posthog = new HttpPostHogErasure(postHogConfigFromEnv((name) => Deno.env.get(name)));
const workerToken = Deno.env.get("ANALYTICS_ERASURE_WORKER_TOKEN") ?? "";

Deno.serve((req) => handleAnalyticsErasure(req, { store, limiter, posthog, workerToken }));
