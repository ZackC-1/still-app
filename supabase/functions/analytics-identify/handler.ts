import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import { type ErasureStore, isOriginProof } from "../_shared/erasure-store.ts";
import type { PostHogPort } from "../_shared/posthog.ts";
import type { PostHogSubjectPort } from "../_shared/posthog-erasure.ts";
import { enforceRateLimit, type RateLimiter, type RateLimitPolicy, tooManyRequests } from "../_shared/rate-limit.ts";
import { jsonResponse } from "../_shared/store.ts";
import { readBoundedBody } from "../_shared/request-body.ts";

// Attach the signed-in account's email to analytics, and count a new account exactly once.
// The app or extension calls this after it has identified the install (only while the person shares
// usage). The subject and every fact come from the server: the UUID from the verified JWT, the email
// and creation time from the auth record.
//
// Two request shapes:
//   * Released 2.1 clients send a body without `originProof` (usually `{}`). Nothing in it is read,
//     and the email goes on the account's person, exactly as before.
//   * A V3 client sends {"originProof": <64 hex>, "projectKeySha256": <64 hex>}. The origin proof is
//     SHA-256 of its erasure key, itself a one-way HMAC of its private consent handle; never the
//     handle or the key. projectKeySha256 is SHA-256 of the public PostHog project key the client
//     sends its own events to. Only a client whose key is this server's POSTHOG_PROJECT_KEY (the
//     project the email and account_created would land in) gets an identity: any other channel,
//     including a test build pointed at the PostHog test project or a body without the field, is
//     answered 200 {state: "test_channel"} with nothing read or written (no email, no
//     account_created, no subject); the client keeps waiting, as it does for "unavailable". This path is off
//     unless ANALYTICS_SUBJECTS_ENABLED is "true" (HARD GATE: not before the account-deletion
//     reorder and the subject snapshot are deployed and verified; see migration 0017). While off it
//     answers 503 and touches nothing. The server issues (or returns) this device's own PostHog identity
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
/** Retry-After once an account has reached its daily limit of new devices. */
export const SUBJECT_DAILY_RETRY_SECONDS = 3600;

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
  /** Narrow persistent limiter for released clients, independent of per-device identity setup. */
  readonly limiter?: RateLimiter | null;
  /** The explicit switch for the per-device path, independent of any credential. Default off. */
  readonly subjectsEnabled?: boolean;
  readonly subjects?: SubjectDeps | null;
  readonly now?: () => number;
  /** Override for ACCOUNTS_COUNTED_SINCE (tests). */
  readonly countedSince?: string;
  /** SHA-256 (hex) of POSTHOG_PROJECT_KEY. Absent or null: no client channel matches. */
  readonly projectKeySha256?: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A V3 subject request: the origin proof and the client's claimed PostHog project (or null). */
interface SubjectRequest {
  readonly proof: string;
  readonly projectKeySha256: string | null;
}

/** The subject request; null for a legacy body; "invalid" for anything else that names an origin
 * proof. */
async function originProofOf(req: Request): Promise<SubjectRequest | null | "invalid"> {
  let text: string;
  try { text = await readBoundedBody(req, { maxBytes: MAX_BODY_BYTES }); }
  catch { return "invalid"; }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "originProof")) return null;
  const v = body as Record<string, unknown>;
  const keys = Object.keys(v);
  const channel = Object.hasOwn(v, "projectKeySha256");
  if (
    keys.length !== (channel ? 2 : 1) || !isOriginProof(v.originProof) ||
    (channel && (typeof v.projectKeySha256 !== "string" || !SHA256_HEX.test(v.projectKeySha256)))
  ) return "invalid";
  return { proof: v.originProof, projectKeySha256: channel ? v.projectKeySha256 as string : null };
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
    const subject = await originProofOf(request);
    if (subject === "invalid") return jsonResponse(400, { error: "invalid_request" });
    if (subject !== null) return await identifySubject(deps, userId, subject, request);
    if (!deps.posthog.canIdentify) return jsonResponse(200, { identified: false });
    // The released body is client-selected: it cannot bypass the subject path's abuse budget.
    const limiter = deps.limiter ?? deps.subjects?.limiter;
    if (!limiter) return jsonResponse(503, { error: "unavailable" });
    const limited = await enforceRateLimit(limiter, "analytics-identify", userId, request, SUBJECT_RATE_LIMIT, {
      network: true,
    });
    if (limited) return limited;
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
  { proof, projectKeySha256 }: SubjectRequest,
  req: Request,
): Promise<Response> {
  const subjects = deps.subjects;
  // Switched off, or without the store or a project key, there is no identity to issue: the device
  // keeps waiting and nothing is read or written.
  if (deps.subjectsEnabled !== true || !subjects || !subjects.posthog.canIdentify) {
    return jsonResponse(503, { error: "unavailable" });
  }
  const limited = await enforceRateLimit(subjects.limiter, "analytics-identify", userId, req, SUBJECT_RATE_LIMIT, {
    network: true,
  });
  if (limited) return limited;
  // Server-enforced channel: only a client sending its events to this server's PostHog project gets
  // an identity. Nothing is read or written for any other (a test build, or no claim at all).
  if (
    !projectKeySha256 || !deps.projectKeySha256 || !SHA256_HEX.test(deps.projectKeySha256) ||
    projectKeySha256 !== deps.projectKeySha256
  ) return jsonResponse(200, { state: "test_channel" });
  const issue = await subjects.store.issueSubject(userId, proof);
  if (issue.state === "stopped") return jsonResponse(200, { state: "stopped" });
  // Five new devices per account per day (0017); the device simply tries again later.
  if (issue.state === "limited") return tooManyRequests(SUBJECT_DAILY_RETRY_SECONDS);
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
