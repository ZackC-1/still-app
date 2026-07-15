import {
  clientIp,
  enforceRateLimit,
  type RateLimiter,
  type RateLimitPolicy,
  tooManyRequests,
} from "../_shared/rate-limit.ts";
import { jsonResponse, optionsResponse } from "../_shared/store.ts";
import { constantTimeEqual } from "../_shared/token.ts";

// Deterministic App Review sign-in (plan 2026-07-15-002, U3). Apple reviewers cannot receive OTP
// email, so ONE designated review address may sign in with a fixed verification code disclosed in
// the App Review notes. The gate is in-function (config.toml: verify_jwt=false): an exact
// normalized-email allowlist, a constant-time code compare, and fail-closed rate limiting. Unset
// secrets refuse everything, and a non-review email gets the IDENTICAL refusal (no existence or
// configuration oracle). No email is ever sent from here — "request" is a pure preflight.
//
// Response statuses are a stable client-routing contract (U4): 404 = not configured / email
// mismatch (the client falls back to normal OTP), 401 = wrong fixed code, 429 = rate-limited with
// a genuine Retry-After.

export interface ReviewSigninConfig {
  /** REVIEW_SIGNIN_EMAIL secret; empty/unset disables the whole mechanism (fail closed). */
  readonly reviewEmail: string;
  /** REVIEW_SIGNIN_CODE secret; empty/unset disables the whole mechanism (fail closed). */
  readonly reviewCode: string;
}

export interface ReviewUser {
  readonly id: string;
  readonly emailConfirmed: boolean;
}

/** The exact wire shape of a successful verify — what the client hands to setSession (U4). */
export interface ReviewSession {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly user_id: string;
}

/** The narrow GoTrue-admin slice the session mint needs; injected so tests fake it. */
export interface ReviewAdmin {
  /** Exact-match lookup by normalized email; null when no such user exists. */
  findUserByEmail(email: string): Promise<ReviewUser | null>;
  /** admin.createUser({email_confirm:true}); null signals "already registered" (concurrent create). */
  createConfirmedUser(email: string): Promise<ReviewUser | null>;
  /** admin.updateUserById({email_confirm:true}) — heals an unconfirmed drift-window artifact. */
  confirmEmail(userId: string): Promise<void>;
  /** admin.generateLink({type:"magiclink", email}) → the hashed one-time token. */
  generateMagicLinkTokenHash(email: string): Promise<string>;
  /** Server-side verifyOtp({token_hash, type:"email"}) → the minted session. */
  verifyMagicLinkTokenHash(tokenHash: string): Promise<ReviewSession>;
}

export interface ReviewSigninDeps {
  readonly config: ReviewSigninConfig;
  readonly limiter: RateLimiter;
  readonly admin: ReviewAdmin;
}

// Policy pinned by plan U3 (the gate protects a fixed 6-digit code, not an authenticated user's
// cost): the per-email bucket is the tight gate while per-IP stays generous because Apple review
// traffic can egress shared 17.0.0.0/8 NAT addresses and must not 429 the real reviewer. The email
// plays the "user" role in the shared limiter's bucket keys. maxPerUser is 10, not 5, for
// hand-transcription headroom: an Apple reviewer typing a 6-digit code from the notes must not
// lock themselves out on a few fat-fingers (that would reproduce the 2.1(a) rejection). At 10/10min
// against a 10^6 keyspace with a per-submission-rotating code, brute force is still ~decades away.
export const VERIFY_RATE_LIMIT: RateLimitPolicy = { maxPerUser: 10, maxPerIp: 30, windowSeconds: 600 };
/** The request preflight has no side effects; only the per-email window applies (plan U3). */
export const REQUEST_RATE_LIMIT = { maxRequests: 5, windowSeconds: 600 } as const;
/** Conservative Retry-After when the limiter RPC itself fails (fail closed — never wave through). */
export const LIMITER_FAILURE_RETRY_SECONDS = 60;

interface ReviewSigninBody {
  readonly action: "request" | "verify";
  readonly email: string;
  readonly code: string;
}

