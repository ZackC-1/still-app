import { assertEquals } from "@std/assert";
import { VerifiedAppleAccountRefresher } from "./apple-account-access.ts";
import type { AppleAccountAccessStore } from "./apple-access-store.ts";
import type { VerifiedAppleTransaction, AppleAccessVerifier } from "./apple-access.ts";
import { handleReconcile, type ReconcileDeps } from "../reconcile-entitlement/handler.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "./test-helpers.ts";
const holder = "11111111-1111-1111-1111-111111111111", right = "22222222-2222-2222-2222-222222222222";
const tx: VerifiedAppleTransaction = { key: "a".repeat(64), environment: "sandbox", bundleId: "com.example.still",
  productId: "still_pro_v3", originalTransactionId: "900719925474099312345", transactionId: "900719925474099312345", active: true };
function setup() {
  const calls: string[] = [], flags = { transactions: [tx] as VerifiedAppleTransaction[], canonical: tx as VerifiedAppleTransaction | null, confirmed: true, stale: false, issuerClockOffset: 0 };
  const store: AppleAccountAccessStore = {
    linkedTransactions: (id, env) => { assertEquals(id, holder); assertEquals(env, "sandbox"); calls.push("list"); return Promise.resolve(flags.transactions); },
    begin: () => { calls.push("begin"); return Promise.resolve("synthetic-observation"); },
    commit: (current) => {
      calls.push("commit");
      if (flags.stale) return Promise.resolve({ status: "stale" });
      return Promise.resolve(current.active ? { status: "verified", right: { right, holder: right, revision: 1, verified_at: 1000 }, issuer_time: 1000 + flags.issuerClockOffset } : { status: "revoked" });
    },
    confirm: () => { calls.push("confirm"); return Promise.resolve(flags.confirmed); },
  };
  const verifier: AppleAccessVerifier = { authenticate: () => Promise.resolve(null), refresh: () => { calls.push("canonical"); return Promise.resolve(flags.canonical); } };
  return { calls, flags, refresh: new VerifiedAppleAccountRefresher(store, verifier) };
}
Deno.test("already-linked Apple account renews only after current canonical API verification and final ledger fence", async () => {
  const s = setup(); assertEquals((await s.refresh.refresh(holder, "sandbox")).ready, true);
  assertEquals(s.calls, ["list", "begin", "canonical", "commit", "confirm"]);
});
Deno.test("no linked Apple rows permits web/legacy reconciliation without Apple provider configuration", async () => {
  const s = setup(); s.flags.transactions = []; s.flags.canonical = null;
  assertEquals((await s.refresh.refresh(holder, "sandbox")).ready, true); assertEquals(s.calls, ["list"]);
});
Deno.test("canonical Apple refund reaches the ledger and is not mistaken for provider ambiguity", async () => {
  const s = setup(); s.flags.canonical = { ...tx, active: false };
  assertEquals((await s.refresh.refresh(holder, "sandbox")).ready, true);
  assertEquals(s.calls, ["list", "begin", "canonical", "commit"]);
});
Deno.test("unavailable/wrong-scope provider cannot renew an account Apple clock", async () => {
  for (const current of [null, { ...tx, environment: "production" as const }, { ...tx, key: "b".repeat(64) },
    { ...tx, originalTransactionId: "12345" }, { ...tx, bundleId: "com.other.app" }]) {
    const s = setup(); s.flags.canonical = current;
    assertEquals(await s.refresh.refresh(holder, "sandbox"), { ready: false, rights: [] }); assertEquals(s.calls.includes("commit"), false);
  }
});
Deno.test("newer verification/transfer/refund during signing keeps reconciliation unavailable", async () => {
  for (const flag of ["stale", "confirmed"] as const) {
    const s = setup(); s.flags[flag] = flag === "stale";
    assertEquals(await s.refresh.refresh(holder, "sandbox"), { ready: false, rights: [] });
  }
});

