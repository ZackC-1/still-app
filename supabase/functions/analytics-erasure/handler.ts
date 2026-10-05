import {
  deviceErasureState,
  ErasureStorageUnavailable,
  type ErasureStore,
  isLowerUuid,
  isOriginProof,
} from "../_shared/erasure-store.ts";
import type { PostHogErasurePort } from "../_shared/posthog-erasure.ts";
import { clientIp, type RateLimiter, tooManyRequests } from "../_shared/rate-limit.ts";
import { jsonResponse, optionsResponse } from "../_shared/store.ts";
import { constantTimeEqual } from "../_shared/token.ts";
import { runErasureWorker } from "./worker.ts";

// Device-slice erasure (U5-W2). Called by a device that has turned sharing off, with or without an
// account (D144: stopping never needs a signup), and by the deletion worker.
//
//   {"action":"device","originProof":<64 hex>,"anonymousIds":[<uuid>, ...]}  → 202 {state}
//   {"action":"status","originProof":<64 hex>}                                → 200 {state}
//   {"action":"work"} with the worker token in Authorization                  → 200 {claimed, ...}
//
// The device names itself only by its origin proof, a one-way hash of its private consent handle;
// the handle never reaches the server. The anonymous ids are the ids the device derived and sent
// under; the database refuses any that is an account id or another device's subject, so a request
// can delete only what that device sent. Any other key (an account id, an email, the handle) is
// refused, not ignored. Nothing a request carries is logged.
//
// config.toml: verify_jwt = false. No session token is needed or read on the device routes; the
// worker route is gated by a constant-time compare against its invocation token (fail closed).

export const MAX_BODY_BYTES = 16_384;
export const MAX_ANONYMOUS_IDS = 256;
/** Per client address, per 10 minutes. A device submits once and polls on later Still screens. */
export const ERASURE_IP_LIMIT = 30;
export const STATUS_IP_LIMIT = 120;
export const WORKER_BATCH = 10;
export const WORKER_LEASE_SECONDS = 300;

export interface AnalyticsErasureDeps {
  /** Null when this deployment has no eraser credential: every route answers 503. */
  readonly store: ErasureStore | null;
  readonly limiter: RateLimiter | null;
  readonly posthog: PostHogErasurePort;
  /** The worker invocation token. Blank refuses every worker call. */
  readonly workerToken: string;
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

async function limited(deps: AnalyticsErasureDeps, req: Request, max: number): Promise<Response | null> {
  const ip = clientIp(req);
  if (ip === null || !deps.limiter) return null;
  const wait = await deps.limiter.consume(`analytics-erasure:ip:${ip}`, max, 600);
  return wait > 0 ? tooManyRequests(wait) : null;
}

export async function handleAnalyticsErasure(req: Request, deps: AnalyticsErasureDeps): Promise<Response> {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
  const body = await readBody(req);
  if (!body) return invalid();
  try {
    switch (body.action) {
      case "device": {
        if (!hasExactly(body, ["action", "originProof", "anonymousIds"]) || !isOriginProof(body.originProof)) {
          return invalid();
        }
        const ids = body.anonymousIds;
        if (
          !Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ANONYMOUS_IDS || !ids.every(isLowerUuid) ||
          new Set(ids).size !== ids.length
        ) return invalid();
        if (!deps.store) return unavailable();
        const limit = await limited(deps, req, ERASURE_IP_LIMIT);
        if (limit) return limit;
        const ref = await deps.store.beginDeviceErasure(body.originProof, ids);
        if (ref === "refused") return invalid();
        return jsonResponse(202, { state: deviceErasureState(ref) });
      }
      case "status": {
        if (!hasExactly(body, ["action", "originProof"]) || !isOriginProof(body.originProof)) return invalid();
        if (!deps.store) return unavailable();
        const limit = await limited(deps, req, STATUS_IP_LIMIT);
        if (limit) return limit;
        return jsonResponse(200, { state: deviceErasureState(await deps.store.erasureStatus(body.originProof)) });
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
