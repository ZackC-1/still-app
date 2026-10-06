import { assert, assertEquals, assertThrows } from "@std/assert";
import { type AccountDeps, CAPTURE_DEFERRED_LOG, eraserFromUrl, handleDeleteUser } from "../delete-user/handler.ts";
import { handleExport } from "../export-user-data/handler.ts";
import {
  type AccountErasurePort,
  type AccountErasureReason,
  type AccountErasureResult,
  ErasureStorageUnavailable,
  PgErasureStore,
} from "../_shared/erasure-store.ts";
import { createWriterSql } from "../_shared/pg-store.ts";
import { signHs256 } from "../_shared/jwt.ts";
import { SupabaseUserStore } from "../_shared/supabase-store.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";
import type { UserStore } from "../_shared/user-store.ts";

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const EXPECTED = TEST_EXPECTED_CLAIMS;
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
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleDeleteUser(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, store });
  assertEquals(res.status, 200);
  assertEquals(deleted, [A]);
  assertEquals(profiles[A], undefined);
  assertEquals(entitlements[A], undefined);
});

Deno.test("delete is idempotent", async () => {
  const { store } = mockStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const deps = { jwtSecret: SECRET, expected: EXPECTED, store };
  assertEquals((await handleDeleteUser(req(jwt), deps)).status, 200);
  assertEquals((await handleDeleteUser(req(jwt), deps)).status, 200);
});

Deno.test("delete: subject from JWT, body user_id ignored", async () => {
  const { store, deleted } = mockStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  await handleDeleteUser(req(jwt, { user_id: B }), { jwtSecret: SECRET, expected: EXPECTED, store });
  assertEquals(deleted, [A]); // not B
});

Deno.test("delete: unauthenticated → 401, nothing deleted", async () => {
  const { store, deleted } = mockStore();
  const deps = { jwtSecret: SECRET, expected: EXPECTED, store };
  assertEquals((await handleDeleteUser(req(null), deps)).status, 401);
  assertEquals(deleted.length, 0);
});

Deno.test("delete: wrong-issuer token → 401, nothing deleted", async () => {
  const { store, deleted } = mockStore();
  // Signature-valid, but from the wrong issuer — must be rejected (defense in depth).
  const jwt = await signHs256(
    { sub: A, iss: "https://evil.example/auth/v1", aud: "authenticated", role: "authenticated" },
    SECRET,
  );
  const res = await handleDeleteUser(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, store });
  assertEquals(res.status, 401);
  assertEquals(deleted.length, 0);
});

Deno.test("delete: role=anon token → 401, nothing deleted", async () => {
  const { store, deleted } = mockStore();
  const jwt = await mintHs256({ sub: A, role: "anon" }, SECRET);
  const res = await handleDeleteUser(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, store });
  assertEquals(res.status, 401);
  assertEquals(deleted.length, 0);
});

Deno.test("export returns only the caller's data", async () => {
  const { store } = mockStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleExport(req(jwt, { user_id: B }), { jwtSecret: SECRET, expected: EXPECTED, store });
  assertEquals(res.status, 200);
  const body = (await res.json()) as { user_id: string; entitlement: unknown };
  assertEquals(body.user_id, A);
  assertEquals(body.entitlement, { still_sync: true });
});

Deno.test("export: unauthenticated → 401", async () => {
  const { store } = mockStore();
  assertEquals((await handleExport(req(null), { jwtSecret: SECRET, expected: EXPECTED, store })).status, 401);
});

Deno.test("export: wrong-audience token → 401", async () => {
  const { store } = mockStore();
  const jwt = await mintHs256({ sub: A, aud: "anon" }, SECRET);
  assertEquals(
    (await handleExport(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, store })).status,
    401,
  );
});

// ── Account deletion records the per-device analytics identities first (U5-W3, migration 0018) ──
// D1-D7. Fake stores only, no network. The SQL route itself is proven by
// supabase/tests/analytics_account_erasure_migration_test.ts.

