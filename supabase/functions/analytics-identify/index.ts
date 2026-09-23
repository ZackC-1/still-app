import { createClient } from "@supabase/supabase-js";
import { handleAnalyticsIdentify } from "./handler.ts";
import { authenticatedClaims } from "../_shared/jwt.ts";
import { HttpPostHog, postHogConfigFromEnv } from "../_shared/posthog.ts";

// Entrypoint (config.toml: verify_jwt=true). Reads the caller's email with the service role; the
// subject is only ever the verified JWT's.
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false },
});
const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const jwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined;
const expected = authenticatedClaims(supabaseUrl || undefined);
const posthog = new HttpPostHog(postHogConfigFromEnv((name) => Deno.env.get(name)));

const accounts = {
  async emailFor(userId: string): Promise<string | null> {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) throw error;
    return data.user?.email ?? null;
  },
};

Deno.serve((req) => handleAnalyticsIdentify(req, { jwtSecret, jwksUrl, expected, accounts, posthog }));
