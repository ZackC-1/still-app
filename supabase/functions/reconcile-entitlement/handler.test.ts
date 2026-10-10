import { assertEquals } from "@std/assert";
import { handleReconcile } from "./handler.ts";
import { VerifiedAppleAccountRefresher } from "../_shared/apple-account-access.ts";
import type { AppleAccountAccessStore } from "../_shared/apple-access-store.ts";
import type { AppleAccessVerifier, VerifiedAppleTransaction } from "../_shared/apple-access.ts";
import { signHs256 } from "../_shared/jwt.ts";
import { mintEs256, mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";
import type { RateLimiter } from "../_shared/rate-limit.ts";
import type { EntitlementStore } from "../_shared/store.ts";
import type { RevenueCatClient, RcSubscriber } from "../_shared/revenuecat.ts";
import type { AccessRightStore, AccessSigner, CommittedAccess } from "../_shared/access-issuer.ts";
import { HttpRevenueCatAccessClient } from "../_shared/revenuecat-access.ts";

const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const EXPECTED = TEST_EXPECTED_CLAIMS;
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

const activeSub: RcSubscriber = { entitlements: { still_sync: { expires_date: null } } };
const activeV3Sub: RcSubscriber = { entitlements: { still_pro_v3: { expires_date: null } } };
const allowAll: RateLimiter = { consume: () => Promise.resolve(0) };

type Write = { userId: string; stillSync: boolean; source: string };

function mockStore() {
  const writes: Write[] = [];
  const store: EntitlementStore = {
    claimEvent: () => Promise.resolve({ status: "claimed", token: "t" }),
    completeEvent: () => Promise.resolve(),
    releaseEvent: () => Promise.resolve(),
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
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleReconcile(req(jwt), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    store,
    rc: mockRc({ [A]: activeSub }),
    limiter: allowAll,
  });
  assertEquals(res.status, 200);
  assertEquals(writes, [{ userId: A, stillSync: true, source: "reconcile" }]);
});

Deno.test("subject is taken from the JWT, NOT the request body (IDOR defense)", async () => {
  const { store, writes } = mockStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  // Body tries to target B; it must be ignored.
  await handleReconcile(req(jwt, { user_id: B }), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    store,
    rc: mockRc({ [A]: activeSub, [B]: activeSub }),
    limiter: allowAll,
  });
  assertEquals(writes[0]?.userId, A);
});

Deno.test("missing JWT → 401, no write", async () => {
  const { store, writes } = mockStore();
  const res = await handleReconcile(req(null), { jwtSecret: SECRET, expected: EXPECTED, store, rc: mockRc({}), limiter: allowAll });
  assertEquals(res.status, 401);
  assertEquals(writes.length, 0);
});

Deno.test("JWT signed with the wrong secret → 401, no write", async () => {
  const { store, writes } = mockStore();
  const jwt = await mintHs256({ sub: A }, "a-totally-different-secret-value-here!!");
  const res = await handleReconcile(req(jwt), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    store,
    rc: mockRc({ [A]: activeSub }),
    limiter: allowAll,
  });
  assertEquals(res.status, 401);
  assertEquals(writes.length, 0);
});

Deno.test("JWT with wrong issuer → 401, no write (defense in depth)", async () => {
  const { store, writes } = mockStore();
  // Signature-valid but wrong issuer.
  const jwt = await signHs256(
    { sub: A, iss: "https://evil.example/auth/v1", aud: "authenticated", role: "authenticated" },
    SECRET,
  );
  const res = await handleReconcile(req(jwt), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    store,
    rc: mockRc({ [A]: activeSub }),
    limiter: allowAll,
  });
  assertEquals(res.status, 401);
  assertEquals(writes.length, 0);
});

Deno.test("still_pro_v3-only subscriber → writes the JWT subject true", async () => {
  const { store, writes } = mockStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleReconcile(req(jwt), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    store,
    rc: mockRc({ [A]: activeV3Sub }),
    limiter: allowAll,
  });
  assertEquals(res.status, 200);
  assertEquals(writes, [{ userId: A, stillSync: true, source: "reconcile" }]);
});