/** One call log shared by the fake erasure store and the fake user store, so order is visible. */
function accountWorld(over: {
  capture?: (userId: string) => Promise<AccountErasureResult>;
  deleteUser?: (userId: string) => Promise<void>;
} = {}) {
  const log: string[] = [];
  const active = new Set<string>([A]); // the account's active per-device identities, as a count stand-in
  const erasure: AccountErasurePort = {
    beginAccountErasure(userId: string, reason: AccountErasureReason) {
      log.push(`beginAccountErasure:${userId}:${reason}`);
      if (over.capture) return over.capture(userId);
      const subjects = active.delete(userId) ? 2 : 0;
      return Promise.resolve({ state: "captured", subjects });
    },
    accountErasureStatus: () => Promise.resolve(null),
  };
  const store: UserStore = {
    deleteUser(userId) {
      log.push(`deleteUser:${userId}`);
      return over.deleteUser ? over.deleteUser(userId) : Promise.resolve();
    },
    getProfile: () => Promise.resolve(null),
    getEntitlement: () => Promise.resolve(null),
  };
  return { log, erasure, store };
}

/** Capture every console channel while `run` executes (the handler must log fixed categories only). */
async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; logs: unknown[][] }> {
  const logs: unknown[][] = [];
  const channels = ["error", "warn", "log", "info", "debug"] as const;
  const originals = channels.map((name) => console[name]);
  for (const name of channels) console[name] = (...args: unknown[]) => void logs.push(args);
  try {
    return { result: await run(), logs };
  } finally {
    channels.forEach((name, i) => (console[name] = originals[i]!));
  }
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_PATTERN = /[^\s"@]+@[^\s"@]+\.[^\s"@]+/;
/** Throws when a log line could identify the person. */
function assertNoIdentifiers(logs: unknown[][]): void {
  const text = JSON.stringify(logs);
  assert(!UUID_PATTERN.test(text), "no UUID in the logs");
  assert(!EMAIL_PATTERN.test(text), "no email in the logs");
}

/** D1's assertion: the capture strictly before the deletion, for the JWT's subject only. */
function assertCaptureFirst(log: string[], userId: string): void {
  assertEquals(log, [`beginAccountErasure:${userId}:account_deleted`, `deleteUser:${userId}`]);
}

/** D6's assertion: exactly the two fields old clients read. */
function assertDeleteShape(body: unknown): void {
  assert(body !== null && typeof body === "object" && !Array.isArray(body));
  assertEquals(Object.keys(body).sort(), ["analyticsDeleted", "deleted"]);
}

const deleteDeps = (world: ReturnType<typeof accountWorld>, over: Partial<AccountDeps> = {}): AccountDeps => ({
  jwtSecret: SECRET,
  expected: EXPECTED,
  store: world.store,
  erasure: world.erasure,
  ...over,
});

Deno.test("D1: the identities are recorded before the account is deleted, for the JWT's subject only", async () => {
  const world = accountWorld();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleDeleteUser(req(jwt, { user_id: B }), deleteDeps(world));
  assertEquals(res.status, 200);
  assertCaptureFirst(world.log, A);
  // NEGATIVE CONTROL: a handler that deletes first fails the same assertion.
  const reordered = accountWorld();
  await reordered.store.deleteUser(A);
  await reordered.erasure.beginAccountErasure(A, "account_deleted");
  assertThrows(() => assertCaptureFirst(reordered.log, A));
});

Deno.test("D2: a failing pre-step never blocks the deletion and logs a fixed category only", async () => {
  const world = accountWorld({ capture: () => Promise.reject(new ErasureStorageUnavailable()) });
  const jwt = await mintHs256({ sub: A }, SECRET);
  const { result: res, logs } = await captureLogs(() => handleDeleteUser(req(jwt), deleteDeps(world)));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true, analyticsDeleted: null });
  assertCaptureFirst(world.log, A);
  assertEquals(logs, [[CAPTURE_DEFERRED_LOG, { reason: "storage" }]]);
  assertNoIdentifiers(logs);
  // NEGATIVE CONTROL: a log line naming the account is detected by the same scan.
  assertThrows(() => assertNoIdentifiers([[CAPTURE_DEFERRED_LOG, { reason: "storage", account: A }]]));
  assertThrows(() => assertNoIdentifiers([["capture failed for person@example.com"]]));
  // Any other thrown value is the same fixed category, never its message.
  const odd = accountWorld({ capture: () => Promise.reject(new Error(`driver said ${A}`)) });
  const second = await captureLogs(() => handleDeleteUser(req(jwt), deleteDeps(odd)));
  assertEquals(second.result.status, 200);
  assertEquals(second.logs, [[CAPTURE_DEFERRED_LOG, { reason: "storage" }]]);
});

