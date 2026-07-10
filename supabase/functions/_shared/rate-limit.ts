import { jsonResponse } from "./store.ts";

// Application-level rate limiting for the authenticated billing/reconcile functions. Every
// accepted request triggers RevenueCat-backed work, so a valid account (or one address minting
// accounts) could otherwise create unbounded cost and availability pressure. Limits are enforced
// per verified user AND per client IP over a fixed window; counters live behind the
// consume_rate_limit SECURITY DEFINER RPC (0010), reachable only by the narrow writer role.
// A limiter failure propagates (→ the shared auth gate's 500) rather than silently waving
// traffic through — fail closed.

export interface RateLimiter {
  /** Consume one request from a bucket. Returns 0 when allowed, else seconds until the window resets. */
  consume(bucketKey: string, maxRequests: number, windowSeconds: number): Promise<number>;
}

export interface RateLimitPolicy {
  readonly maxPerUser: number;
  readonly maxPerIp: number;
  readonly windowSeconds: number;
}

/** First client address in x-forwarded-for (set by the Supabase gateway), or null when absent. */
export function clientIp(req: Request): string | null {
  const first = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  return first.length > 0 ? first : null;
}

/**
 * Enforce one surface's per-user and per-IP windows. Returns null when the request may proceed,
 * or the finished 429 (with Retry-After) when either bucket is exhausted. A request without a
 * client IP skips only the IP bucket — the user bucket always applies.
 */
export async function enforceRateLimit(
  limiter: RateLimiter,
  surface: string,
  userId: string,
  req: Request,
  policy: RateLimitPolicy,
): Promise<Response | null> {
  let wait = await limiter.consume(`${surface}:user:${userId}`, policy.maxPerUser, policy.windowSeconds);
  const ip = clientIp(req);
  if (ip !== null) {
    wait = Math.max(wait, await limiter.consume(`${surface}:ip:${ip}`, policy.maxPerIp, policy.windowSeconds));
  }
  if (wait <= 0) return null;
  return jsonResponse(
    429,
    { error: "rate_limited", retry_after: wait },
    { "retry-after": String(wait), "access-control-expose-headers": "retry-after" },
  );
}
