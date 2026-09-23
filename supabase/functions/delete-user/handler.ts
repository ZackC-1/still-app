import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import type { PostHogPort } from "../_shared/posthog.ts";
import { jsonResponse } from "../_shared/store.ts";
import type { UserStore } from "../_shared/user-store.ts";

// In-app account deletion (App Store Guideline 5.1.1 / GDPR). The subject is the verified JWT's
// user — never the body (the shared withAuthenticatedUser gate). Deleting the auth user cascades
// to profile + entitlement (U11). The account's PostHog person and events are deleted too.

export interface AccountDeps extends AuthDeps {
  readonly store: UserStore;
  /** Optional so export-user-data (which shares these deps) needs no PostHog. */
  readonly posthog?: PostHogPort;
}

export function handleDeleteUser(req: Request, deps: AccountDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    await deps.store.deleteUser(userId); // idempotent
    // The account is gone whatever happens next, so a PostHog outage must not report the deletion
    // as failed (the person could not retry it: their session is already invalid). It is logged
    // loudly instead, for the manual follow-up the operations guide describes.
    let analyticsDeleted = deps.posthog?.canDelete ? true : null;
    if (deps.posthog?.canDelete) {
      try {
        await deps.posthog.deletePerson(userId);
      } catch (error) {
        analyticsDeleted = false;
        console.error(`ANALYTICS DELETION FAILED for account ${userId}; delete this person in PostHog`, error);
      }
    }
    return jsonResponse(200, { deleted: true, analyticsDeleted });
  });
}
