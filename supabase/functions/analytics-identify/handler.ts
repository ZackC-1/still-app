import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import type { PostHogPort } from "../_shared/posthog.ts";
import { jsonResponse } from "../_shared/store.ts";

// Attach the signed-in account's email to its PostHog person, and count a new account exactly once.
// The app or extension calls this after it has identified the install (only while the person shares
// usage). The subject and every fact come from the server: the UUID from the verified JWT, the email
// and creation time from the auth record. Nothing in the request body is read.
//
// "New account" is decided here, not by the client, so signing in again, or on another device, can
// never count as a second creation: the first call for an account marks it in the account's server-
// only app metadata, and a first call for an account created on or after ACCOUNTS_COUNTED_SINCE
// counts, however long after creation the person turned sharing on. Accounts from before analytics
// are marked without being counted. The marker is written before the event is sent, and the event's
// id and timestamp are fixed per account, so neither a retry nor two simultaneous requests can
// count an account twice.

/** Still 2.1's analytics launch: accounts created before this are not "new" to analytics. */
export const ACCOUNTS_COUNTED_SINCE = "2026-09-23T00:00:00Z";

export interface AnalyticsAccount {
  readonly email: string | null;
  readonly createdAt: string | null;
  /** Whether an earlier call already reported this account to analytics. */
  readonly analyticsSeen: boolean;
}

export interface AccountLookup {
  account(userId: string): Promise<AnalyticsAccount | null>;
  /** Record, server-side, that this account has been reported (app metadata). */
  markAnalyticsSeen(userId: string): Promise<void>;
}

export interface AnalyticsIdentifyDeps extends AuthDeps {
  readonly accounts: AccountLookup;
  readonly posthog: PostHogPort;
  readonly now?: () => number;
  /** Override for ACCOUNTS_COUNTED_SINCE (tests). */
  readonly countedSince?: string;
}

export function handleAnalyticsIdentify(req: Request, deps: AnalyticsIdentifyDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    if (!deps.posthog.canIdentify) return jsonResponse(200, { identified: false });
    const account = await deps.accounts.account(userId);
    if (!account?.email) return jsonResponse(200, { identified: false });
    const now = (deps.now ?? Date.now)();
    const created = account.createdAt ? Date.parse(account.createdAt) : Number.NaN;
    const accountCreated = !account.analyticsSeen && Number.isFinite(created) &&
      created <= now && created >= Date.parse(deps.countedSince ?? ACCOUNTS_COUNTED_SINCE);
    if (!account.analyticsSeen) await deps.accounts.markAnalyticsSeen(userId);
    // Two racing requests can both see "not yet marked"; the event they send is identical (same id,
    // same timestamp: the account's creation time), and PostHog keeps it once.
    await deps.posthog.setPersonEmail(userId, account.email, { accountCreated, createdAt: account.createdAt });
    return jsonResponse(200, { identified: true, accountCreated });
  });
}
