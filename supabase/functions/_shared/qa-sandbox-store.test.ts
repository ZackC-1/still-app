import { assertEquals, assertRejects } from "@std/assert";
import type { VerifiedAppleTransaction } from "./apple-access.ts";
import type { AccountRight, CommittedAccess } from "./access-issuer.ts";
import { QaSandboxAccessRightStore, QaSandboxAppleAccessStore, QaSandboxPgRateLimiter } from "./qa-sandbox-store.ts";

type Sql = ConstructorParameters<typeof QaSandboxAccessRightStore>[0];
const HOLDER = "11111111-1111-1111-1111-111111111111";
const RIGHT = "22222222-2222-2222-2222-222222222222";
const TOKEN = "33333333-3333-3333-3333-333333333333";
const OPERATION = "44444444-4444-4444-4444-444444444444";
const SOURCE = "55555555-5555-5555-5555-555555555555";
const TX: VerifiedAppleTransaction = { key: "a".repeat(64), environment: "sandbox", bundleId: "co.cadmus.Still",
  productId: "still_pro_v3", originalTransactionId: "123456", transactionId: "123457", active: true };
const LOCAL: AccountRight = { right: RIGHT, holder: RIGHT, revision: 1, verified_at: 1000 };
const ACCOUNT: AccountRight = { ...LOCAL, holder: HOLDER };

function mockSql(rows: unknown[] = [], error?: unknown) {
  const calls: { rpc: string; text: string; values: unknown[] }[] = [];
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ rpc: /public\.([a-z_]+)\(/.exec(text)?.[1] ?? "", text, values });
    return error ? Promise.reject(error) : Promise.resolve(rows);
  }, { json: (value: unknown) => ({ value, type: 3802 }) }) as unknown as Sql;
  return { sql, calls };
}
function call(mock: ReturnType<typeof mockSql>, rpc: string, values: unknown[]) {
  assertEquals(mock.calls.length, 1);
  assertEquals(mock.calls[0]!.rpc, rpc);
  assertEquals(mock.calls[0]!.values, values);
  // No caller-selected environment is transmitted to any fixed-sandbox RPC.
  assertEquals(mock.calls[0]!.values.includes("sandbox"), false);
  assertEquals(mock.calls[0]!.values.includes("production"), false);
}

Deno.test("QA Apple observation binds identity to the fixed sandbox RPC without environment or holder", async () => {
  const mock = mockSql([{ token: TOKEN }]);
  assertEquals(await new QaSandboxAppleAccessStore(mock.sql).begin(TX), TOKEN);
  call(mock, "qa_sandbox_begin_apple_access_observation", [TX.key, TX.bundleId, TX.productId, TX.originalTransactionId]);
});

Deno.test("QA Apple local active commit carries no holder, operation, revision or link intent", async () => {
  const result = { status: "verified" as const, right: LOCAL, issuer_time: 1000 };
  const mock = mockSql([{ result }]);
  assertEquals(await new QaSandboxAppleAccessStore(mock.sql).commit(TX, TOKEN), result);
  call(mock, "qa_sandbox_commit_apple_local", [TX.key, TOKEN, true]);
});

Deno.test("QA Apple explicit first link and transfer use the account RPC with exact authority fields", async () => {
  for (const sourceHolder of [undefined, SOURCE]) {
    const result = { status: sourceHolder ? "already_linked" as const : "linked" as const, right: ACCOUNT, issuer_time: 1000 };
    const mock = mockSql([{ result }]);
    assertEquals(await new QaSandboxAppleAccessStore(mock.sql).commit(TX, TOKEN,
      { holder: HOLDER, operation: OPERATION, expectedRevision: 0, sourceHolder }), result);
    call(mock, "qa_sandbox_commit_apple_link", [TX.key, TOKEN, true, HOLDER, OPERATION, 0, sourceHolder ?? null]);
  }
});