Deno.test("D3: a pre-step that never answers is abandoned at the budget; the deletion still runs", async () => {
  const never = () => new Promise<AccountErasureResult>(() => {});
  const world = accountWorld({ capture: never });
  const jwt = await mintHs256({ sub: A }, SECRET);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const outer = (ms: number) =>
    new Promise<"outer-timeout">((r) => void timers.push(setTimeout(() => r("outer-timeout"), ms)));
  try {
    const { result, logs } = await captureLogs(() =>
      Promise.race([handleDeleteUser(req(jwt), deleteDeps(world, { captureBudgetMs: 20 })), outer(1_000)])
    );
    assert(result instanceof Response, "the handler answered within the outer limit");
    assertEquals(result.status, 200);
    assertCaptureFirst(world.log, A);
    assertEquals(logs, [[CAPTURE_DEFERRED_LOG, { reason: "timeout" }]]);
    // NEGATIVE CONTROL: without the budget the same pre-step never settles within the outer limit.
    assertEquals(
      await Promise.race([world.erasure.beginAccountErasure(A, "account_deleted"), outer(100)]),
      "outer-timeout",
    );
  } finally {
    timers.forEach(clearTimeout);
  }
});

Deno.test("D4: without the eraser login, deletion is exactly as before", async () => {
  for (const erasure of [null, undefined]) {
    const { store, deleted } = mockStore();
    const jwt = await mintHs256({ sub: A }, SECRET);
    const { result: res, logs } = await captureLogs(() =>
      handleDeleteUser(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, store, erasure })
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { deleted: true, analyticsDeleted: null });
    assertEquals(deleted, [A]);
    assertEquals(logs, []);
  }
});

Deno.test("D5: a GoTrue failure after the pre-step keeps the session; a retry captures nothing new and deletes", async () => {
  let goTrueDown = true;
  const world = accountWorld({
    deleteUser: () => (goTrueDown ? Promise.reject(Object.assign(new Error("down"), { status: 503 })) : Promise.resolve()),
  });
  const captured: AccountErasureResult[] = [];
  const recording: AccountErasurePort = {
    ...world.erasure,
    beginAccountErasure: async (userId, reason) => {
      const result = await world.erasure.beginAccountErasure(userId, reason);
      captured.push(result);
      return result;
    },
  };
  const jwt = await mintHs256({ sub: A }, SECRET);
  const first = await captureLogs(() => handleDeleteUser(req(jwt), deleteDeps(world, { erasure: recording })));
  assertEquals([first.result.status, await first.result.json()], [500, { error: "internal" }]);
  assertEquals(world.log.filter((c) => c.startsWith("beginAccountErasure")).length, 1);
  assertNoIdentifiers(first.logs);
  goTrueDown = false;
  const retry = await handleDeleteUser(req(jwt), deleteDeps(world, { erasure: recording }));
  assertEquals(retry.status, 200);
  assertEquals(captured, [{ state: "captured", subjects: 2 }, { state: "captured", subjects: 0 }]);
  assertEquals(world.log, [
    `beginAccountErasure:${A}:account_deleted`,
    `deleteUser:${A}`,
    `beginAccountErasure:${A}:account_deleted`,
    `deleteUser:${A}`,
  ]);
});

Deno.test("D6: the response keeps exactly the two fields old clients read", async () => {
  const world = accountWorld();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const deleteOk = { canIdentify: true, canDelete: true, setPersonEmail: () => Promise.resolve(), deletePerson: () => Promise.resolve() };
  for (const posthog of [undefined, deleteOk]) {
    const res = await handleDeleteUser(req(jwt), deleteDeps(world, { posthog }));
    assertDeleteShape(await res.json());
  }
  // NEGATIVE CONTROL: any added field fails the strict-keys assertion.
  assertThrows(() => assertDeleteShape({ deleted: true, analyticsDeleted: true, subjects: 2 }));
});