Deno.test("all linked lookups settle before returning unavailable so another source failure cannot hide a refund", async () => {
  let refundCommitted = false;
  const other = { ...tx, key: "b".repeat(64), originalTransactionId: "12345" };
  const store: AppleAccountAccessStore = {
    linkedTransactions: () => Promise.resolve([other, tx]), begin: () => Promise.resolve("synthetic-token"),
    commit() { refundCommitted = true; return Promise.resolve({ status: "revoked" }); }, confirm: () => Promise.resolve(false),
  };
  const verifier: AppleAccessVerifier = { authenticate: () => Promise.resolve(null), async refresh(current) {
    if (current.key === other.key) throw new Error("synthetic unavailable");
    await new Promise(resolve => setTimeout(resolve, 10)); return { ...tx, active: false };
  } };
  assertEquals(await new VerifiedAppleAccountRefresher(store, verifier).refresh(holder, "sandbox"), { ready: false, rights: [] });
  assertEquals(refundCommitted, true);
});

Deno.test("Apple account proofs require the exact verification clock", async () => {
  for (const offset of [-1, 1]) {
    const s = setup(); s.flags.issuerClockOffset = offset;
    assertEquals(await s.refresh.refresh(holder, "sandbox"), { ready: false, rights: [] });
    assertEquals(s.calls.includes("confirm"), false);
  }
});

Deno.test("one bounded Apple refresh deadline covers stalled storage and provider work without late grants", async t => {
  for (const stage of ["list", "begin", "provider", "commit", "confirm"] as const) await t.step(stage, async () => {
    let release!: () => void, commits = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = globalThis.setTimeout, budgets: number[] = [];
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay && delay >= 8_000) { budgets.push(delay); return original(handler, 1, ...args); }
      return original(handler, delay, ...args);
    }) as typeof setTimeout;
    const store: AppleAccountAccessStore = {
      async linkedTransactions() { if (stage === "list") await held; return [tx]; },
      async begin() { if (stage === "begin") await held; return "synthetic-token"; },
      async commit() { commits++; if (stage === "commit") await held; return { status: "verified", right: { right, holder: right, revision: 1, verified_at: 1000 }, issuer_time: 1000 }; },
      async confirm() { if (stage === "confirm") await held; return true; },
    };
    const verifier: AppleAccessVerifier = { authenticate: () => Promise.resolve(null), async refresh() { if (stage === "provider") await held; return tx; } };
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const pending = new VerifiedAppleAccountRefresher(store, verifier).refresh(holder, "sandbox");
    try {
      const result = await Promise.race([pending, new Promise<"watchdog">((resolve) => { watchdog = original(() => resolve("watchdog"), 15); })]);
      assertEquals(result, { ready: false, rights: [] });
      assertEquals(budgets, [8_000]);
      assertEquals(commits, stage === "commit" || stage === "confirm" ? 1 : 0);
    } finally {
      clearTimeout(watchdog); release(); await pending; globalThis.setTimeout = original;
    }
    assertEquals(commits, stage === "commit" || stage === "confirm" ? 1 : 0);
  });
});

Deno.test("a stalled source cannot hide a committed refund or extend the shared deadline", async () => {
  let release!: () => void, refundCommitted = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const other = { ...tx, key: "b".repeat(64), originalTransactionId: "12345" };
  const original = globalThis.setTimeout, budgets: number[] = [];
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay && delay >= 8_000) { budgets.push(delay); return original(handler, 1, ...args); }
    return original(handler, delay, ...args);
  }) as typeof setTimeout;
  const store: AppleAccountAccessStore = {
    linkedTransactions: () => Promise.resolve([tx, other]), begin: () => Promise.resolve("synthetic-token"),
    commit(current) { assertEquals(current.active, false); refundCommitted = true; return Promise.resolve({ status: "revoked" }); },
    confirm: () => Promise.resolve(false),
  };
  const verifier: AppleAccessVerifier = { authenticate: () => Promise.resolve(null), async refresh(current) {
    if (current.key === other.key) { await held; return other; } return { ...tx, active: false };
  } };
  try {
    assertEquals(await new VerifiedAppleAccountRefresher(store, verifier).refresh(holder, "sandbox"), { ready: false, rights: [] });
    assertEquals(refundCommitted, true); assertEquals(budgets, [8_000]);
  } finally { release(); await Promise.resolve(); globalThis.setTimeout = original; }
});

