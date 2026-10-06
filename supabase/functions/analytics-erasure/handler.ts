import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import {
  type AccountErasurePort,
  deviceErasureState,
  ErasureStorageUnavailable,
  type ErasureStore,
  isAnonIndex,
  isErasureKey,
  stageErasureState,
} from "../_shared/erasure-store.ts";
import { deletionFailureReason, type PostHogPort } from "../_shared/posthog.ts";
import type { PostHogErasurePort } from "../_shared/posthog-erasure.ts";
import { clientIp, limiterAddress, type RateLimiter, tooManyRequests } from "../_shared/rate-limit.ts";
import { jsonResponse, optionsResponse } from "../_shared/store.ts";
import { constantTimeEqual } from "../_shared/token.ts";
import { runErasureWorker } from "./worker.ts";

// Device-slice erasure (U5-W2). Called by a device that has turned sharing off, with or without an
// account (D144: stopping never needs a signup), and by the deletion worker.
//
//   {"action":"device","erasureKey":<64 hex>,"anonIndex":<0..255>}  → 202 {state}
//   {"action":"status","erasureKey":<64 hex>}                       → 200 {state}
//   {"action":"work"} with the worker token in Authorization        → 200 {claimed, ...}
//
// Account-wide erasure (U5-W3 packet B, owner decisions 60 and 61), signed in only:
//
//   {"action":"account"} with the session in Authorization          → 202 {state}
//   {"action":"account-status"} with the session in Authorization   → 200 {state}
//
// The account is the verified session's subject, never the body (a signed-in session is enough:
// no fresh email code, D60). "account" retires every active per-device identity of the account and
// queues each for deletion in one transaction (migration 0018, reason account_erasure); the other
// devices learn "stopped" at their next identify. It deletes account data only (D61): no device's
// anonymous ids are named or derived here. The legacy 2.1 person keyed by the account id is deleted
// inline and best effort, as account deletion does. Idempotent: a repeat captures nothing new and
// answers the same state. Limited per account, in the submit and status buckets.
//
// The erasure key is HMAC(private consent handle, "still:analytics:erasure"); the handle never
// reaches the server. The request names no id: the database derives the device's anonymous ids
// (indexes 0 to anonIndex) from the key, and finds the device's issued subjects by
// SHA-256(SHA-256(key)). Knowing someone's anonymous id, account id or origin proof (which crosses
// the network at every sign-in) gives no power to delete or to read status here: both need the key.
// Any other key in the body (an account id, an email, a list of ids, the handle) is refused.
// Nothing a request carries is logged.
//
// config.toml: verify_jwt = false. No session token is needed or read on the device routes; the
// worker route is gated by a constant-time compare against its invocation token (fail closed).

export const MAX_BODY_BYTES = 1024;
/** Per client address, per 10 minutes, in separate buckets: polling never spends the submit budget. */
export const SUBMIT_IP_LIMIT = 30;
export const STATUS_IP_LIMIT = 120;
/** Per account, per 10 minutes. */
export const ACCOUNT_SUBMIT_LIMIT = 10;
export const ACCOUNT_STATUS_LIMIT = 60;
export const WORKER_BATCH = 50;
export const WORKER_LEASE_SECONDS = 300;

export interface AnalyticsErasureDeps {
  /** Null when this deployment has no eraser credential: every route answers 503. */
  readonly store: ErasureStore | null;
  readonly limiter: RateLimiter | null;
  readonly posthog: PostHogErasurePort;
  /** The worker invocation token. Blank refuses every worker call. */
  readonly workerToken: string;
  /** Session verification for the account routes. Absent: they answer 503. */
  readonly auth?: AuthDeps | null;
  /** The 0018 account routes (the same eraser login as `store`). Absent or null: 503. */
  readonly account?: AccountErasurePort | null;
  /** Deletes the legacy 2.1 person keyed by the account id (the account-deletion path). */
  readonly legacy?: PostHogPort | null;
}

const invalid = () => jsonResponse(400, { error: "invalid_request" });
const unavailable = () => jsonResponse(503, { error: "unavailable" });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const hasExactly = (body: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key));

/** Per-address limit for one route. A request whose address cannot be determined is refused: the
 * address is the only limiting key on these account-free routes. */
