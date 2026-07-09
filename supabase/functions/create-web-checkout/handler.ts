import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import { type RevenueCatClient, stillProActive } from "../_shared/revenuecat.ts";
import { jsonResponse } from "../_shared/store.ts";
import type { WebBillingClient } from "../_shared/web-billing.ts";

// Authenticated Web Billing checkout creation. The caller may send arbitrary JSON, but the
// RevenueCat app_user_id is derived ONLY from the verified Supabase JWT subject (the shared
// withAuthenticatedUser gate).

export interface CreateWebCheckoutDeps extends AuthDeps {
  readonly billing: WebBillingClient;
  readonly rc: RevenueCatClient;
}

export function handleCreateWebCheckout(
  req: Request,
  deps: CreateWebCheckoutDeps,
): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    try {
      const subscriber = await deps.rc.getSubscriber(userId);
      if (stillProActive(subscriber)) return jsonResponse(409, { error: "already_entitled" });
      const checkout = await deps.billing.createCheckout(userId);
      return jsonResponse(200, checkout);
    } catch (error) {
      // Don't leak internal billing/config detail (e.g. "RevenueCat Web Billing is not configured") to
      // the authenticated caller — log it server-side, return only a generic status the client acts on.
      console.error("create-web-checkout failed:", error);
      return jsonResponse(502, { error: "checkout_unavailable" });
    }
  });
}
