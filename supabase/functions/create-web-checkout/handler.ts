import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import { enforceRateLimit, type RateLimiter, type RateLimitPolicy } from "../_shared/rate-limit.ts";
import { type RevenueCatClient, stillProActive } from "../_shared/revenuecat.ts";
import { jsonResponse } from "../_shared/store.ts";
import type { WebBillingClient } from "../_shared/web-billing.ts";

// Authenticated Web Billing checkout creation. The caller may send arbitrary JSON, but the
// RevenueCat app_user_id is derived ONLY from the verified Supabase JWT subject (the shared
// withAuthenticatedUser gate). Every accepted request triggers RevenueCat-backed work (subscriber
// lookup + checkout), so requests are rate-limited per user and per IP before any of it runs.

/** Checkout creation happens at most a few times per purchase attempt — a tight window is generous. */
export const CHECKOUT_RATE_LIMIT: RateLimitPolicy = { maxPerUser: 5, maxPerIp: 20, windowSeconds: 60 };

export interface CreateWebCheckoutDeps extends AuthDeps {
  readonly billing: WebBillingClient;
  readonly rc: RevenueCatClient;
  readonly limiter: RateLimiter;
}

export function handleCreateWebCheckout(
  req: Request,
  deps: CreateWebCheckoutDeps,
): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    const limited = await enforceRateLimit(deps.limiter, "checkout", userId, req, CHECKOUT_RATE_LIMIT);
    if (limited) return limited;
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
