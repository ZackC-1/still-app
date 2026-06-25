import { handleDeleteUser } from "./handler.ts";
import { SupabaseUserStore } from "../_shared/supabase-store.ts";

// Entrypoint (config.toml: verify_jwt=true). delete-user needs admin to remove the auth user.
const store = new SupabaseUserStore(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);
const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const jwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined;

Deno.serve((req) => handleDeleteUser(req, { jwtSecret, jwksUrl, store }));
