import { handleSyncSettings } from "./handler.ts";
import { authenticatedClaims } from "../_shared/jwt.ts";
import { createWriterSql, PgRateLimiter } from "../_shared/pg-store.ts";
import { PgSettingsStore } from "../_shared/pg-settings-store.ts";
const sql = createWriterSql(Deno.env.get("SETTINGS_WRITER_DB_URL") ?? "");
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
Deno.serve((req) =>
  handleSyncSettings(req, {
    jwtSecret: Deno.env.get("SUPABASE_JWT_SECRET") ?? "",
    jwksUrl: supabaseUrl
      ? `${supabaseUrl}/auth/v1/.well-known/jwks.json`
      : undefined,
    expected: authenticatedClaims(supabaseUrl || undefined),
    store: new PgSettingsStore(sql),
    limiter: new PgRateLimiter(sql),
  })
);
