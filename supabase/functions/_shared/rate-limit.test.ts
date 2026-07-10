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
    req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }),
    POLICY,
  );
  assertEquals(res, null);
  assertEquals(calls, [
    { key: `checkout:user:${USER}`, max: 5, window: 60 },
    { key: "checkout:ip:203.0.113.9", max: 20, window: 60 },
  ]);
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
    req({ "x-forwarded-for": "203.0.113.9" }),
    POLICY,
  );
  assertEquals(res?.status, 429);
  assertEquals(res?.headers.get("retry-after"), "17");
});

Deno.test("missing x-forwarded-for skips only the IP bucket; the user bucket always applies", async () => {
  const { limiter, calls } = trackingLimiter();
  const res = await enforceRateLimit(limiter, "checkout", USER, req(), POLICY);
  assertEquals(res, null);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.key, `checkout:user:${USER}`);
});

Deno.test("clientIp takes the first forwarded hop and trims it", () => {
  assertEquals(clientIp(req({ "x-forwarded-for": " 198.51.100.7 , 10.0.0.1" })), "198.51.100.7");
  assertEquals(clientIp(req()), null);
  assertEquals(clientIp(req({ "x-forwarded-for": "" })), null);
});
