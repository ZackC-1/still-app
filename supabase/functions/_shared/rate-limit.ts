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

/**
 * The trustworthy client IP for a request that reached the Edge Function. Supabase fronts
 * functions with Cloudflare, which sets cf-connecting-ip to the real socket peer and strips any
 * client-supplied copy — so it (then x-real-ip) is safe to key on. x-forwarded-for is only a
 * last resort and we take its LAST hop: a direct caller can PREPEND spoofed hops, but the gateway
 * appends the true client IP at the end, so the first hop is attacker-controlled and the last is
 * not. Returns null when no address can be determined (then only the per-user bucket applies).
 */
export function clientIp(req: Request): string | null {
  const direct = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "").trim();
  if (direct.length > 0) return direct;
  const hops = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  return hops.length > 0 ? hops[hops.length - 1]! : null;
}

/** The one 429 shape: retry_after in the JSON body plus a browser-readable Retry-After header. */
export function tooManyRequests(waitSeconds: number): Response {
  return jsonResponse(
    429,
    { error: "rate_limited", retry_after: waitSeconds },
    { "retry-after": String(waitSeconds), "access-control-expose-headers": "retry-after" },
  );
}

/**
 * Enforce one surface's per-user then per-IP windows. Returns null when the request may proceed,
 * or the finished 429 (with Retry-After) when either bucket is exhausted. The user bucket is
 * checked first and short-circuits — an already-limited user never consumes an IP-window slot. A
 * request without a determinable client IP skips only the IP bucket.
 */
export async function enforceRateLimit(
  limiter: RateLimiter,
  surface: string,
  userId: string,
  req: Request,
  policy: RateLimitPolicy,
): Promise<Response | null> {
  const userWait = await limiter.consume(`${surface}:user:${userId}`, policy.maxPerUser, policy.windowSeconds);
  if (userWait > 0) return tooManyRequests(userWait);

  const ip = clientIp(req);
  if (ip !== null) {
    const ipWait = await limiter.consume(`${surface}:ip:${ip}`, policy.maxPerIp, policy.windowSeconds);
    if (ipWait > 0) return tooManyRequests(ipWait);
  }
  return null;
}
