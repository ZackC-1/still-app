import { assertEquals } from "@std/assert";
import { handleDeleteUser } from "../delete-user/handler.ts";
import { handleExport } from "../export-user-data/handler.ts";
import { signHs256 } from "../_shared/jwt.ts";
import type { UserStore } from "../_shared/user-store.ts";

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

function mockStore() {
  const deleted: string[] = [];
  const profiles: Record<string, unknown> = { [A]: { settings: { globalOn: true }, updated_at: "t" } };
  const entitlements: Record<string, unknown> = { [A]: { still_sync: true } };
  const store: UserStore = {
    deleteUser(userId) {
      deleted.push(userId);
      delete profiles[userId];
      delete entitlements[userId];
      return Promise.resolve();
    },
    getProfile: (userId) => Promise.resolve(profiles[userId] ?? null),
    getEntitlement: (userId) => Promise.resolve(entitlements[userId] ?? null),
  };
  return { store, deleted, profiles, entitlements };
}

function req(jwt: string | null, body: unknown = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://x", { method: "POST", headers, body: JSON.stringify(body) });
}

Deno.test("delete removes the caller's account (cascades profile + entitlement)", async () => {
  const { store, deleted, profiles, entitlements } = mockStore();
  const jwt = await signHs256({ sub: A }, SECRET);
  const res = await handleDeleteUser(req(jwt), { jwtSecret: SECRET, store });
  assertEquals(res.status, 200);
  assertEquals(deleted, [A]);
  assertEquals(profiles[A], undefined);
  assertEquals(entitlements[A], undefined);
});

Deno.test("delete is idempotent", async () => {
  const { store } = mockStore();
  const jwt = await signHs256({ sub: A }, SECRET);
  const deps = { jwtSecret: SECRET, store };
  assertEquals((await handleDeleteUser(req(jwt), deps)).status, 200);
  assertEquals((await handleDeleteUser(req(jwt), deps)).status, 200);
});

Deno.test("delete: subject from JWT, body user_id ignored", async () => {
  const { store, deleted } = mockStore();
  const jwt = await signHs256({ sub: A }, SECRET);
  await handleDeleteUser(req(jwt, { user_id: B }), { jwtSecret: SECRET, store });
  assertEquals(deleted, [A]); // not B
});

Deno.test("delete: unauthenticated → 401, nothing deleted", async () => {
  const { store, deleted } = mockStore();
  assertEquals((await handleDeleteUser(req(null), { jwtSecret: SECRET, store })).status, 401);
  assertEquals(deleted.length, 0);
});

Deno.test("export returns only the caller's data", async () => {
  const { store } = mockStore();
  const jwt = await signHs256({ sub: A }, SECRET);
  const res = await handleExport(req(jwt, { user_id: B }), { jwtSecret: SECRET, store });
  assertEquals(res.status, 200);
  const body = (await res.json()) as { user_id: string; entitlement: unknown };
  assertEquals(body.user_id, A);
  assertEquals(body.entitlement, { still_sync: true });
});

Deno.test("export: unauthenticated → 401", async () => {
  const { store } = mockStore();
  assertEquals((await handleExport(req(null), { jwtSecret: SECRET, store })).status, 401);
});