Deno.test("canonical QA Apple refund drops even invalid rejected link intent and reaches local negative RPC", async () => {
  const mock = mockSql([{ result: { status: "revoked" } }]);
  assertEquals(await new QaSandboxAppleAccessStore(mock.sql).commit({ ...TX, active: false }, TOKEN,
    { holder: "disabled-or-invalid", operation: "invalid", expectedRevision: -1 }), { status: "revoked" });
  call(mock, "qa_sandbox_commit_apple_local", [TX.key, TOKEN, false]);
});

Deno.test("QA Apple local and account confirmation have separate SQL shapes", async () => {
  const local = mockSql([{ confirmed: true }]);
  assertEquals(await new QaSandboxAppleAccessStore(local.sql).confirm(TX, TOKEN, LOCAL), true);
  call(local, "qa_sandbox_confirm_apple_local", [TX.key, TOKEN, RIGHT, 1, 1000]);
  const account = mockSql([{ confirmed: false }]);
  assertEquals(await new QaSandboxAppleAccessStore(account.sql).confirm(TX, TOKEN, ACCOUNT), false);
  call(account, "qa_sandbox_confirm_apple_account", [TX.key, TOKEN, RIGHT, HOLDER, 1, 1000]);
});

Deno.test("every QA Apple entry rejects production even canonical negatives before SQL", async () => {
  const mock = mockSql([{ confirmed: true }]);
  const store = new QaSandboxAppleAccessStore(mock.sql);
  const production = { ...TX, environment: "production" as const };
  await assertRejects(() => store.begin(production));
  await assertRejects(() => store.commit({ ...production, active: false }, TOKEN));
  await assertRejects(() => store.confirm(production, TOKEN, LOCAL));
  await assertRejects(() => store.linkedTransactions(HOLDER, "production"));
  assertEquals(mock.calls, []);
});

Deno.test("QA Apple input validation prevents malformed receipts and Family Sharing links reaching SQL", async () => {
  const mock = mockSql();
  const store = new QaSandboxAppleAccessStore(mock.sql);
  for (const tx of [{ ...TX, key: "wrong" }, { ...TX, bundleId: "bad/bundle" },
    { ...TX, originalTransactionId: "0" }, { ...TX, transactionId: "NaN" }]) await assertRejects(() => store.begin(tx));
  await assertRejects(() => store.commit(TX, "invalid"));
  await assertRejects(() => store.commit({ ...TX, localOnly: true }, TOKEN, { holder: HOLDER, operation: OPERATION, expectedRevision: 0 }));
  for (const link of [{ holder: HOLDER, operation: "bad", expectedRevision: 0 },
    { holder: HOLDER, operation: OPERATION, expectedRevision: Number.MAX_SAFE_INTEGER },
    { holder: HOLDER, operation: OPERATION, expectedRevision: 0, sourceHolder: HOLDER }]) await assertRejects(() => store.commit(TX, TOKEN, link));
  await assertRejects(() => store.confirm({ ...TX, active: false }, TOKEN, LOCAL));
  assertEquals(mock.calls, []);
});

Deno.test("QA Apple malformed or incompatible commit responses never expose a positive right", async () => {
  for (const result of [null, { status: "unknown" }, { status: "verified" },
    { status: "verified", right: ACCOUNT, issuer_time: 1000 },
    { status: "verified", right: { ...LOCAL, right: "bad" }, issuer_time: 1000 },
    { status: "verified", right: { ...LOCAL, revision: -1 }, issuer_time: 1000 },
    { status: "verified", right: { ...LOCAL, verified_at: 1001 }, issuer_time: 1000 }]) {
    await assertRejects(() => new QaSandboxAppleAccessStore(mockSql([{ result }]).sql).commit(TX, TOKEN));
  }
  for (const result of [{ status: "verified", right: ACCOUNT, issuer_time: 1000 },
    { status: "linked", right: LOCAL, issuer_time: 1000 },
    { status: "linked", right: { ...ACCOUNT, revision: 5 }, issuer_time: 1000 }]) {
    await assertRejects(() => new QaSandboxAppleAccessStore(mockSql([{ result }]).sql).commit(TX, TOKEN,
      { holder: HOLDER, operation: OPERATION, expectedRevision: 0 }));
  }
  await assertRejects(() => new QaSandboxAppleAccessStore(mockSql([{ result: { status: "verified", right: LOCAL, issuer_time: 1000 } }]).sql)
    .commit({ ...TX, active: false }, TOKEN));
});

