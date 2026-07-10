import { assertEquals } from "@std/assert";
import { handleCreateWebCheckout } from "./handler.ts";
import { signHs256 } from "../_shared/jwt.ts";
import { mintEs256, mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";
import type { RateLimiter } from "../_shared/rate-limit.ts";
import type { RevenueCatClient, RcSubscriber } from "../_shared/revenuecat.ts";
import type { WebBillingClient } from "../_shared/web-billing.ts";

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const EXPECTED = TEST_EXPECTED_CLAIMS;
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const activeSub: RcSubscriber = { entitlements: { still_sync: { expires_date: null } } };

const rcInactive: RevenueCatClient = { getSubscriber: () => Promise.resolve(null) };
const allowAll: RateLimiter = { consume: () => Promise.resolve(0) };

function mockBilling() {
  const calls: string[] = [];
  const billing: WebBillingClient = {
    createCheckout(appUserId) {
      calls.push(appUserId);
      return Promise.resolve({ checkout_url: `https://checkout.example/${appUserId}` });
    },
  };
  return { billing, calls };
}

function req(jwt: string | null, body: unknown = {}, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://x/create-web-checkout", {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

Deno.test("valid JWT creates checkout for the JWT subject", async () => {
  const { billing, calls } = mockBilling();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleCreateWebCheckout(req(jwt), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    billing,
    rc: rcInactive,
    limiter: allowAll,
  });
  assertEquals(res.status, 200);
  assertEquals(calls, [A]);
  assertEquals(await res.json(), { checkout_url: `https://checkout.example/${A}` });
});

Deno.test("body-supplied app_user_id is ignored", async () => {
  const { billing, calls } = mockBilling();
  const jwt = await mintHs256({ sub: A }, SECRET);
  await handleCreateWebCheckout(req(jwt, { app_user_id: B, user_id: B }), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    billing,
    rc: rcInactive,
    limiter: allowAll,
  });
  assertEquals(calls, [A]);
});

Deno.test("missing JWT returns 401 and does not create checkout", async () => {
  const { billing, calls } = mockBilling();
  const res = await handleCreateWebCheckout(req(null), { jwtSecret: SECRET, expected: EXPECTED, billing, rc: rcInactive, limiter: allowAll });
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("wrong issuer returns 401 and does not create checkout", async () => {
  const { billing, calls } = mockBilling();
  const jwt = await signHs256(
    { sub: A, iss: "https://evil.example/auth/v1", aud: "authenticated", role: "authenticated" },
    SECRET,
  );
  const res = await handleCreateWebCheckout(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, billing, rc: rcInactive, limiter: allowAll });
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("JWT signed with the wrong HMAC secret returns 401 and does not create checkout", async () => {
  const { billing, calls } = mockBilling();
  // Valid shape/claims, but signed with a secret the handler does not hold → signature must fail.
  const jwt = await mintHs256({ sub: A }, "a-different-secret-at-least-32-characters!!");
  const res = await handleCreateWebCheckout(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, billing, rc: rcInactive, limiter: allowAll });
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("non-UUID subject returns 401 and does not create checkout", async () => {
  const { billing, calls } = mockBilling();
  const jwt = await mintHs256({ sub: "not-a-uuid" }, SECRET);
  const res = await handleCreateWebCheckout(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, billing, rc: rcInactive, limiter: allowAll });
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("expired JWT returns 401 and does not create checkout", async () => {
  const { billing, calls } = mockBilling();
  const jwt = await signHs256(
    { sub: A, exp: 1, iss: EXPECTED.iss, aud: EXPECTED.aud, role: EXPECTED.role },
    SECRET,
  );
  const res = await handleCreateWebCheckout(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, billing, rc: rcInactive, limiter: allowAll });
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("GET returns 405 and does not create checkout", async () => {
  const { billing, calls } = mockBilling();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleCreateWebCheckout(req(jwt, {}, "GET"), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    billing,
    rc: rcInactive,
    limiter: allowAll,
  });
  assertEquals(res.status, 405);
  assertEquals(calls.length, 0);
});

Deno.test("hosted ES256 token verified via JWKS creates checkout", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwksUrl = "https://example.test/checkout-jwks";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k" }] }), { status: 200 }),
    )) as typeof fetch;
  try {
    const { billing, calls } = mockBilling();
    const jwt = await mintEs256({ sub: A }, pair.privateKey, "k");
    const res = await handleCreateWebCheckout(req(jwt), {
      jwtSecret: "",
      jwksUrl,
      expected: EXPECTED,
      billing,
      rc: rcInactive,
      limiter: allowAll,
    });
    assertEquals(res.status, 200);
    assertEquals(calls, [A]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("billing failure returns 502", async () => {
  const billing: WebBillingClient = {
    createCheckout: () => Promise.reject(new Error("not configured")),
  };
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleCreateWebCheckout(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, billing, rc: rcInactive, limiter: allowAll });
  assertEquals(res.status, 502);
  assertEquals((await res.json()).error, "checkout_unavailable");
});

Deno.test("already-entitled account returns 409 and does not create checkout", async () => {
  const { billing, calls } = mockBilling();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const rc: RevenueCatClient = { getSubscriber: () => Promise.resolve(activeSub) };
  const res = await handleCreateWebCheckout(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, billing, rc, limiter: allowAll });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "already_entitled" });
  assertEquals(calls.length, 0);
});

Deno.test("over the per-user limit → 429 with Retry-After, no RC or billing call", async () => {
  const { billing, calls } = mockBilling();
  let rcCalls = 0;
  const rc: RevenueCatClient = {
    getSubscriber() {
      rcCalls += 1;
      return Promise.resolve(null);
    },
  };
  const limiter: RateLimiter = {
    consume: (key) => Promise.resolve(key.startsWith("checkout:user:") ? 30 : 0),
  };
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleCreateWebCheckout(req(jwt), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    billing,
    rc,
    limiter,
  });
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "30");
  assertEquals((await res.json()).error, "rate_limited");
  assertEquals(calls.length, 0);
  assertEquals(rcCalls, 0);
});

Deno.test("over the per-IP limit → 429 keyed by the Cloudflare client IP", async () => {
  const { billing, calls } = mockBilling();
  const seen: string[] = [];
  const limiter: RateLimiter = {
    consume(key) {
      seen.push(key);
      return Promise.resolve(key === "checkout:ip:203.0.113.9" ? 12 : 0);
    },
  };
  const jwt = await mintHs256({ sub: A }, SECRET);
  const request = new Request("http://x/create-web-checkout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${jwt}`,
      // A spoofed first x-forwarded-for hop must be ignored in favour of cf-connecting-ip.
      "x-forwarded-for": "1.1.1.1, 203.0.113.9",
      "cf-connecting-ip": "203.0.113.9",
    },
    body: "{}",
  });
  const res = await handleCreateWebCheckout(request, {
    jwtSecret: SECRET,
    expected: EXPECTED,
    billing,
    rc: rcInactive,
    limiter,
  });
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "12");
  assertEquals(seen, [`checkout:user:${A}`, "checkout:ip:203.0.113.9"]);
  assertEquals(calls.length, 0);
});