Deno.test("real reconcile rate/deadline fences prevent late Apple positives and absent-clock renewal", async t => {
  const secret = "synthetic-test-only-secret-at-least-32-characters";
  const jwt = await mintHs256({ sub: holder }, secret);
  const request = () => new Request("http://x/reconcile", { method: "POST", headers: { Authorization: `Bearer ${jwt}`, "x-forwarded-for": "192.0.2.1" }, body: JSON.stringify({ access_schema: 1 }) });
  for (const blocked of [false, true]) await t.step(blocked ? "rate refusal" : "late canonical provider", async () => {
    let release!: () => void, appleCalls = 0, commits = 0, scopedCommits = 0, signs = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => original(handler, delay === 8_000 ? 1 : delay, ...args)) as typeof setTimeout;
    const appleStore: AppleAccountAccessStore = {
      linkedTransactions: () => { appleCalls++; return Promise.resolve([tx]); }, begin: () => Promise.resolve("apple-token"),
      commit: () => { commits++; return Promise.resolve({ status: "verified", right: { right, holder: right, revision: 1, verified_at: 1000 }, issuer_time: 1000 }); },
      confirm: () => Promise.resolve(true),
    };
    const verifier: AppleAccessVerifier = { authenticate: () => Promise.resolve(null), async refresh() { await held; return tx; } };
    const deps: ReconcileDeps = {
      jwtSecret: secret, expected: TEST_EXPECTED_CLAIMS,
      limiter: { consume(_key, max, window) { assertEquals([10, 60].includes(max), true); assertEquals(window, 60); return Promise.resolve(blocked ? 1 : 0); } },
      rc: { getSubscriber: () => Promise.resolve(null) },
      store: { claimEvent: () => Promise.resolve({ status: "claimed", token: "t" }), completeEvent: () => Promise.resolve(), releaseEvent: () => Promise.resolve(), setEntitlement: () => Promise.resolve() },
      access: {
        apple: new VerifiedAppleAccountRefresher(appleStore, verifier), provider: { getRights: () => Promise.resolve({ status: "unavailable" }) },
        signer: { environment: "sandbox", sign: () => { signs++; return Promise.resolve("synthetic-proof"); } },
        rights: { begin: () => Promise.resolve("account-token"), confirm: () => Promise.resolve(true),
          commit: () => { scopedCommits++; return Promise.resolve({ status: "committed", rights: [], revocations: [], issuer_time: 1000 }); } },
      },
    };
    try {
      const response = await handleReconcile(request(), deps);
      assertEquals(response.status, blocked ? 429 : 200);
      if (!blocked) assertEquals((await response.json()).access, { status: "unavailable" });
      release(); await Promise.resolve(); await Promise.resolve();
      assertEquals(appleCalls, blocked ? 0 : 1);
      assertEquals([commits, scopedCommits, signs], [0, 0, 0]);
    } finally { release(); globalThis.setTimeout = original; }
  });
});

Deno.test("real reconcile never publishes a proof whose final observation expired while signing", async () => {
  const secret = "synthetic-test-only-secret-at-least-32-characters";
  const jwt = await mintHs256({ sub: holder }, secret);
  const observed = { right, holder, revision: 1, verified_at: 1000 };
  let current = true, signStarted!: () => void, release!: () => void;
  const signing = new Promise<void>(resolve => { signStarted = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const deps: ReconcileDeps = {
    jwtSecret: secret, expected: TEST_EXPECTED_CLAIMS, limiter: { consume: () => Promise.resolve(0) },
    rc: { getSubscriber: () => Promise.resolve(null) },
    store: { claimEvent: () => Promise.resolve({ status: "claimed", token: "t" }), completeEvent: () => Promise.resolve(), releaseEvent: () => Promise.resolve(), setEntitlement: () => Promise.resolve() },
    access: {
      apple: { refresh: () => Promise.resolve({ ready: true, rights: [observed] }) }, provider: { getRights: () => Promise.resolve({ status: "unavailable" }) },
      signer: { environment: "sandbox", async sign() { signStarted(); await held; return "synthetic-late-proof"; } },
      rights: { begin: () => Promise.resolve("account-token"), confirm: () => Promise.resolve(current),
        commit: () => Promise.resolve({ status: "committed", rights: [observed], observed_rights: [], revocations: [], issuer_time: 1000 }) },
    },
  };
  const pending = handleReconcile(new Request("http://x/reconcile", { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ access_schema: 1 }) }), deps);
  await signing; current = false; release();
  assertEquals((await (await pending).json()).access, { status: "unavailable" });
});
