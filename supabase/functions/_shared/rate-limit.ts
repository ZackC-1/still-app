import { jsonResponse } from "./store.ts";

// Application-level rate limiting for the authenticated billing/reconcile functions. Every
// accepted request triggers RevenueCat-backed work, so a valid account (or one address minting
// accounts) could otherwise create unbounded cost and availability pressure. Limits are enforced
// per verified user AND per client IP over a fixed window; counters live behind the
// consume_rate_limit SECURITY DEFINER RPC (0010), reachable only by the narrow writer role.
// A limiter failure propagates (→ the shared auth gate's 500) rather than silently waving
// traffic through — fail closed.

export interface RateLimiter {
  /** Consume an ephemeral request key; the persistent adapter must derive a window-specific key
   * before storage (migration 0013). Never log this input. Returns 0 or seconds until reset. */
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

/**
 * The limiter key for a client address. An IPv6 client usually controls a whole /64, so every
 * address in it shares one key (`2001:db8:1:2::/64`); an IPv4-mapped address is its IPv4 address;
 * IPv4 and anything unparseable are used as given. Used by the account-free erasure routes and the
 * per-device identify path.
 */
export function limiterAddress(ip: string): string {
  const raw = ip.trim().replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  if (!raw.includes(":")) return raw;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1]!;
  const halves = raw.split("::");
  if (halves.length > 2) return raw;
  const split = (part: string | undefined) => (part ? part.split(":") : []);
  const expand = (groups: string[]) =>
    groups.flatMap((g) => {
      const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(g);
      if (!v4) return [g];
      const b = v4.slice(1).map(Number);
      return [((b[0]! << 8) | b[1]!).toString(16), ((b[2]! << 8) | b[3]!).toString(16)];
    });
  const head = expand(split(halves[0]));
  const tail = expand(split(halves[1]));
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return raw;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
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
  options: { readonly network?: boolean } = {},
): Promise<Response | null> {
  const userWait = await limiter.consume(`${surface}:user:${userId}`, policy.maxPerUser, policy.windowSeconds);
  if (userWait > 0) return tooManyRequests(userWait);

  const ip = clientIp(req);
  if (ip !== null) {
    const key = options.network ? limiterAddress(ip) : ip;
    const ipWait = await limiter.consume(`${surface}:ip:${key}`, policy.maxPerIp, policy.windowSeconds);
    if (ipWait > 0) return tooManyRequests(ipWait);
  }
  return null;
}