Deno.test("webhook dropped → login reconcile establishes entitlement true", async () => {
  const { store, writes } = mockStore();
  const jwt = await mintHs256({ sub: A }, SECRET);
  await handleReconcile(req(jwt), {
    jwtSecret: SECRET,
    expected: EXPECTED,
    store,
    rc: mockRc({ [A]: activeSub }),
    limiter: allowAll,
  });
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
    const jwt = await mintEs256({ sub: A }, pair.privateKey, "k");
    const res = await handleReconcile(req(jwt), {
      jwtSecret: "",
      jwksUrl,
      expected: EXPECTED,
      store,
      rc: mockRc({ [A]: activeSub }),
      limiter: allowAll,
    });
    assertEquals(res.status, 200);
    assertEquals(writes, [{ userId: A, stillSync: true, source: "reconcile" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("over the reconcile limit → 429 with Retry-After, no RC lookup and no write", async () => {
  const { store, writes } = mockStore();
  let rcCalls = 0;
  const rc: RevenueCatClient = {
    getSubscriber() {
      rcCalls += 1;
      return Promise.resolve(activeSub);
    },
  };
  const limiter: RateLimiter = {
    consume: (key) => Promise.resolve(key.startsWith("reconcile:user:") ? 45 : 0),
  };
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleReconcile(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, store, rc, limiter });
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "45");
  assertEquals((await res.json()).error, "rate_limited");
  assertEquals(rcCalls, 0);
  assertEquals(writes.length, 0);
});

function scopedAccess(options: { providerUnavailable?: boolean; stale?: boolean; wrongHolder?: boolean; finalFence?: boolean; conflict?: boolean; none?: boolean } = {}) {
  const calls: string[] = [];
  const rights: AccessRightStore = {
    begin(holder, environment) { calls.push(`begin:${holder}:${environment}`); return Promise.resolve("33333333-3333-3333-3333-333333333333"); },
    commit(holder, environment) {
      calls.push(`commit:${holder}:${environment}`);
      const result: CommittedAccess = options.stale ? { status: "stale" } : { status: options.conflict ? "conflict" : "committed",
        rights: options.none ? [] : [{ right: "44444444-4444-4444-4444-444444444444", holder: options.wrongHolder ? B : holder, revision: 1, verified_at: 1000 }],
        revocations: options.none ? [{ right: "44444444-4444-4444-4444-444444444444", revision: 2 }] : [], issuer_time: 1000 };
      if (result.status !== "stale") return Promise.resolve({ ...result, observed_rights: result.rights });
      return Promise.resolve(result);
    },
    confirm() { calls.push("confirm"); return Promise.resolve(options.finalFence !== false); },
  };
  const signer: AccessSigner = { environment: "sandbox", sign() { calls.push("sign"); return Promise.resolve("synthetic-envelope-only"); } };
  const provider = { getRights(holder: string) {
    calls.push(`provider:${holder}`);
    return Promise.resolve(options.providerUnavailable ? { status: "unavailable" as const } : { status: "verified" as const, rights: [{ key: "a".repeat(64), product: "still_pro_v3" as const }] });
  } };
  return { access: { signer, rights, provider }, calls };
}

Deno.test("scoped opt-in begins before canonical lookup and binds only verified JWT subject/server environment", async () => {
  const { store } = mockStore();
  const { access, calls } = scopedAccess();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
    store, rc: mockRc({ [A]: activeV3Sub }), limiter: allowAll, access });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).access.status, "verified");
  assertEquals(calls, [`begin:${A}:sandbox`, `provider:${A}`, `commit:${A}:sandbox`, "sign", "confirm"]);
});

Deno.test("ordinary callers retain exact legacy response and do not touch scoped ledger", async () => {
  const { store } = mockStore(); const { access, calls } = scopedAccess();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleReconcile(req(jwt), { jwtSecret: SECRET, expected: EXPECTED, store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access });
  assertEquals(await res.json(), { still_sync: true }); assertEquals(calls, []);
});

Deno.test("missing signer/storage configuration leaves free/legacy reconciliation successful and scoped unavailable", async () => {
  const { store, writes } = mockStore(); const jwt = await mintHs256({ sub: A }, SECRET);
  const res = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED, store, rc: mockRc({ [A]: activeSub }), limiter: allowAll });
  assertEquals(await res.json(), { still_sync: true, access: { status: "unavailable" } });
  assertEquals(writes.length, 1);
});

