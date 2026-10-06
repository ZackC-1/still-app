import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import type { AccountErasurePort } from "../_shared/erasure-store.ts";
import { deletionFailureReason, type PostHogPort } from "../_shared/posthog.ts";
import { jsonResponse } from "../_shared/store.ts";
import type { UserStore } from "../_shared/user-store.ts";

// In-app account deletion (App Store Guideline 5.1.1 / GDPR). The subject is the verified JWT's
// user — never the body (the shared withAuthenticatedUser gate). Deleting the auth user cascades
// to profile + entitlement (U11). The account's PostHog person and events are deleted too.
//
// Order (U5-W3): first record the deletion of the account's per-device analytics identities
// (migration 0018's pre-step), then delete the account, then delete the legacy account-UUID person.
// The pre-step is bounded and can never block the deletion: if it fails or runs out of time, 0017's
// snapshot trigger still records every identity inside GoTrue's own deletion transaction.

/** The pre-step's time budget: under the eraser role's 2 s statement and 1 s lock limits, and small
 * enough that the pre-step, the deletion and the legacy PostHog call fit the client's 8 s wait. */
export const CAPTURE_BUDGET_MS = 2_500;

/** The only log line the pre-step writes, with a fixed reason: never an id, email or raw error. */
export const CAPTURE_DEFERRED_LOG = "ANALYTICS CAPTURE DEFERRED";

export interface AccountDeps extends AuthDeps {
  readonly store: UserStore;
  /** Optional so export-user-data (which shares these deps) needs no PostHog. */
  readonly posthog?: PostHogPort;
  /** The analytics eraser's account pre-step (0018). Absent or null where the eraser login is not
   * configured: then no per-device identity can exist (issuing one needs the same login), and the
   * deletion runs exactly as before. */
  readonly erasure?: AccountErasurePort | null;
  /** The pre-step's budget in milliseconds; tests shorten it. */
  readonly captureBudgetMs?: number;
}

/**
 * Record the account's per-device analytics identities for deletion before the account goes.
 * Never throws and never waits past `budgetMs`: an analytics side path must not block an account
 * deletion. A failure or a timeout is logged as a fixed category only.
 */
export async function captureBeforeDelete(
  erasure: AccountErasurePort,
  userId: string,
  budgetMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = erasure.beginAccountErasure(userId, "account_deleted");
  // A late failure after the budget ran out must not surface as an unhandled rejection.
  attempt.catch(() => {});
  try {
    const outcome = await Promise.race([
      attempt.then(() => "captured" as const, () => "storage" as const),
      new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), budgetMs))),
    ]);
    if (outcome !== "captured") console.error(CAPTURE_DEFERRED_LOG, { reason: outcome });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function handleDeleteUser(req: Request, deps: AccountDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    if (deps.erasure) await captureBeforeDelete(deps.erasure, userId, deps.captureBudgetMs ?? CAPTURE_BUDGET_MS);
    await deps.store.deleteUser(userId); // idempotent
    // The account is gone whatever happens next, so a PostHog outage must not report the deletion
    // as failed (the person could not retry it: their session is already invalid). It is logged
    // loudly instead, for the follow-up the operations guide describes.
    let analyticsDeleted = deps.posthog?.canDelete ? true : null;
    if (deps.posthog?.canDelete) {
      try {
        await deps.posthog.deletePerson(userId);
      } catch (error) {
        analyticsDeleted = false;
        // A fixed reason code only: never the account id, email or the raw error, which can echo
        // request details. The operations guide finds the affected person without the log naming it.
        console.error("ANALYTICS DELETION FAILED", { reason: deletionFailureReason(error) });
      }
    }
    return jsonResponse(200, { deleted: true, analyticsDeleted });
  });
}
