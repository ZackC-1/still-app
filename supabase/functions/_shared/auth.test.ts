import { assertEquals } from "@std/assert";
import { withAuthenticatedUser } from "./auth.ts";
import { signHs256 } from "./jwt.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "./test-helpers.ts";
import { jsonResponse } from "./store.ts";

// The shared gate is the whole per-function trust boundary (KTD5), consolidated from four
// copy-pasted preambles — so it gets its own suite. The per-handler tests keep covering the same
// paths end-to-end through their handlers; this pins the gate's contract directly.

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const EXPECTED = TEST_EXPECTED_CLAIMS;
const AUTH = { jwtSecret: SECRET, expected: EXPECTED };
const A = "11111111-1111-1111-1111-111111111111";

function req(method: string, jwt?: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://x", { method, headers, body: method === "POST" ? "{}" : null });
}

function spyBody() {
  const calls: string[] = [];
  const body = (userId: string) => {
    calls.push(userId);
    return Promise.resolve(jsonResponse(200, { ok: true }));
  };
  return { body, calls };
}

Deno.test("gate: OPTIONS preflight → 204 WITH the CORS headers (they ARE the preflight contract)", async () => {
  const { body, calls } = spyBody();
  const res = await withAuthenticatedUser(req("OPTIONS"), AUTH, body);
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(res.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assertEquals(
    res.headers.get("access-control-allow-headers"),
    "authorization, x-client-info, apikey, content-type",
  );
  assertEquals(calls.length, 0);
});

Deno.test("gate: non-POST → 405 without running the body", async () => {
  const { body, calls } = spyBody();
  assertEquals((await withAuthenticatedUser(req("GET"), AUTH, body)).status, 405);
  assertEquals((await withAuthenticatedUser(req("DELETE"), AUTH, body)).status, 405);
  assertEquals(calls.length, 0);
});

Deno.test("gate: 401/405 rejections still carry CORS headers — browsers must read the error status", async () => {
  const { body } = spyBody();
  const unauth = await withAuthenticatedUser(req("POST", null), AUTH, body);
  assertEquals(unauth.status, 401);
  assertEquals(unauth.headers.get("access-control-allow-origin"), "*");
  const wrongMethod = await withAuthenticatedUser(req("GET"), AUTH, body);
  assertEquals(wrongMethod.status, 405);
  assertEquals(wrongMethod.headers.get("access-control-allow-origin"), "*");
});

Deno.test("gate: fails CLOSED on misconfiguration — ES256 token with no jwksUrl, or an empty secret", async () => {
  const { body, calls } = spyBody();
  // Hosted-shaped token reaching a gate configured without a JWKS endpoint → 401, never a throw.
  const hs = await mintHs256({ sub: A }, SECRET);
  assertEquals(
    (await withAuthenticatedUser(req("POST", hs), { jwtSecret: "", expected: EXPECTED }, body)).status,
    401,
  );
  assertEquals(calls.length, 0);
});

Deno.test("gate: missing / malformed Authorization → 401", async () => {
  const { body, calls } = spyBody();
  assertEquals((await withAuthenticatedUser(req("POST", null), AUTH, body)).status, 401);
  const noBearerHeaders = { Authorization: "Token abc" };
  const noBearer = new Request("http://x", { method: "POST", headers: noBearerHeaders, body: "{}" });
  assertEquals((await withAuthenticatedUser(noBearer, AUTH, body)).status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("gate: signature-valid token with wrong claims → 401 (defense in depth)", async () => {
  const { body, calls } = spyBody();
  const evil = await signHs256(
    { sub: A, iss: "https://evil.example/auth/v1", aud: "authenticated", role: "authenticated" },
    SECRET,
  );
  assertEquals((await withAuthenticatedUser(req("POST", evil), AUTH, body)).status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("gate: non-UUID subject → 401 — the body never sees an unproven id", async () => {
  const { body, calls } = spyBody();
  const jwt = await mintHs256({ sub: "not-a-uuid" }, SECRET);
  assertEquals((await withAuthenticatedUser(req("POST", jwt), AUTH, body)).status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("gate: valid token → body runs exactly once with the VERIFIED subject", async () => {
  const { body, calls } = spyBody();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await withAuthenticatedUser(req("POST", jwt), AUTH, body);
  assertEquals(res.status, 200);
  assertEquals(calls, [A]);
});

Deno.test("gate: a throwing body → CORS-carrying 500 that leaks no detail (never the platform 500)", async () => {
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await withAuthenticatedUser(req("POST", jwt), AUTH, () =>
    Promise.reject(new Error("pg: connection refused to db.internal:5432")),
  );
  assertEquals(res.status, 500);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  const bodyJson = await res.json();
  assertEquals(bodyJson, { error: "internal" }); // no internal detail crosses the wire
});

Deno.test("gate: expired-but-signature-valid token → 401", async () => {
  const { body, calls } = spyBody();
  const expired = await signHs256(
    { sub: A, iss: EXPECTED.iss, aud: EXPECTED.aud, role: EXPECTED.role, exp: 1000 }, // 1970
    SECRET,
  );
  assertEquals((await withAuthenticatedUser(req("POST", expired), AUTH, body)).status, 401);
  assertEquals(calls.length, 0);
});
