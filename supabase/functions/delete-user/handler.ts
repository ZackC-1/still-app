import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import { jsonResponse } from "../_shared/store.ts";
import type { UserStore } from "../_shared/user-store.ts";

// In-app account deletion (App Store Guideline 5.1.1 / GDPR). The subject is the verified JWT's
// user — never the body (the shared withAuthenticatedUser gate). Deleting the auth user cascades
// to profile + entitlement (U11).

export interface AccountDeps extends AuthDeps {
  readonly store: UserStore;
}

export function handleDeleteUser(req: Request, deps: AccountDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    await deps.store.deleteUser(userId); // idempotent
    return jsonResponse(200, { deleted: true });
  });
}
