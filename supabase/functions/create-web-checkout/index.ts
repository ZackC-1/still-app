import { authenticatedClaims } from "../_shared/jwt.ts";
import { createWriterSql, PgRateLimiter } from "../_shared/pg-store.ts";
import { HttpRevenueCatClient } from "../_shared/revenuecat.ts";
import { RevenueCatWebPurchaseLink } from "../_shared/web-billing.ts";
import { handleCreateWebCheckout } from "./handler.ts";

const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const jwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined;
const expected = authenticatedClaims(supabaseUrl || undefined);
const rc = new HttpRevenueCatClient(Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "");

// RevenueCat Web Billing checkout is a hosted "Web Purchase Link" the server fills in with the
// JWT-verified app_user_id (see _shared/web-billing.ts) — no secret key or RC API call is needed.
const billing = new RevenueCatWebPurchaseLink(
  Deno.env.get("REVENUECAT_WEB_BILLING_CHECKOUT_URL") ?? "",
);

// Rate limiting rides the same narrow writer credential as the entitlement stores — the role can
// only execute its granted RPCs, of which consume_rate_limit is one (0010).
const limiter = new PgRateLimiter(createWriterSql(Deno.env.get("ENTITLEMENT_WRITER_DB_URL") ?? ""));

Deno.serve((req) =>
  handleCreateWebCheckout(req, { jwtSecret, jwksUrl, expected, billing, rc, limiter }),
);