Deno.test("QA Apple linked account refresh reads only registered sandbox rows and cannot silently associate", async () => {
  const rows = [{ ...TX, transactionId: TX.originalTransactionId }];
  const mock = mockSql([{ result: rows }]);
  assertEquals(await new QaSandboxAppleAccessStore(mock.sql).linkedTransactions(HOLDER, "sandbox"), rows);
  call(mock, "qa_sandbox_read_linked_apple_transactions", [HOLDER]);
  for (const result of [null, [TX], [{ ...rows[0], environment: "production" }],
    [{ ...rows[0], active: false }], [{ ...rows[0], localOnly: true }], [rows[0], rows[0]], Array(17).fill(rows[0])]) {
    await assertRejects(() => new QaSandboxAppleAccessStore(mockSql([{ result }]).sql).linkedTransactions(HOLDER, "sandbox"));
  }
});

Deno.test("QA account observation and provider commit transmit no environment and a closed snapshot", async () => {
  const begin = mockSql([{ token: TOKEN }]);
  assertEquals(await new QaSandboxAccessRightStore(begin.sql).begin(HOLDER, "sandbox"), TOKEN);
  call(begin, "qa_sandbox_begin_access_observation", [HOLDER]);
  const result: CommittedAccess = { status: "committed", rights: [ACCOUNT], observed_rights: [ACCOUNT], revocations: [], issuer_time: 1000 };
  const snapshot = [{ key: TX.key, product: "still_pro_v3" as const }, { key: "b".repeat(64), product: "still_sync" as const, state: "revoked" as const }];
  const commit = mockSql([{ result }]);
  assertEquals(await new QaSandboxAccessRightStore(commit.sql).commit(HOLDER, "sandbox", TOKEN, snapshot), result);
  call(commit, "qa_sandbox_commit_access_observation", [HOLDER, TOKEN, { value: snapshot, type: 3802 }]);
});

Deno.test("disabled QA subjects can commit canonical negatives and read removals despite false positive confirmation", async () => {
  const negative = [{ key: TX.key, product: "still_pro_v3" as const, state: "revoked" as const }];
  const receipt = { status: "committed" as const, rights: [], observed_rights: [], revocations: [{ right: RIGHT, revision: 2 }], issuer_time: 1000 };
  const commit = mockSql([{ result: receipt }]);
  assertEquals(await new QaSandboxAccessRightStore(commit.sql).commit(HOLDER, "sandbox", TOKEN, negative), receipt);
  call(commit, "qa_sandbox_commit_access_observation", [HOLDER, TOKEN, { value: negative, type: 3802 }]);
  const confirmation = mockSql([{ confirmed: false }]);
  assertEquals(await new QaSandboxAccessRightStore(confirmation.sql).confirm(HOLDER, "sandbox", TOKEN), false);
  call(confirmation, "qa_sandbox_confirm_access_observation", [HOLDER, TOKEN]);
  const removal = { holder: HOLDER, environment: "sandbox" as const, issuer_time: 1000, revocations: receipt.revocations };
  const removals = mockSql([{ result: removal }]);
  assertEquals(await new QaSandboxAccessRightStore(removals.sql).removals(HOLDER, "sandbox", TOKEN), removal);
  call(removals, "qa_sandbox_read_access_removals", [HOLDER, TOKEN]);
});