export async function handleReviewSignin(req: Request, deps: ReviewSigninDeps): Promise<Response> {
  // Browser contexts (including the Apple WKWebView's file:// origin) preflight every call, so
  // OPTIONS must answer 204+CORS before any other branch — deliberately NOT token.ts's
  // 405-everything idiom, which is for server-to-server callers only.
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse(400, { error: "bad_request" });
  }
  const body = parseBody(raw);
  if (!body) return jsonResponse(400, { error: "bad_request" });

  const email = normalizeEmail(body.email);
  const reviewEmail = normalizeEmail(deps.config.reviewEmail);
  const configured = reviewEmail.length > 0 && deps.config.reviewCode.length > 0;
  if (!configured || email !== reviewEmail) {
    // ONE indistinguishable refusal for "not configured" and "not the review address" — and it
    // fires before any limiter call, so consumption differences can't become a config oracle.
    if (body.action === "verify") logVerifyAttempt(req, "refused");
    return jsonResponse(404, { error: "not_found" });
  }

  const limited = await enforceReviewLimits(deps.limiter, body.action, email, req);
  if (limited) {
    if (body.action === "verify") logVerifyAttempt(req, "rate_limited");
    return limited;
  }

  if (body.action === "request") {
    // Preflight only: the reviewer already has the code from the App Review notes. No email —
    // this function has no sender and must never gain one.
    return jsonResponse(200, { ok: true });
  }

  if (!constantTimeEqual(body.code, deps.config.reviewCode)) {
    logVerifyAttempt(req, "invalid_code");
    return jsonResponse(401, { error: "invalid_code" });
  }

  try {
    const session = await mintSession(deps.admin, email);
    logVerifyAttempt(req, "verified");
    return jsonResponse(200, session);
  } catch (error) {
    // Never leak GoTrue/internal detail to the caller; the server log carries it.
    console.error("review-signin session mint failed:", error);
    logVerifyAttempt(req, "mint_failed");
    return jsonResponse(500, { error: "internal" });
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseBody(raw: unknown): ReviewSigninBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { action, email, code } = raw as Record<string, unknown>;
  if (action !== "request" && action !== "verify") return null;
  if (typeof email !== "string") return null;
  if (code !== undefined && typeof code !== "string") return null;
  // A missing code compares (constant-time) as empty → the wrong-code 401, not a parse error.
  return { action, email, code: code ?? "" };
}

async function enforceReviewLimits(
  limiter: RateLimiter,
  action: "request" | "verify",
  email: string,
  req: Request,
): Promise<Response | null> {
  try {
    if (action === "verify") {
      return await enforceRateLimit(limiter, "review-signin:verify", email, req, VERIFY_RATE_LIMIT);
    }
    const wait = await limiter.consume(
      `review-signin:request:user:${email}`,
      REQUEST_RATE_LIMIT.maxRequests,
      REQUEST_RATE_LIMIT.windowSeconds,
    );
    return wait > 0 ? tooManyRequests(wait) : null;
  } catch (error) {
    // There is no auth gate above this handler to convert a throw into a 500, and open traffic on
    // a limiter outage would leave the fixed code unmetered — fail closed as a 429.
    console.error("review-signin rate limiter failed (failing closed):", error);
    return tooManyRequests(LIMITER_FAILURE_RETRY_SECONDS);
  }
}

/**
 * The supported-API session mint (KTD: no GoTrue hack): ensure the privilege-less review user
 * exists and is email-confirmed, then generateLink(magiclink) + server-side verifyOtp of the
 * hashed token — a normal session indistinguishable from an OTP-minted one (R8, R12).
 */
async function mintSession(admin: ReviewAdmin, email: string): Promise<ReviewSession> {
  let user = await admin.findUserByEmail(email);
  if (user === null) {
    user = await admin.createConfirmedUser(email);
    if (user === null) {
      // "already registered": a concurrent first sign-in won the create race — adopt its row.
      user = await admin.findUserByEmail(email);
    }
    if (user === null) throw new Error("review user absent after already-registered create");
  }
  if (!user.emailConfirmed) {
    // A drift-window fallback send that was never verified leaves the row unconfirmed; heal it
    // before minting so the session comes from a normal, confirmed user.
    await admin.confirmEmail(user.id);
  }
  const tokenHash = await admin.generateMagicLinkTokenHash(email);
  return await admin.verifyMagicLinkTokenHash(tokenHash);
}

/** Audit trail (R12): timestamp, IP, outcome — never the code, never the submitted email. */
function logVerifyAttempt(req: Request, outcome: string): void {
  console.info(
    `review-signin verify at=${new Date().toISOString()} ip=${clientIp(req) ?? "unknown"} outcome=${outcome}`,
  );
}