Deno.test("D7: the account store asks GoTrue for a hard delete, so the cascades and the snapshot run", async () => {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: Request | URL | string, init?: RequestInit) => {
    const request = new Request(input, init);
    return request.text().then((text) => {
      requests.push({ method: request.method, url: request.url, body: text ? JSON.parse(text) : null });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
  };
  try {
    const service = ["synthetic", "service", "role"].join("-");
    await new SupabaseUserStore("http://127.0.0.1:9", service).deleteUser(A);
  } finally {
    globalThis.fetch = original;
  }
  const hardDelete = (sent: typeof requests) => {
    assertEquals(sent.length, 1);
    assertEquals(sent[0]!.method, "DELETE");
    assert(sent[0]!.url.endsWith(`/auth/v1/admin/users/${A}`), sent[0]!.url);
    assertEquals(sent[0]!.body, { should_soft_delete: false });
  };
  hardDelete(requests);
  // NEGATIVE CONTROL: a soft delete (which leaves the row, so nothing cascades) fails it.
  assertThrows(() => hardDelete([{ ...requests[0]!, body: { should_soft_delete: true } }]));
});

// ── A malformed eraser login never stops account deletion (review P2-1) ──
const MALFORMED_ERASER_URLS = [
  "garbage",
  ["postgres://u:pa", "%ss@h/db"].join(""), // an unencoded % in the password
  "postgres://u:p@[::1/db", // a broken IPv6 address
];

Deno.test("D9: a malformed eraser URL disables the pre-step, logs a fixed category, and deletion still works", async () => {
  for (const url of MALFORMED_ERASER_URLS) {
    const { result: erasure, logs } = await captureLogs(() => Promise.resolve(eraserFromUrl(url)));
    assertEquals(erasure, null, url);
    assertEquals(logs, [[CAPTURE_DEFERRED_LOG, { reason: "config" }]], url);
    assertNoIdentifiers(logs);
    const { store, deleted } = mockStore();
    const jwt = await mintHs256({ sub: A }, SECRET);
    const res = await handleDeleteUser(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, store, erasure });
    assertEquals([res.status, deleted], [200, [A]], url);
    // NEGATIVE CONTROL: the unguarded construction throws (at module top level it would stop the
    // function from serving any deletion).
    assertThrows(() => new PgErasureStore(createWriterSql(url)), Error, undefined, url);
  }
  // Unset, empty or whitespace: no pre-step, and nothing to log.
  for (const url of [undefined, "", " ", "\n\t "]) {
    const { result, logs } = await captureLogs(() => Promise.resolve(eraserFromUrl(url)));
    assertEquals([result, logs], [null, []], JSON.stringify(url));
  }
  // A well-formed URL builds the store (the driver connects lazily, so nothing is opened here).
  const built: string[] = [];
  const fake: AccountErasurePort = accountWorld().erasure;
  assertEquals(eraserFromUrl("  postgresql://still_analytics_eraser:x@127.0.0.1:1/postgres  ", (u) => (built.push(u), fake)), fake);
  assertEquals(built, ["postgresql://still_analytics_eraser:x@127.0.0.1:1/postgres"]);
});

Deno.test("D10: a pre-step that throws synchronously never rejects the deletion", async () => {
  const world = accountWorld();
  const throwing: AccountErasurePort = {
    ...world.erasure,
    beginAccountErasure: () => {
      throw new ErasureStorageUnavailable();
    },
  };
  const jwt = await mintHs256({ sub: A }, SECRET);
  const { result: res, logs } = await captureLogs(() => handleDeleteUser(req(jwt), deleteDeps(world, { erasure: throwing })));
  assertEquals([res.status, await res.json()], [200, { deleted: true, analyticsDeleted: null }]);
  assertEquals(world.log, [`deleteUser:${A}`]);
  assertEquals(logs, [[CAPTURE_DEFERRED_LOG, { reason: "storage" }]]);
  // NEGATIVE CONTROL: called directly, the same store throws before any promise exists.
  assertThrows(() => throwing.beginAccountErasure(A, "account_deleted"), ErasureStorageUnavailable);
});