Deno.test("provider uncertainty, stale observation, wrong holder and transfer/refund while signing cannot issue reply", async () => {
  for (const option of [{ providerUnavailable: true }, { stale: true }, { wrongHolder: true }, { finalFence: false }]) {
    const { store } = mockStore(); const { access, calls } = scopedAccess(option); const jwt = await mintHs256({ sub: A }, SECRET);
    const res = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED, store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access });
    assertEquals((await res.json()).access.status, "unavailable");
    if (option.providerUnavailable) assertEquals(calls.some(call => call.startsWith("commit:")), true);
    if (option.wrongHolder || option.stale) assertEquals(calls.includes("sign"), false);
  }
});

Deno.test("conclusive absence carries specific revision revocations; conflict stays distinct", async () => {
  for (const option of [{ none: true }, { conflict: true }]) {
    const { store } = mockStore(); const { access } = scopedAccess(option); const jwt = await mintHs256({ sub: A }, SECRET);
    const res = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED, store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access });
    const data = await res.json(); assertEquals(data.access.status, option.none ? "none" : "conflict");
    assertEquals(data.access.revocations.length, option.none ? 1 : 0);
  }
});

Deno.test("schema cannot carry client-selected holder, environment or product", async () => {
  const { store, writes } = mockStore(); const { access, calls } = scopedAccess(); const jwt = await mintHs256({ sub: A }, SECRET);
  for (const body of [{ access_schema: 1, holder: B }, { access_schema: 1, environment: "production" }, { access_schema: 2 }]) {
    const res = await handleReconcile(req(jwt, body), { jwtSecret: SECRET, expected: EXPECTED, store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access });
    assertEquals(res.status, 400);
  }
  assertEquals(writes, []); assertEquals(calls, []);
});

Deno.test("linked Apple canonical refresh runs after RC lookup and before scoped issuance for authenticated account", async () => {
  const { store } = mockStore(), { access, calls } = scopedAccess();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const apple = { refresh(holder: string, environment: string) {
    calls.push(`apple:${holder}:${environment}`); return Promise.resolve(true);
  } };
  const response = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
    store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access: { ...access, apple } });
  assertEquals((await response.json()).access.status, "verified");
  assertEquals(calls, [`begin:${A}:sandbox`, `provider:${A}`, `apple:${A}:sandbox`, `commit:${A}:sandbox`, "sign", "confirm"]);
});
Deno.test("unavailable Apple ownership does not block independently current verified RC rows", async () => {
  const { store, writes } = mockStore(), { access, calls } = scopedAccess();
  const jwt = await mintHs256({ sub: A }, SECRET);
  const response = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
    store, rc: mockRc({ [A]: activeSub }), limiter: allowAll,
    access: { ...access, apple: { refresh: () => Promise.resolve(false) } } });
  assertEquals((await response.json()).access.status, "verified");
  assertEquals(calls.some(call => call.startsWith("commit:")), true); assertEquals(calls.includes("sign"), true);
  assertEquals(writes.length, 1);
});

Deno.test("partial provider ambiguity can deliver confirmed removals without manufacturing verified-none", async () => {
  const { store } = mockStore(); const { access } = scopedAccess({ none: true }); const jwt = await mintHs256({ sub: A }, SECRET);
  const provider = { getRights: () => Promise.resolve({ status: "verified" as const, rights: [], complete: false }) };
  const result = await (await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
    store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access: { ...access, provider } })).json();
  assertEquals(result.still_sync, true);
  assertEquals(result.access, { status: "unavailable", environment: "sandbox", proofs: [],
    revocations: [{ right: "44444444-4444-4444-4444-444444444444", revision: 2 }], issuer_time: 1000 });
});
Deno.test("uncertain Apple refresh still persists and returns known provider removals through final fence", async () => {
  for (const confirmed of [true, false]) {
    const { store } = mockStore(); const { access, calls } = scopedAccess({ none: true, finalFence: confirmed }); const jwt = await mintHs256({ sub: A }, SECRET);
    const result = await (await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
      store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access: { ...access, apple: { refresh: () => Promise.resolve(false) } } })).json();
    assertEquals(result.access.status, "unavailable");
    assertEquals("revocations" in result.access, confirmed);
    assertEquals(calls.some(c => c.startsWith("commit:")), true); assertEquals(calls.includes("sign"), false);
  }
});
Deno.test("partial uncertainty without a verified removal carries no authority metadata", async () => {
  const { store } = mockStore(); const { access } = scopedAccess({ none: true }); const jwt = await mintHs256({ sub: A }, SECRET);
  const rights: AccessRightStore = { ...access.rights, commit: () => Promise.resolve({ status: "committed" as const, rights: [], revocations: [], issuer_time: 1000 }) };
  const provider = { getRights: () => Promise.resolve({ status: "verified" as const, rights: [], complete: false }) };
  const result = await (await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
    store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access: { ...access, provider, rights } })).json();
  assertEquals(result.access, { status: "unavailable" });
});

