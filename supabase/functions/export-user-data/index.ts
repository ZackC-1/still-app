import { handleExport } from "./handler.ts";
import { SupabaseUserStore } from "../_shared/supabase-store.ts";

// Entrypoint (config.toml: verify_jwt=true). Returns only the caller's own data.
const store = new SupabaseUserStore(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);
const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";

Deno.serve((req) => handleExport(req, { jwtSecret, store }));
