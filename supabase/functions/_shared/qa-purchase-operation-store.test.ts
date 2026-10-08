import { assertEquals, assertRejects } from "@std/assert";
import { PgQaPurchaseOperationStore, type QaPurchaseOperation, type QaPurchaseOperationStatus } from "./qa-purchase-operation-store.ts";
type Sql = ConstructorParameters<typeof PgQaPurchaseOperationStore>[0];
const OP = "11111111-1111-1111-1111-111111111111";
const HOLDER = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";
const HASH = "a".repeat(64), SESSION = "cs_test_synthetic", TIME = "2026-10-08T18:30:00.123456+00:00";
function operation(patch: Partial<QaPurchaseOperation> = {}): QaPurchaseOperation {
  return { operation_id: OP, holder: HOLDER, environment: "sandbox", configuration_hash: HASH,
    stripe_session_id: null, status: "prepared", creation_started_at: null, paid_at: null,
    created_at: TIME, updated_at: TIME, ...patch };
}
const claimed = () => operation({ creation_started_at: TIME });
const bound = () => operation({ creation_started_at: TIME, stripe_session_id: SESSION, status: "session_bound" });
type Call = { text: string; values: unknown[] };
function fixture(raw: unknown, directRows = false) {
  const calls: Call[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return Promise.resolve(directRows ? raw : [{ result: raw }]);
  }) as unknown as Sql;
  return { store: new PgQaPurchaseOperationStore(sql), calls };
}
function expected(rpc: string, values: unknown[], casts: string[]) {
  return { text: `select public.${rpc}(${casts.map((cast) => `?${cast}`).join(", ")}) as result`, values };
}