Deno.test("RC missing customer/404 after Apple-first-link refreshes current Apple only and preserves historical RC clocks", async () => {
  const { store } = mockStore(); const { access } = scopedAccess(); const jwt = await mintHs256({ sub: A }, SECRET);
  const appleRight = { right: "44444444-4444-4444-4444-444444444444", holder: A, revision: 1, verified_at: Date.now() };
  const historical = { right: "55555555-5555-5555-5555-555555555555", holder: A, revision: 0, verified_at: appleRight.verified_at - 2592000001 };
  for (const oldRows of [[], [historical]]) {
    const signed: string[] = [];
    const result = await (await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
      store, rc: mockRc({}), limiter: allowAll, access: { ...access,
        provider: { getRights: () => Promise.resolve({ status: "unavailable" as const }) },
        apple: { refresh: () => Promise.resolve({ ready: true, rights: [appleRight] }) },
        rights: { ...access.rights, commit: (_holder, _environment, _token, supplied) => {
          assertEquals(supplied, []);
          return Promise.resolve({ status: "committed" as const, rights: [appleRight, ...oldRows], observed_rights: [], revocations: [], issuer_time: appleRight.verified_at });
        } },
        signer: { ...access.signer, sign: right => { signed.push(right.right); return Promise.resolve("synthetic-current-apple-only"); } },
      } })).json();
    assertEquals(result.access.status, "verified"); assertEquals(result.access.proofs, ["synthetic-current-apple-only"]);
    assertEquals(signed, [appleRight.right]); assertEquals(historical.verified_at, appleRight.verified_at - 2592000001);
  }
});
Deno.test("both Apple and RC unavailable cannot grant or assert verified-none even with an old ledger row", async () => {
  const { store } = mockStore(); const { access, calls } = scopedAccess(); const jwt = await mintHs256({ sub: A }, SECRET);
  for (const apple of [{ ready: false, rights: [] }, { ready: true, rights: [] }]) {
    const result = await (await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
      store, rc: mockRc({}), limiter: allowAll, access: { ...access,
        provider: { getRights: () => Promise.resolve({ status: "unavailable" as const }) },
        apple: { refresh: () => Promise.resolve(apple) },
      } })).json();
    assertEquals(result.access, { status: "unavailable" });
  }
  assertEquals(calls.includes("sign"), false);
});
Deno.test("fresh Apple candidate with changed ownership revision cannot survive account commit intersection", async () => {
  const { store } = mockStore(); const { access, calls } = scopedAccess(); const jwt = await mintHs256({ sub: A }, SECRET);
  const result = await (await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
    store, rc: mockRc({}), limiter: allowAll, access: { ...access,
      provider: { getRights: () => Promise.resolve({ status: "unavailable" as const }) },
      apple: { refresh: () => Promise.resolve({ ready: true, rights: [{ right: "44444444-4444-4444-4444-444444444444", holder: A, revision: 0, verified_at: 1000 }] }) },
    } })).json();
  assertEquals(result.access, { status: "unavailable" }); assertEquals(calls.includes("sign"), false);
});

