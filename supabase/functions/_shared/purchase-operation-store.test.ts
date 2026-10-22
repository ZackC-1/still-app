import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { PgPurchaseOperationStore, type PurchaseOperation } from "./purchase-operation-store.ts";

const OP = "11111111-1111-1111-1111-111111111111", HOLDER = "22222222-2222-2222-2222-222222222222";
const HASH = "a".repeat(64), SESSION = "cs_live_Synthetic", TIME = "2026-10-21T20:00:00Z";
const base: PurchaseOperation<"production"> = { operation_id: OP, holder: HOLDER, environment: "production", configuration_hash: HASH,
  stripe_session_id: null, status: "prepared", creation_started_at: null, paid_at: null, created_at: TIME, updated_at: TIME };
const bound = { ...base, stripe_session_id: SESSION, creation_started_at: TIME, status: "session_bound" as const };
type Sql = ConstructorParameters<typeof PgPurchaseOperationStore>[0];
function fixture(value: unknown, admission = { surface: "chrome_desktop" as const, build: "3.0.0.1" }) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return Promise.resolve([{ result: value }]);
  }) as unknown as Sql;
  return { store: new PgPurchaseOperationStore(sql, "production", admission), calls, sql };
}

Deno.test("production prepare and creation claim use fixed production RPCs with frozen release admission", async () => {
  const admission = { surface: "chrome_desktop" as const, build: "3.0.0.1" };
  const f = fixture(base, admission);
  admission.build = "unapproved";
  assertEquals(await f.store.prepare(OP, HOLDER, HASH), base);
  assertEquals(f.calls, [{ text: "select public.production_prepare_checkout_operation(?::uuid, ?::uuid, ?, ?, ?) as result", values: [OP, HOLDER, HASH, "chrome_desktop", "3.0.0.1"] }]);
  const claim = fixture({ operation: { ...base, creation_started_at: TIME }, claimed: true });
  assertEquals((await claim.store.claimCreation(OP, HOLDER, HASH)).claimed, true);
  assertEquals(claim.calls[0]!.text, "select public.production_claim_checkout_creation(?::uuid, ?::uuid, ?, ?, ?) as result");
});

Deno.test("production read bind and status updates never invoke QA RPCs", async () => {
  const f = fixture(bound);
  assertEquals(await f.store.read(OP, HOLDER), bound);
  assertEquals(await f.store.bindSession(OP, HOLDER, SESSION, HASH), bound);
  assertEquals(await f.store.recordStatus(OP, SESSION, "session_bound"), bound);
  assertEquals(f.calls.map(call => call.text.split("(")[0]), ["select public.production_read_checkout_operation", "select public.production_bind_checkout_session", "select public.production_record_checkout_status"]);
});

Deno.test("production store rejects sandbox receipts and session identifiers", async () => {
  for (const patch of [{ environment: "sandbox" }, { stripe_session_id: "cs_test_Synthetic" }]) {
    await assertRejects(() => fixture({ ...bound, ...patch }).store.read(OP, HOLDER));
  }
  const f = fixture(bound);
  await assertRejects(() => f.store.bindSession(OP, HOLDER, "cs_test_Synthetic", HASH));
  await assertRejects(() => f.store.recordStatus(OP, "cs_test_Synthetic", "refunded"));
  assertEquals(f.calls, []);
});

Deno.test("production refund after account deletion preserves a detached receipt and cannot recreate its holder", async () => {
  const detached = { ...bound, holder: null, status: "refunded" as const, paid_at: TIME };
  const f = fixture(detached);
  assertEquals(await f.store.recordDeletedAccountRefund(OP, SESSION), detached);
  assertEquals(f.calls[0]!.text, "select public.production_record_checkout_status(?::uuid, ?, 'refunded') as result");
  await assertRejects(() => fixture({ ...detached, holder: HOLDER }).store.recordDeletedAccountRefund(OP, SESSION));
  await assertRejects(() => fixture(detached).store.read(OP, HOLDER));
});

Deno.test("production admission refuses unsupported surfaces and malformed builds", () => {
  const sql = fixture(null).sql;
  for (const surface of ["firefox_android", "edge_desktop", "apple_mobile_host", "", undefined]) {
    assertThrows(() => new PgPurchaseOperationStore(sql, "production", { surface, build: "3.0.0" } as never));
  }
  for (const build of ["", "X", "3.0.0\n", "x".repeat(97)]) {
    assertThrows(() => new PgPurchaseOperationStore(sql, "production", { surface: "chrome_desktop", build }));
  }
});

Deno.test("original analytics is attached through the single atomic creation claim RPC",async () => {
  const f=fixture({ operation: { ...base,creation_started_at: TIME },claimed:true });
  const store=new PgPurchaseOperationStore(f.sql,"production",{ surface:"chrome_desktop",build:"3.0.0.1" },"b".repeat(64));
  assertEquals((await store.claimCreation(OP,HOLDER,HASH)).claimed,true);
  assertEquals(f.calls,[{ text:"select public.production_claim_checkout_with_analytics(?::uuid, ?::uuid, ?, ?, ?, ?) as result",values:[OP,HOLDER,HASH,"chrome_desktop","3.0.0.1","b".repeat(64)] }]);
});
