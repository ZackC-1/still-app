import { assertEquals } from "@std/assert";
import { clientIp, enforceRateLimit, type RateLimiter } from "./rate-limit.ts";

const POLICY = { maxPerUser: 5, maxPerIp: 20, windowSeconds: 60 };
const USER = "11111111-1111-1111-1111-111111111111";

function trackingLimiter(waits: Record<string, number> = {}) {
  const calls: { key: string; max: number; window: number }[] = [];
  const limiter: RateLimiter = {
    consume(key, max, window) {
      calls.push({ key, max, window });
      return Promise.resolve(waits[key] ?? 0);
    },
  };
  return { limiter, calls };
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://x/fn", { method: "POST", headers });
}

Deno.test("under both limits → null; user and IP buckets consumed with the policy's numbers", async () => {
  const { limiter, calls } = trackingLimiter();
  const res = await enforceRateLimit(
    limiter,
    "checkout",
    USER,
    req({ "cf-connecting-ip": "203.0.113.9" }),
    POLICY,
  );
  assertEquals(res, null);
  assertEquals(calls, [
    { key: `checkout:user:${USER}`, max: 5, window: 60 },
    { key: "checkout:ip:203.0.113.9", max: 20, window: 60 },
  ]);
});

Deno.test("exhausted user bucket short-circuits: the IP bucket is never consumed", async () => {
  const { limiter, calls } = trackingLimiter({ [`checkout:user:${USER}`]: 30 });
  const res = await enforceRateLimit(
    limiter,
    "checkout",
    USER,
    req({ "cf-connecting-ip": "203.0.113.9" }),
    POLICY,
  );
  assertEquals(res?.status, 429);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.key, `checkout:user:${USER}`);
});

Deno.test("exhausted user bucket → 429 with Retry-After", async () => {
  const { limiter } = trackingLimiter({ [`checkout:user:${USER}`]: 42 });
  const res = await enforceRateLimit(limiter, "checkout", USER, req(), POLICY);
  assertEquals(res?.status, 429);
  assertEquals(res?.headers.get("retry-after"), "42");
  assertEquals(await res?.json(), { error: "rate_limited", retry_after: 42 });
});

Deno.test("exhausted IP bucket → 429 even for a fresh user", async () => {
  const { limiter } = trackingLimiter({ "reconcile:ip:203.0.113.9": 17 });
  const res = await enforceRateLimit(
    limiter,
    "reconcile",
    USER,
    req({ "cf-connecting-ip": "203.0.113.9" }),
    POLICY,
  );
  assertEquals(res?.status, 429);
  assertEquals(res?.headers.get("retry-after"), "17");
});

Deno.test("no client-IP header skips only the IP bucket; the user bucket always applies", async () => {
  const { limiter, calls } = trackingLimiter();
  const res = await enforceRateLimit(limiter, "checkout", USER, req(), POLICY);
  assertEquals(res, null);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.key, `checkout:user:${USER}`);
});

Deno.test("clientIp prefers cf-connecting-ip, then x-real-ip, then the LAST x-forwarded-for hop", () => {
  // cf-connecting-ip wins even when x-forwarded-for carries a spoofed first hop.
  assertEquals(
    clientIp(req({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1, 203.0.113.9" })),
    "203.0.113.9",
  );
  assertEquals(clientIp(req({ "x-real-ip": " 198.51.100.7 " })), "198.51.100.7");
  // The trustworthy XFF hop is the last (gateway-appended) one, not the client-controlled first.
  assertEquals(clientIp(req({ "x-forwarded-for": "1.1.1.1, 10.0.0.1 , 198.51.100.7" })), "198.51.100.7");
  assertEquals(clientIp(req()), null);
  assertEquals(clientIp(req({ "x-forwarded-for": "" })), null);
});