Deno.test("partial refresh failure returns only account/environment/token fenced known removals", async () => {
  const { store } = mockStore(), { access, calls } = scopedAccess({ providerUnavailable: true });
  const jwt = await mintHs256({ sub: A }, SECRET);
  const revocations = [{ right: "44444444-4444-4444-4444-444444444444", revision: 2 }];
  const rights = { ...access.rights, removals(holder: string, environment: "sandbox" | "production", token: string) {
    assertEquals([holder, environment, token], [A, "sandbox", "33333333-3333-3333-3333-333333333333"]);
    calls.push("removals"); return Promise.resolve({ holder, environment, revocations, issuer_time: 2000 });
  } };
  const response = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
    store, rc: mockRc({ [A]: activeSub }), limiter: allowAll,
    access: { ...access, rights, apple: { refresh: () => Promise.resolve(false) } } });
  assertEquals(await response.json(), { still_sync: true, access: { status: "unavailable", environment: "sandbox", proofs: [], revocations, issuer_time: 2000 } });
  assertEquals(calls.some(call => call.startsWith("commit:")), false); assertEquals(calls.includes("sign"), false);
});

Deno.test("unavailable RC still waits for independent Apple removal; untrusted or stale scope cannot remove", async () => {
  const jwt = await mintHs256({ sub: A }, SECRET);
  const revocations = [{ right: "44444444-4444-4444-4444-444444444444", revision: 2 }];
  for (const variant of ["valid", "stale", "otherHolder", "otherEnvironment", "extra", "invalidRevision", "duplicate"] as const) {
    const { store } = mockStore(), { access, calls } = scopedAccess({ providerUnavailable: true }); let finishedApple = false;
    const rights = { ...access.rights, removals(holder: string, environment: "sandbox" | "production") {
      assertEquals(finishedApple, true);
      return Promise.resolve(variant === "stale" ? null : { holder: variant === "otherHolder" ? B : holder,
        environment: variant === "otherEnvironment" ? "production" as const : environment,
        revocations: variant === "duplicate" ? [revocations[0], revocations[0]] : variant === "invalidRevision" ? [{ ...revocations[0], revision: -1 }] : revocations,
        issuer_time: 2000, ...(variant === "extra" ? { rights: [] } : {}) });
    } };
    const response = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
      store, rc: mockRc({ [A]: activeSub }), limiter: allowAll,
      access: { ...access, rights, apple: { async refresh() { await Promise.resolve(); finishedApple = true; return false; } } } });
    const expected = variant === "valid" ? { status: "unavailable", environment: "sandbox", proofs: [], revocations, issuer_time: 2000 } : { status: "unavailable" };
    assertEquals((await response.json()).access, expected);
    assertEquals(calls.some(call => call.startsWith("commit:")), false); assertEquals(calls.includes("sign"), false);
  }
});

Deno.test("unfinished reconcile body has a whole-read deadline and cannot fall through to legacy writes", async () => {
  const jwt = await mintHs256({ sub: A }, SECRET), { store, writes } = mockStore(), { access, calls } = scopedAccess();
  let controller!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('{"access_schema":1}')); }, cancel() { cancelled = true; } });
  const request = new Request("http://x/reconcile", { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([handleReconcile(request, { jwtSecret: SECRET, expected: EXPECTED,
      store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access }), new Promise<null>(resolve => { guard = setTimeout(() => { controller.close(); resolve(null); }, 2400); })]);
    assertEquals(result?.status, 400); assertEquals(await result!.json(), { error: "invalid_access_request" });
    assertEquals(cancelled, true); assertEquals(writes, []); assertEquals(calls, []);
  } finally { clearTimeout(guard); }
});

Deno.test("oversize or errored reconciliation bodies cancel without awaiting hostile cancellation; completed legacy survives", async () => {
  const jwt = await mintHs256({ sub: A }, SECRET);
  for (const mode of ["oversize", "error", "legacy"] as const) {
    const { store, writes } = mockStore(), { access, calls } = scopedAccess(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      if (mode === "error") controller.error(new Error("synthetic broken input"));
      else { controller.enqueue(new TextEncoder().encode(mode === "oversize" ? "x".repeat(4097) : "legacy completed non-JSON")); if (mode === "legacy") controller.close(); }
    }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
    const request = new Request("http://x/reconcile", { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body });
    const response = await handleReconcile(request, { jwtSecret: SECRET, expected: EXPECTED, store, rc: mockRc({ [A]: activeSub }), limiter: allowAll, access });
    assertEquals(response.status, mode === "legacy" ? 200 : 400);
    if (mode === "legacy") { assertEquals(await response.json(), { still_sync: true }); assertEquals(writes.length, 1); }
    else { assertEquals(await response.json(), { error: "invalid_access_request" }); assertEquals(writes, []); }
    assertEquals(calls, []); if (mode === "oversize") assertEquals(cancelled, true);
  }
});

