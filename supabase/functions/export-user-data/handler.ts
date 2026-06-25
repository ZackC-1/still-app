import { verifyJwt } from "../_shared/jwt.ts";
import { jsonResponse } from "../_shared/store.ts";
import { isUuid } from "../_shared/types.ts";
import type { AccountDeps } from "../delete-user/handler.ts";

// In-app data export (App Store 5.1.1 / GDPR). Returns ONLY the caller's data, keyed off the
// verified JWT subject. The Apple purchase record persists with Apple/RevenueCat (restore re-links).

export async function handleExport(req: Request, deps: AccountDeps): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
  const match = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!match) return jsonResponse(401, { error: "unauthorized" });
  const claims = await verifyJwt(match[1]!, { hs256Secret: deps.jwtSecret, jwksUrl: deps.jwksUrl });
  if (!claims || !isUuid(claims.sub)) return jsonResponse(401, { error: "unauthorized" });

  const [profile, entitlement] = await Promise.all([
    deps.store.getProfile(claims.sub),
    deps.store.getEntitlement(claims.sub),
  ]);
  return jsonResponse(200, { user_id: claims.sub, profile, entitlement });
}
