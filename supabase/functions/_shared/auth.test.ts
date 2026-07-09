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

Deno.test("gate: OPTIONS preflight → 204 without running the body", async () => {
  const { body, calls } = spyBody();
  const res = await withAuthenticatedUser(req("OPTIONS"), AUTH, body);
  assertEquals(res.status, 204);
  assertEquals(calls.length, 0);
});

Deno.test("gate: non-POST → 405 without running the body", async () => {
  const { body, calls } = spyBody();
  assertEquals((await withAuthenticatedUser(req("GET"), AUTH, body)).status, 405);
  assertEquals((await withAuthenticatedUser(req("DELETE"), AUTH, body)).status, 405);
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