Deno.test("real linked-Apple refresher plus handler returns committed refund after another lookup throws", async () => {
  const jwt = await mintHs256({ sub: A }, SECRET), { store } = mockStore(), { access, calls } = scopedAccess();
  const tx: VerifiedAppleTransaction = { key: "a".repeat(64), environment: "sandbox", bundleId: "com.example.still",
    productId: "still_pro_v3", originalTransactionId: "900719925474099312345", transactionId: "900719925474099312345", active: true };
  const other = { ...tx, key: "b".repeat(64) }; let refundPersisted = false;
  const appleStore: AppleAccountAccessStore = {
    linkedTransactions: () => Promise.resolve([other, tx]), begin: () => Promise.resolve("synthetic-token"),
    commit(current) { assertEquals(current.active, false); refundPersisted = true; return Promise.resolve({ status: "revoked" }); },
    confirm: () => Promise.resolve(false),
  };
  const verifier: AppleAccessVerifier = { authenticate: () => Promise.resolve(null), async refresh(current) {
    if (current.key === other.key) throw new Error("synthetic lookup unavailable");
    await new Promise(resolve => setTimeout(resolve, 10)); return { ...tx, active: false };
  } };
  const revocations = [{ right: "44444444-4444-4444-4444-444444444444", revision: 2 }];
  const rights: AccessRightStore = { ...access.rights, removals(holder, environment) {
    assertEquals(refundPersisted, true); return Promise.resolve({ holder, environment, revocations, issuer_time: 2000 });
  } };
  const response = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED,
    store, rc: mockRc({ [A]: activeSub }), limiter: allowAll,
    access: { ...access, rights, provider: { getRights: () => Promise.reject(new Error("independent RC unavailable")) },
      apple: new VerifiedAppleAccountRefresher(appleStore, verifier) } });
  assertEquals((await response.json()).access, { status: "unavailable", environment: "sandbox", proofs: [], revocations, issuer_time: 2000 });
  assertEquals(calls.some(call => call.startsWith("commit:")), false); assertEquals(calls.includes("sign"), false);
});

Deno.test("production scoped route: RevenueCat customer-missing 404 is verified-none for the JWT subject only", async () => {
  const realFetch = globalThis.fetch;
  const run = async (body: string | null, option: Parameters<typeof scopedAccess>[0] = { none: true }) => {
    const urls: unknown[] = [];
    globalThis.fetch = ((input: unknown) => { urls.push(input); return Promise.resolve(new Response(body, { status: 404 })); }) as typeof fetch;
    const { store } = mockStore(); const { access, calls } = scopedAccess(option); const jwt = await mintHs256({ sub: A }, SECRET);
    const provider = new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", [{ product_id: "prod-current", app_id: "app-still",
      store_identifier: "still_pro_v3", entitlement_lookup_key: "still_pro_v3", store: "rc_billing" }]);
    const res = await handleReconcile(req(jwt, { access_schema: 1 }), { jwtSecret: SECRET, expected: EXPECTED, store,
      rc: mockRc({}), limiter: allowAll, access: { ...access, provider } });
    return { data: await res.json(), urls, calls };
  };
  const missing = JSON.stringify({ object: "error", type: "resource_missing", message: "Customer not found", retryable: false });
  try {
    const none = await run(missing);
    assertEquals(none.data.access.status, "none"); assertEquals(none.data.access.proofs, []);
    assertEquals(none.urls, [`https://api.revenuecat.com/v2/projects/proj-still/customers/${A}/purchases?environment=sandbox&limit=100`]);
    assertEquals(none.calls, [`begin:${A}:sandbox`, `commit:${A}:sandbox`, "confirm"]);
    for (const body of [null, "", "{}", JSON.stringify({ type: "resource_missing", retryable: true }),
      JSON.stringify({ type: "resource_missing", message: "Project not found" })]) {
      assertEquals((await run(body)).data.access.status, "unavailable", String(body));
    }
    // The final account fence still gates the absence answer.
    assertEquals((await run(missing, { none: true, finalFence: false })).data.access.status, "unavailable");
  } finally { globalThis.fetch = realFetch; }
});
