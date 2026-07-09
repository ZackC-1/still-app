import { withAuthenticatedUser } from "../_shared/auth.ts";
import { jsonResponse } from "../_shared/store.ts";
import type { AccountDeps } from "../delete-user/handler.ts";

// In-app data export (App Store 5.1.1 / GDPR). Returns ONLY the caller's data, keyed off the
// verified JWT subject (the shared withAuthenticatedUser gate). The Apple purchase record persists
// with Apple/RevenueCat (restore re-links).

export function handleExport(req: Request, deps: AccountDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    const [profile, entitlement] = await Promise.all([
      deps.store.getProfile(userId),
      deps.store.getEntitlement(userId),
    ]);
    return jsonResponse(200, { user_id: userId, profile, entitlement });
  });
}
