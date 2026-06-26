import { assertEquals } from "@std/assert";
import { handleCreateWebCheckout } from "./handler.ts";
import { signHs256 } from "../_shared/jwt.ts";
import { mintEs256, mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";
import type { WebBillingClient } from "../_shared/web-billing.ts";

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const EXPECTED = TEST_EXPECTED_CLAIMS;
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

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

function req(jwt: string | null, body: unknown = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://x/create-web-checkout", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

Deno.test("valid JWT creates checkout for the JWT subject", async () => {
  const { billing, calls } = mockBilling();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleCreateWebCheckout(req(jwt), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    billing,
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
  });
  assertEquals(calls, [A]);
});

Deno.test("missing JWT returns 401 and does not create checkout", async () => {
  const { billing, calls } = mockBilling();
  const res = await handleCreateWebCheckout(req(null), { jwtSecret: SECRET, expected: EXPECTED, billing });
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("wrong issuer returns 401 and does not create checkout", async () => {
  const { billing, calls } = mockBilling();
  const jwt = await signHs256(
    { sub: A, iss: "https://evil.example/auth/v1", aud: "authenticated", role: "authenticated" },
    SECRET,
  );
  const res = await handleCreateWebCheckout(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, billing });
  assertEquals(res.status, 401);
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
  const res = await handleCreateWebCheckout(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, billing });
  assertEquals(res.status, 502);
  assertEquals((await res.json()).error, "checkout_unavailable");
});