Deno.test("every QA account entry rejects production including removal and negative commit before SQL", async () => {
  const mock = mockSql();
  const store = new QaSandboxAccessRightStore(mock.sql);
  await assertRejects(() => store.begin(HOLDER, "production"));
  await assertRejects(() => store.commit(HOLDER, "production", TOKEN, [{ key: TX.key, product: "still_pro_v3", state: "revoked" }]));
  await assertRejects(() => store.confirm(HOLDER, "production", TOKEN));
  await assertRejects(() => store.removals(HOLDER, "production", TOKEN));
  await assertRejects(() => store.begin("bad", "sandbox"));
  await assertRejects(() => store.commit(HOLDER, "sandbox", "bad", []));
  assertEquals(mock.calls, []);
});

Deno.test("QA account commit refuses invalid provider keys, states and duplicate identity before SQL", async () => {
  const mock = mockSql();
  const store = new QaSandboxAccessRightStore(mock.sql);
  for (const rights of [[{ key: "bad", product: "still_pro_v3" as const }],
    [{ key: TX.key, product: "still_pro_v3" as const, state: "active" as "revoked" }],
    [{ key: TX.key, product: "still_pro_v3" as const }, { key: TX.key, product: "still_sync" as const }],
    Array(17).fill({ key: TX.key, product: "still_pro_v3" })]) await assertRejects(() => store.commit(HOLDER, "sandbox", TOKEN, rights));
  assertEquals(mock.calls, []);
});

Deno.test("QA account commit validates exact observation subset, holder, timestamps and revocation identities", async () => {
  const valid = { status: "committed", rights: [ACCOUNT], observed_rights: [ACCOUNT], revocations: [], issuer_time: 1000 };
  for (const result of [null, { status: "other" }, { ...valid, rights: [LOCAL] },
    { ...valid, rights: [ACCOUNT, ACCOUNT] }, { ...valid, rights: [{ ...ACCOUNT, right: "bad" }] },
    { ...valid, rights: [{ ...ACCOUNT, verified_at: 1001 }] }, { ...valid, issuer_time: NaN },
    { ...valid, observed_rights: [{ ...ACCOUNT, revision: 0 }] }, { ...valid, observed_rights: [{ ...ACCOUNT, verified_at: 999 }] },
    { ...valid, observed_rights: [{ ...ACCOUNT, holder: SOURCE }] }, { ...valid, observed_rights: [ACCOUNT, ACCOUNT] },
    { ...valid, revocations: [{ right: RIGHT, revision: -1 }] },
    { ...valid, revocations: [{ right: RIGHT, revision: 1 }, { right: RIGHT, revision: 2 }] }]) {
    await assertRejects(() => new QaSandboxAccessRightStore(mockSql([{ result }]).sql).commit(HOLDER, "sandbox", TOKEN, []));
  }
  assertEquals(await new QaSandboxAccessRightStore(mockSql([{ result: { status: "stale" } }]).sql).commit(HOLDER, "sandbox", TOKEN, []), { status: "stale" });
  const conflict = { ...valid, status: "conflict" as const };
  assertEquals(await new QaSandboxAccessRightStore(mockSql([{ result: conflict }]).sql).commit(HOLDER, "sandbox", TOKEN, []), conflict);
});

Deno.test("QA stores reject missing/malformed/multiple observation and Boolean receipts", async () => {
  for (const rows of [[], [{ token: null }], [{ token: "bad" }], [{ token: TOKEN }, { token: TOKEN }]]) {
    await assertRejects(() => new QaSandboxAccessRightStore(mockSql(rows).sql).begin(HOLDER, "sandbox"));
    await assertRejects(() => new QaSandboxAppleAccessStore(mockSql(rows).sql).begin(TX));
  }
  for (const rows of [[], [{ confirmed: 1 }], [{ confirmed: true }, { confirmed: true }]]) {
    await assertRejects(() => new QaSandboxAccessRightStore(mockSql(rows).sql).confirm(HOLDER, "sandbox", TOKEN));
    await assertRejects(() => new QaSandboxAppleAccessStore(mockSql(rows).sql).confirm(TX, TOKEN, LOCAL));
  }
});

