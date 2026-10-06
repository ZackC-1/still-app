import { eraserFromUrl, handleDeleteUser } from "./handler.ts";
import { authenticatedClaims } from "../_shared/jwt.ts";
import { HttpPostHog, postHogConfigFromEnv } from "../_shared/posthog.ts";
import { SupabaseUserStore } from "../_shared/supabase-store.ts";

// Entrypoint (config.toml: verify_jwt=true). delete-user needs admin to remove the auth user.
const store = new SupabaseUserStore(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);
const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const jwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined;
const expected = authenticatedClaims(supabaseUrl || undefined);
const posthog = new HttpPostHog(postHogConfigFromEnv((name) => Deno.env.get(name)));
// The analytics eraser login (0017/0018), the same secret analytics-identify issues per-device
// identities with (function secrets are project-wide). Without it no identity can exist, and the
// deletion runs exactly as before. It does not depend on ANALYTICS_SUBJECTS_ENABLED: identities
// issued while that switch was on must still be captured after it is turned off. A malformed value
// never stops this function from starting (eraserFromUrl never throws).
const erasure = eraserFromUrl(Deno.env.get("ANALYTICS_ERASER_DB_URL"));

Deno.serve((req) => handleDeleteUser(req, { jwtSecret, jwksUrl, expected, store, posthog, erasure }));