Deno.test("prepare binds the exact fixed QA RPC and immutable scope", async () => {
  const f = fixture(operation());
  assertEquals(await f.store.prepare(OP, HOLDER, HASH), operation());
  assertEquals(f.calls, [expected("qa_sandbox_prepare_checkout_operation", [OP, HOLDER, HASH], ["::uuid", "::uuid", ""])]);
});
Deno.test("prepare recovers a different unresolved operation ID only under the same holder/configuration", async () => {
  for (const row of [operation({ operation_id: OTHER }), operation({ ...bound(), operation_id: OTHER }),
    operation({ operation_id: OTHER, creation_started_at: TIME, status: "recovery_required" })]) {
    assertEquals(await fixture(row).store.prepare(OP, HOLDER, HASH), row);
  }
  for (const patch of [{ holder: OTHER }, { configuration_hash: "b".repeat(64) },
    { operation_id: OTHER, stripe_session_id: SESSION, creation_started_at: TIME, status: "refunded", paid_at: TIME },
    { operation_id: OTHER, stripe_session_id: SESSION, creation_started_at: TIME, status: "closed_unpaid" }]) {
    await assertRejects(() => fixture(operation(patch as Partial<QaPurchaseOperation>)).store.prepare(OP, HOLDER, HASH));
  }
});
Deno.test("same-ID terminal prepare remains readable without implying permission for another charge", async () => {
  for (const row of [operation({ ...bound(), status: "closed_unpaid" }), operation({ ...bound(), status: "refunded", paid_at: TIME })]) {
    assertEquals(await fixture(row).store.prepare(OP, HOLDER, HASH), row);
  }
});
Deno.test("creation claim sends exact CAS RPC and preserves both outcomes without retry/release", async () => {
  for (const outcome of [true, false]) {
    const f = fixture({ operation: claimed(), claimed: outcome });
    assertEquals(await f.store.claimCreation(OP, HOLDER, HASH), { operation: claimed(), claimed: outcome });
    assertEquals(f.calls, [expected("qa_sandbox_claim_checkout_creation", [OP, HOLDER, HASH], ["::uuid", "::uuid", ""])]);
  }
  const f = fixture({ operation: bound(), claimed: false });
  assertEquals(await f.store.claimCreation(OP, HOLDER, HASH), { operation: bound(), claimed: false });
  assertEquals(f.calls.length, 1);
});
Deno.test("CAS result rejects invented permission, unstarted fence, different scope and malformed claims", async () => {
  for (const raw of [null, [], { operation: claimed(), claimed: "true" }, { operation: claimed() },
    { operation: claimed(), claimed: true, release: true }, { operation: operation(), claimed: true },
    { operation: operation(), claimed: false }, { operation: bound(), claimed: true },
    { operation: operation({ ...claimed(), operation_id: OTHER }), claimed: false },
    { operation: operation({ ...claimed(), holder: OTHER }), claimed: false },
    { operation: operation({ ...claimed(), configuration_hash: "b".repeat(64) }), claimed: false },
    { operation: operation({ ...bound(), status: "recovery_required" }), claimed: true }]) {
    await assertRejects(() => fixture(raw).store.claimCreation(OP, HOLDER, HASH));
  }
});
Deno.test("bind Session uses claimed exact operation/config and never creates a replacement", async () => {
  const f = fixture(bound());
  assertEquals(await f.store.bindSession(OP, HOLDER, SESSION, HASH), bound());
  assertEquals(f.calls, [expected("qa_sandbox_bind_checkout_session", [OP, HOLDER, SESSION, HASH], ["::uuid", "::uuid", "", ""])]);
  for (const patch of [{ operation_id: OTHER }, { holder: OTHER }, { configuration_hash: "b".repeat(64) },
    { stripe_session_id: "cs_test_other" }, { creation_started_at: null }]) {
    await assertRejects(() => fixture(operation({ ...bound(), ...patch })).store.bindSession(OP, HOLDER, SESSION, HASH));
  }
});
Deno.test("disabled-known recovery read distinguishes SQL NULL from an unavailable/malformed receipt", async () => {
  const f = fixture(null);
  assertEquals(await f.store.read(OP, HOLDER), null);
  assertEquals(f.calls, [expected("qa_sandbox_read_checkout_operation", [OP, HOLDER], ["::uuid", "::uuid"])]);
  for (const raw of [undefined, false, "null", [], {}, { ...bound(), holder: OTHER }, { ...bound(), operation_id: OTHER }]) {
    await assertRejects(() => fixture(raw).store.read(OP, HOLDER));
  }
  assertEquals(await fixture(operation({ ...bound(), status: "refunded", paid_at: TIME })).store.read(OP, HOLDER),
    operation({ ...bound(), status: "refunded", paid_at: TIME }));
});
Deno.test("recordStatus uses exact existing binding and retains paid state through recovery and refund", async () => {
  for (const status of ["paid_verified", "import_pending", "imported", "access_observed", "recovery_required", "refunded"] as const) {
    const row = operation({ ...bound(), status, paid_at: TIME });
    const f = fixture(row);
    assertEquals(await f.store.recordStatus(OP, SESSION, status), row);
    assertEquals(f.calls, [expected("qa_sandbox_record_checkout_status", [OP, SESSION, status], ["::uuid", "", ""])]);
  }
});
Deno.test("NULL Session permits only fenced unbound recovery, never paid/import/refund/closure", async () => {
  const row = operation({ ...claimed(), status: "recovery_required" });
  const f = fixture(row);
  assertEquals(await f.store.recordStatus(OP, null, "recovery_required"), row);
  assertEquals(f.calls, [expected("qa_sandbox_record_checkout_status", [OP, null, "recovery_required"], ["::uuid", "", ""])]);
  for (const status of ["prepared", "session_bound", "paid_verified", "import_pending", "imported", "access_observed", "refunded", "closed_unpaid"] as const) {
    const invalid = fixture(row);
    await assertRejects(() => invalid.store.recordStatus(OP, null, status));
    assertEquals(invalid.calls, []);
  }
  await assertRejects(() => fixture(operation({ status: "recovery_required" })).store.recordStatus(OP, null, "recovery_required"));
});
Deno.test("closed unpaid requires exact known binding and no canonical paid_at", async () => {
  const row = operation({ ...bound(), status: "closed_unpaid" });
  assertEquals(await fixture(row).store.recordStatus(OP, SESSION, "closed_unpaid"), row);
  await assertRejects(() => fixture(operation({ ...row, paid_at: TIME })).store.recordStatus(OP, SESSION, "closed_unpaid"));
});
Deno.test("status acknowledgements cannot change operation, Session, requested status or environment", async () => {
  for (const raw of [{ ...bound(), operation_id: OTHER }, { ...bound(), stripe_session_id: "cs_test_other" },
    { ...bound(), environment: "production" }, { ...bound(), status: "recovery_required" }]) {
    await assertRejects(() => fixture(raw).store.recordStatus(OP, SESSION, "session_bound"));
  }
});
Deno.test("receipt validation rejects malformed and open rows rather than trusting DB JSON", async () => {
  const valid = operation();
  const patches = [{ environment: "production" }, { environment: "Sandbox" }, { operation_id: "not-a-uuid" },
    { holder: "not-a-uuid" }, { configuration_hash: "a".repeat(63) }, { configuration_hash: "A".repeat(64) },
    { status: "paid" }, { stripe_session_id: "cs_live_other" }, { stripe_session_id: "cs_test_" },
    { stripe_session_id: "cs_test_" + "a".repeat(241) }, { status: "session_bound", stripe_session_id: null },
    { status: "prepared", paid_at: TIME }, { creation_started_at: false }, { paid_at: 123 },
    { created_at: null }, { updated_at: "2026-02-30T12:00:00Z" }, { created_at: "2026-10-08" },
    { created_at: "infinity" }, { created_at: "2026-10-08T25:00:00Z" }, { extra: "unexpected" }];
  for (const patch of patches) await assertRejects(() => fixture({ ...valid, ...patch }).store.read(OP, HOLDER));
  for (const key of Object.keys(valid)) {
    const raw: Record<string, unknown> = { ...valid }; delete raw[key];
    await assertRejects(() => fixture(raw).store.read(OP, HOLDER));
  }
  for (const status of ["paid_verified", "import_pending", "imported", "access_observed", "refunded"] as const) {
    await assertRejects(() => fixture(operation({ ...bound(), status })).store.read(OP, HOLDER));
  }
});
Deno.test("missing/multiple SQL rows never mean absence or creation permission", async () => {
  for (const rows of [[], [{ result: operation() }, { result: operation() }], [{}], [{ result: operation(), unexpected: true }], [null], null]) {
    await assertRejects(() => fixture(rows, true).store.read(OP, HOLDER));
    await assertRejects(() => fixture(rows, true).store.prepare(OP, HOLDER, HASH));
    await assertRejects(() => fixture(rows, true).store.claimCreation(OP, HOLDER, HASH));
  }
});
Deno.test("invalid caller scope is denied before SQL, and UUID comparison is canonical", async () => {
  const f = fixture(operation());
  for (const [op, holder, hash] of [["bad", HOLDER, HASH], [OP, "bad", HASH], [OP, HOLDER, "short"]]) {
    await assertRejects(() => f.store.prepare(op!, holder!, hash!));
    await assertRejects(() => f.store.claimCreation(op!, holder!, hash!));
    await assertRejects(() => f.store.bindSession(op!, holder!, SESSION, hash!));
  }
  for (const session of ["cs_live_other", "cs_test_", "cs_test_bad\n", "cs_test_" + "a".repeat(241)]) {
    await assertRejects(() => f.store.bindSession(OP, HOLDER, session, HASH));
    await assertRejects(() => f.store.recordStatus(OP, session, "recovery_required"));
  }
  await assertRejects(() => f.store.recordStatus(OP, SESSION, "new" as QaPurchaseOperationStatus));
  assertEquals(f.calls, []);
  const upper = "ABCDEF01-ABCD-ABCD-ABCD-ABCDEF012345";
  const row = operation({ operation_id: upper.toLowerCase(), holder: upper.toLowerCase() });
  assertEquals(await fixture(row).store.prepare(upper, upper, HASH), row);
});
Deno.test("driver failure is sanitized without releasing or retrying the unknown attempt", async () => {
  let calls = 0;
  const sql = (() => { calls++; throw new Error("private SQL credential and account parameters"); }) as unknown as Sql;
  const store = new PgQaPurchaseOperationStore(sql);
  for (const run of [() => store.prepare(OP, HOLDER, HASH), () => store.claimCreation(OP, HOLDER, HASH),
    () => store.bindSession(OP, HOLDER, SESSION, HASH), () => store.read(OP, HOLDER),
    () => store.recordStatus(OP, SESSION, "recovery_required")]) {
    const error = await assertRejects(run, Error, "QA purchase operation unavailable");
    assertEquals(error.message, "QA purchase operation unavailable");
    assertEquals((error as Error & { code: string }).code, "qa_purchase_operation_unavailable");
    assertEquals(error.cause, undefined);
  }
  assertEquals(calls, 5);
});