Deno.test("QA removal receipts retain the shared closed holder/environment/revocation grammar", async () => {
  const valid = { holder: HOLDER, environment: "sandbox", issuer_time: 1000, revocations: [{ right: RIGHT, revision: 2 }] };
  assertEquals(await new QaSandboxAccessRightStore(mockSql([{ result: null }]).sql).removals(HOLDER, "sandbox", TOKEN), null);
  for (const result of [undefined, { ...valid, holder: SOURCE }, { ...valid, environment: "production" },
    { ...valid, proofs: [] }, { ...valid, revocations: [] }, { ...valid, issuer_time: -1 },
    { ...valid, revocations: [{ right: RIGHT, revision: 2, extra: true }] }]) {
    await assertRejects(() => new QaSandboxAccessRightStore(mockSql([{ result }]).sql).removals(HOLDER, "sandbox", TOKEN));
  }
});

Deno.test("QA limiter translates only the three closed handler surfaces to exact QA quotas", async () => {
  for (const [surface, user, ip] of [["apple-access", 10, 30], ["checkout", 5, 20], ["reconcile", 10, 60]] as const) {
    for (const prefix of ["", "qa-sandbox-"]) {
      for (const [kind, identity, quota] of [["user", HOLDER, user], ["ip", "2001:db8::/64", ip]] as const) {
        const mock = mockSql([{ wait: 7 }]);
        assertEquals(await new QaSandboxPgRateLimiter(mock.sql).consume(`${prefix}${surface}:${kind}:${identity}`, quota, 60), 7);
        call(mock, "qa_sandbox_consume_rate_limit", [`qa-sandbox-${surface}:${kind}:${identity}`, quota, 60]);
      }
    }
  }
});

Deno.test("QA limiter refuses arbitrary surfaces, quotas and windows before any SQL", async () => {
  const mock = mockSql([{ wait: 0 }]);
  const limiter = new QaSandboxPgRateLimiter(mock.sql);
  for (const [bucket, quota, window] of [[`reconcile:user:${HOLDER}`, 11, 60], [`checkout:user:${HOLDER}`, 5, 30],
    [`set-entitlement:user:${HOLDER}`, 5, 60], [`qa-sandbox-analytics:user:${HOLDER}`, 5, 60],
    ["apple-access:ip:", 30, 60], ["apple-access:user:bad", 10, 60], ["reconcile:ip:" + "x".repeat(1024), 60, 60],
    ["checkout:ip:203.0.113.1\nother", 20, 60]] as const) await assertRejects(() => limiter.consume(bucket, quota, window));
  assertEquals(mock.calls, []);
});

Deno.test("QA limiter rejects malformed waits and hides raw driver address/account parameters", async () => {
  for (const rows of [[], [{ wait: "0" }], [{ wait: -1 }], [{ wait: 0.5 }], [{ wait: 61 }], [{ wait: 0 }, { wait: 0 }]]) {
    await assertRejects(() => new QaSandboxPgRateLimiter(mockSql(rows).sql).consume("reconcile:ip:203.0.113.1", 60, 60));
  }
  const thrown = await assertRejects(() => new QaSandboxPgRateLimiter(mockSql([], new Error(`raw driver ${HOLDER}`)).sql)
    .consume(`reconcile:user:${HOLDER}`, 10, 60), Error);
  assertEquals(thrown.message, "Rate limiter unavailable");
  assertEquals(thrown.cause, undefined);
  assertEquals(Object.keys(thrown), ["code"]);
  assertEquals(await new QaSandboxPgRateLimiter(mockSql([{ wait: 0 }]).sql).consume(`reconcile:user:${HOLDER}`, 10, 60), 0);
});
