import { authenticatedClaims } from "../_shared/jwt.ts";
import { HttpRevenueCatClient } from "../_shared/revenuecat.ts";
import { HttpRevenueCatWebBillingClient } from "../_shared/web-billing.ts";
import { handleCreateWebCheckout } from "./handler.ts";

const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const jwksUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : undefined;
const expected = authenticatedClaims(supabaseUrl || undefined);
const rc = new HttpRevenueCatClient(Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "");

const billing = new HttpRevenueCatWebBillingClient(
  Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "",
  Deno.env.get("REVENUECAT_WEB_BILLING_CHECKOUT_URL") ?? "",
  Deno.env.get("REVENUECAT_WEB_PRODUCT_ID") ?? "still_sync_web",
);

Deno.serve((req) => handleCreateWebCheckout(req, { jwtSecret, jwksUrl, expected, billing, rc }));