async function limited(
  deps: AnalyticsErasureDeps,
  req: Request,
  surface: "analytics-erasure-submit" | "analytics-erasure-status",
  max: number,
): Promise<Response | null> {
  const ip = clientIp(req);
  if (ip === null) return jsonResponse(400, { error: "invalid_request" });
  if (!deps.limiter) return unavailable();
  const wait = await deps.limiter.consume(`${surface}:ip:${limiterAddress(ip)}`, max, 600);
  return wait > 0 ? tooManyRequests(wait) : null;
}

/** The account routes, after the body was checked. The session is verified here; the shared gate's
 * own 500 is never reached because every failure below is caught and answered 503. */
function accountRoute(req: Request, deps: AnalyticsErasureDeps, action: "account" | "account-status") {
  const { auth, account, limiter } = deps;
  if (!auth || !account || !limiter) return Promise.resolve(unavailable());
  return withAuthenticatedUser(req, auth, async (userId) => {
    const user = userId.toLowerCase();
    try {
      const surface = action === "account" ? "analytics-erasure-submit" : "analytics-erasure-status";
      const max = action === "account" ? ACCOUNT_SUBMIT_LIMIT : ACCOUNT_STATUS_LIMIT;
      const wait = await limiter.consume(`${surface}:user:${user}`, max, 600);
      if (wait > 0) return tooManyRequests(wait);
      if (action === "account-status") {
        return jsonResponse(200, { state: stageErasureState(await account.accountErasureStatus(user)) });
      }
      const captured = await account.beginAccountErasure(user, "account_erasure");
      // The account must exist to be erased; "gone" is the deletion route's answer only.
      if (captured.state !== "captured") throw new ErasureStorageUnavailable();
      if (deps.legacy?.canDelete) {
        try {
          await deps.legacy.deletePerson(user);
        } catch (error) {
          // A fixed reason only, never the account id. The per-device identities are queued either
          // way; the legacy person is the same best-effort path as account deletion (#305).
          console.error("analytics-erasure legacy deletion failed:", deletionFailureReason(error));
        }
      }
      return jsonResponse(202, { state: stageErasureState(await account.accountErasureStatus(user)) });
    } catch (error) {
      console.error(
        "analytics-erasure failed:",
        error instanceof ErasureStorageUnavailable ? "storage" : error instanceof Error ? error.name : "unknown",
      );
      return unavailable();
    }
  });
}

export async function handleAnalyticsErasure(req: Request, deps: AnalyticsErasureDeps): Promise<Response> {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
  const body = await readBody(req);
  if (!body) return invalid();
  try {
    switch (body.action) {
      case "account":
      case "account-status": {
        if (!hasExactly(body, ["action"])) return invalid();
        return await accountRoute(req, deps, body.action);
      }
      case "device": {
        if (
          !hasExactly(body, ["action", "erasureKey", "anonIndex"]) || !isErasureKey(body.erasureKey) ||
          !isAnonIndex(body.anonIndex)
        ) return invalid();
        if (!deps.store) return unavailable();
        const limit = await limited(deps, req, "analytics-erasure-submit", SUBMIT_IP_LIMIT);
        if (limit) return limit;
        const ref = await deps.store.beginDeviceErasure(body.erasureKey, body.anonIndex);
        return jsonResponse(202, { state: deviceErasureState(ref) });
      }
      case "status": {
        if (!hasExactly(body, ["action", "erasureKey"]) || !isErasureKey(body.erasureKey)) return invalid();
        if (!deps.store) return unavailable();
        const limit = await limited(deps, req, "analytics-erasure-status", STATUS_IP_LIMIT);
        if (limit) return limit;
        return jsonResponse(200, { state: deviceErasureState(await deps.store.erasureStatus(body.erasureKey)) });
      }
      case "work": {
        const auth = req.headers.get("Authorization") ?? "";
        if (deps.workerToken.length === 0 || !constantTimeEqual(auth, deps.workerToken)) {
          return jsonResponse(401, { error: "unauthorized" });
        }
        if (!hasExactly(body, ["action"])) return invalid();
        if (!deps.store) return unavailable();
        const report = await runErasureWorker({
          store: deps.store,
          posthog: deps.posthog,
          limit: WORKER_BATCH,
          leaseSeconds: WORKER_LEASE_SECONDS,
        });
        return jsonResponse(200, report);
      }
      default:
        return invalid();
    }
  } catch (error) {
    // Fixed categories only: no proof, id or driver text reaches the log.
    console.error(
      "analytics-erasure failed:",
      error instanceof ErasureStorageUnavailable ? "storage" : error instanceof Error ? error.name : "unknown",
    );
    return unavailable();
  }
}
