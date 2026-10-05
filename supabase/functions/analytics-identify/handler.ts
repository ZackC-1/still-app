import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import { type ErasureStore, isOriginProof } from "../_shared/erasure-store.ts";
import type { PostHogPort } from "../_shared/posthog.ts";
import type { PostHogSubjectPort } from "../_shared/posthog-erasure.ts";
import { enforceRateLimit, type RateLimiter, type RateLimitPolicy } from "../_shared/rate-limit.ts";
import { jsonResponse } from "../_shared/store.ts";

// Attach the signed-in account's email to analytics, and count a new account exactly once.
// The app or extension calls this after it has identified the install (only while the person shares
// usage). The subject and every fact come from the server: the UUID from the verified JWT, the email
// and creation time from the auth record.
//
// Two request shapes:
//   * Released 2.1 clients send a body without `originProof` (usually `{}`). Nothing in it is read,
//     and the email goes on the account's person, exactly as before.
//   * A V3 client sends exactly {"originProof": <64 hex>}: a one-way hash of its private consent
//     handle, never the handle. The server issues (or returns) this device's own PostHog identity
//     (a random "subject", never the account UUID), puts the email on that subject, and answers
//     {state: "active", subject}. A device that has asked for erasure answers {state: "stopped"},
//     and a subject retired while the email was being attached also answers "stopped", so the
//     device turns sharing off; the erasure worker's sweeps delete any late write.
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
/** Per verified account and per client address, per 10 minutes, for the subject path only. */
export const SUBJECT_RATE_LIMIT: RateLimitPolicy = { maxPerUser: 30, maxPerIp: 120, windowSeconds: 600 };
const MAX_BODY_BYTES = 1024;

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

/** Per-device identities (migration 0017). Absent until the eraser credential is configured. */
export interface SubjectDeps {
  readonly store: ErasureStore;
  readonly limiter: RateLimiter;
  readonly posthog: PostHogSubjectPort;
}

export interface AnalyticsIdentifyDeps extends AuthDeps {
  readonly accounts: AccountLookup;
  readonly posthog: PostHogPort;
  readonly subjects?: SubjectDeps | null;
  readonly now?: () => number;
  /** Override for ACCOUNTS_COUNTED_SINCE (tests). */
  readonly countedSince?: string;
}

/** The subject request's origin proof; null for a legacy body; "invalid" for anything else that
 * names one. */
async function originProofOf(req: Request): Promise<string | null | "invalid"> {
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY_BYTES) return text.includes("originProof") ? "invalid" : null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "originProof")) return null;
  const v = body as Record<string, unknown>;
  return Object.keys(v).length === 1 && isOriginProof(v.originProof) ? v.originProof : "invalid";
}

async function accountCreatedNow(
  deps: AnalyticsIdentifyDeps,
  userId: string,
  account: AnalyticsAccount,
): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const created = account.createdAt ? Date.parse(account.createdAt) : Number.NaN;
  const accountCreated = !account.analyticsSeen && Number.isFinite(created) &&
    created <= now && created >= Date.parse(deps.countedSince ?? ACCOUNTS_COUNTED_SINCE);
  if (!account.analyticsSeen) await deps.accounts.markAnalyticsSeen(userId);
  return accountCreated;
}

export function handleAnalyticsIdentify(req: Request, deps: AnalyticsIdentifyDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId, request) => {
    const proof = await originProofOf(request);
    if (proof === "invalid") return jsonResponse(400, { error: "invalid_request" });
    if (proof !== null) return await identifySubject(deps, userId, proof, request);
    if (!deps.posthog.canIdentify) return jsonResponse(200, { identified: false });
    const account = await deps.accounts.account(userId);
    if (!account?.email) return jsonResponse(200, { identified: false });
    const accountCreated = await accountCreatedNow(deps, userId, account);
    // Two racing requests can both see "not yet marked"; the event they send is identical (same id,
    // same timestamp: the account's creation time), and PostHog keeps it once.
    await deps.posthog.setPersonEmail(userId, account.email, { accountCreated, createdAt: account.createdAt });
    return jsonResponse(200, { identified: true, accountCreated });
  });
}

async function identifySubject(
  deps: AnalyticsIdentifyDeps,
  userId: string,
  proof: string,
  req: Request,
): Promise<Response> {
  const subjects = deps.subjects;
  // Without the store or a project key there is no identity to issue: the device keeps waiting.
  if (!subjects || !subjects.posthog.canIdentify) return jsonResponse(503, { error: "unavailable" });
  const limited = await enforceRateLimit(subjects.limiter, "analytics-identify", userId, req, SUBJECT_RATE_LIMIT);
  if (limited) return limited;
  const issue = await subjects.store.issueSubject(userId, proof);
  if (issue.state === "stopped") return jsonResponse(200, { state: "stopped" });
  const account = await deps.accounts.account(userId);
  let accountCreated = false;
  if (account?.email) {
    accountCreated = await accountCreatedNow(deps, userId, account);
    await subjects.posthog.setSubjectEmail(issue.subject, account.email, {
      accountCreated,
      createdAt: account.createdAt,
      accountId: userId,
    });
  }
  // An erasure that retired this subject meanwhile wins: the device stops, and the worker's sweeps
  // delete what the email attach may have recreated.
  if (!(await subjects.store.subjectActive(issue.subject))) return jsonResponse(200, { state: "stopped" });
  return jsonResponse(200, { state: "active", subject: issue.subject, accountCreated });
}
