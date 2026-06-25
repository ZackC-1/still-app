import { verifyJwt } from "../_shared/jwt.ts";
import { type RevenueCatClient, stillSyncActive } from "../_shared/revenuecat.ts";
import { type EntitlementStore, jsonResponse } from "../_shared/store.ts";
import { isUuid } from "../_shared/types.ts";

// Reconcile (verify_jwt=true). The subject UUID is taken ONLY from the verified JWT (auth.uid()),
// NEVER the request body — so a user can reconcile only their own entitlement (KTD5 IDOR defense).
// Triggered on every sign-in/restore (all hosts) so a dropped webhook self-heals.

export interface ReconcileDeps {
  /** HS256 symmetric secret (local Supabase). Empty on hosted, where tokens are ES256. */
  readonly jwtSecret: string;
  /** JWKS endpoint for ES256 verification on the hosted project. */
  readonly jwksUrl?: string;
  readonly store: EntitlementStore;
  readonly rc: RevenueCatClient;
}

export async function handleReconcile(req: Request, deps: ReconcileDeps): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const match = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!match) return jsonResponse(401, { error: "unauthorized" });

  const claims = await verifyJwt(match[1]!, { hs256Secret: deps.jwtSecret, jwksUrl: deps.jwksUrl });
  if (!claims || !isUuid(claims.sub)) return jsonResponse(401, { error: "unauthorized" });

  // The subject is the verified token's sub. Any user_id in the request body is ignored.
  const userId = claims.sub;
  const subscriber = await deps.rc.getSubscriber(userId);
  const active = stillSyncActive(subscriber);
  await deps.store.setEntitlement(userId, active, "reconcile", subscriber?.original_app_user_id ?? null);

  return jsonResponse(200, { still_sync: active });
}
