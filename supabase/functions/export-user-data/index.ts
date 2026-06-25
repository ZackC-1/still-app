import { handleExport } from "./handler.ts";
import { authenticatedClaims } from "../_shared/jwt.ts";
import { SupabaseUserStore } from "../_shared/supabase-store.ts";

// Entrypoint (config.toml: verify_jwt=true). Returns only the caller's own data.
const store = new SupabaseUserStore(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);
const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const jwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined;
const expected = authenticatedClaims(supabaseUrl || undefined);

Deno.serve((req) => handleExport(req, { jwtSecret, jwksUrl, expected, store }));
