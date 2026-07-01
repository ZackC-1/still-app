import { type ExpectedClaims, verifyJwt } from "../_shared/jwt.ts";
import { type RevenueCatClient, stillProActive } from "../_shared/revenuecat.ts";
import { jsonResponse } from "../_shared/store.ts";
import { isUuid } from "../_shared/types.ts";
import type { WebBillingClient } from "../_shared/web-billing.ts";

// Authenticated Web Billing checkout creation. The caller may send arbitrary JSON, but the
// RevenueCat app_user_id is derived ONLY from the verified Supabase JWT subject.

export interface CreateWebCheckoutDeps {
  /** HS256 symmetric secret (local Supabase). Empty on hosted, where tokens are ES256. */
  readonly jwtSecret: string;
  /** JWKS endpoint for ES256 verification on the hosted project. */
  readonly jwksUrl?: string;
  /** Expected iss/aud/role for the authenticated user token (defense in depth). */
  readonly expected?: ExpectedClaims;
  readonly billing: WebBillingClient;
  readonly rc: RevenueCatClient;
}

export async function handleCreateWebCheckout(
  req: Request,
  deps: CreateWebCheckoutDeps,
): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const match = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!match) return jsonResponse(401, { error: "unauthorized" });

  const claims = await verifyJwt(match[1]!, {
    hs256Secret: deps.jwtSecret,
    jwksUrl: deps.jwksUrl,
    expected: deps.expected,
  });
  if (!claims || !isUuid(claims.sub)) return jsonResponse(401, { error: "unauthorized" });

  try {
    const subscriber = await deps.rc.getSubscriber(claims.sub);
    if (stillProActive(subscriber)) return jsonResponse(409, { error: "already_entitled" });
    const checkout = await deps.billing.createCheckout(claims.sub);
    return jsonResponse(200, checkout);
  } catch (error) {
    // Don't leak internal billing/config detail (e.g. "RevenueCat Web Billing is not configured") to
    // the authenticated caller — log it server-side, return only a generic status the client acts on.
    console.error("create-web-checkout failed:", error);
    return jsonResponse(502, { error: "checkout_unavailable" });
  }
}
