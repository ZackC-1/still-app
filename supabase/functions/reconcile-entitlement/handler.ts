import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import { enforceRateLimit, type RateLimiter, type RateLimitPolicy } from "../_shared/rate-limit.ts";
import { type RevenueCatClient, stillProActive } from "../_shared/revenuecat.ts";
import { type EntitlementStore, jsonResponse } from "../_shared/store.ts";

// Reconcile (verify_jwt=true). The subject UUID is taken ONLY from the verified JWT (auth.uid()),
// NEVER the request body — so a user can reconcile only their own entitlement (KTD5 IDOR defense,
// enforced by the shared withAuthenticatedUser gate). Triggered on every sign-in/restore (all
// hosts) so a dropped webhook self-heals. Each accepted request triggers a RevenueCat subscriber
// lookup, so requests are rate-limited per user and per IP first.

/** Reconcile fires on every sign-in/restore across a user's devices; allow bursts, stop hammering. */
export const RECONCILE_RATE_LIMIT: RateLimitPolicy = { maxPerUser: 10, maxPerIp: 60, windowSeconds: 60 };

export interface ReconcileDeps extends AuthDeps {
  readonly store: EntitlementStore;
  readonly rc: RevenueCatClient;
  readonly limiter: RateLimiter;
}

export function handleReconcile(req: Request, deps: ReconcileDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    const limited = await enforceRateLimit(deps.limiter, "reconcile", userId, req, RECONCILE_RATE_LIMIT);
    if (limited) return limited;
    // The subject is the verified token's sub. Any user_id in the request body is ignored.
    const subscriber = await deps.rc.getSubscriber(userId);
    const active = stillProActive(subscriber);
    await deps.store.setEntitlement(userId, active, "reconcile", subscriber?.original_app_user_id ?? null);

    return jsonResponse(200, { still_sync: active });
  });
}
