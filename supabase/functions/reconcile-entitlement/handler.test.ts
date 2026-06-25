import { assertEquals } from "@std/assert";
import { handleReconcile } from "./handler.ts";
import { signEs256, signHs256 } from "../_shared/jwt.ts";
import type { EntitlementStore } from "../_shared/store.ts";
import type { RevenueCatClient, RcSubscriber } from "../_shared/revenuecat.ts";

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

const activeSub: RcSubscriber = { entitlements: { still_sync: { expires_date: null } } };

type Write = { userId: string; stillSync: boolean; source: string };

function mockStore() {
  const writes: Write[] = [];
  const store: EntitlementStore = {
    recordEvent: () => Promise.resolve(true),
    setEntitlement(userId, stillSync, source) {
      writes.push({ userId, stillSync, source });
      return Promise.resolve();
    },
  };
  return { store, writes };
}

function mockRc(subs: Record<string, RcSubscriber | null>): RevenueCatClient {
  return { getSubscriber: (id) => Promise.resolve(subs[id] ?? null) };
}

function req(jwt: string | null, body: unknown = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://x/reconcile", { method: "POST", headers, body: JSON.stringify(body) });
}

Deno.test("valid JWT + active subscriber → writes the JWT subject true", async () => {
  const { store, writes } = mockStore();
  const jwt = await signHs256({ sub: A }, SECRET);
  const res = await handleReconcile(req(jwt), { jwtSecret: SECRET, store, rc: mockRc({ [A]: activeSub }) });
  assertEquals(res.status, 200);
  assertEquals(writes, [{ userId: A, stillSync: true, source: "reconcile" }]);
});

Deno.test("subject is taken from the JWT, NOT the request body (IDOR defense)", async () => {
  const { store, writes } = mockStore();
  const jwt = await signHs256({ sub: A }, SECRET);
  // Body tries to target B; it must be ignored.
  await handleReconcile(req(jwt, { user_id: B }), {
    jwtSecret: SECRET,
    store,
    rc: mockRc({ [A]: activeSub, [B]: activeSub }),
  });
  assertEquals(writes[0]?.userId, A);
});

Deno.test("missing JWT → 401, no write", async () => {
  const { store, writes } = mockStore();
  const res = await handleReconcile(req(null), { jwtSecret: SECRET, store, rc: mockRc({}) });
  assertEquals(res.status, 401);
  assertEquals(writes.length, 0);
});

Deno.test("JWT signed with the wrong secret → 401, no write", async () => {
  const { store, writes } = mockStore();
  const jwt = await signHs256({ sub: A }, "a-totally-different-secret-value-here!!");
  const res = await handleReconcile(req(jwt), { jwtSecret: SECRET, store, rc: mockRc({ [A]: activeSub }) });
  assertEquals(res.status, 401);
  assertEquals(writes.length, 0);
});

Deno.test("webhook dropped → login reconcile establishes entitlement true", async () => {
  const { store, writes } = mockStore();
  const jwt = await signHs256({ sub: A }, SECRET);
  await handleReconcile(req(jwt), { jwtSecret: SECRET, store, rc: mockRc({ [A]: activeSub }) });
  assertEquals(writes[0]?.stillSync, true);
});

// Hosted Supabase issues ES256 tokens (no symmetric secret available to the function); the handler
// verifies them against the project JWKS. jwtSecret is "" here, exactly as on the hosted project.
Deno.test("hosted ES256 token verified via JWKS → writes the JWT subject", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwksUrl = "https://example.test/reconcile-jwks";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k" }] }), { status: 200 }),
    )) as typeof fetch;
  try {
    const { store, writes } = mockStore();
    const jwt = await signEs256({ sub: A }, pair.privateKey, "k");
    const res = await handleReconcile(req(jwt), {
      jwtSecret: "",
      jwksUrl,
      store,
      rc: mockRc({ [A]: activeSub }),
    });
    assertEquals(res.status, 200);
    assertEquals(writes, [{ userId: A, stillSync: true, source: "reconcile" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
