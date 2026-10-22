// Real SQL rehearsal, disposable GitHub runner only. A skipped local run is not database proof.
import { assertEquals, assertRejects } from "@std/assert";
import { connection } from "./synthetic_settings_helpers.ts";
import { PgPurchaseOperationStore } from "../functions/_shared/purchase-operation-store.ts";

const url = Deno.env.get("STILL_PRODUCTION_CHECKOUT_TEST_DATABASE_URL");
const HOLDER = "b1111111-1111-4111-8111-111111111111", OTHER = "b2222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64), SESSION = "cs_live_SyntheticLedger";
const admission = { surface: "chrome_desktop" as const, build: "3.0.0.1" };
const PASSWORD = "production-checkout-synthetic-only";

Deno.test({ name: "production ledger: actual role isolation, sales admission, concurrency, recovery and deletion", ignore: !url, fn: async () => {
  if (Deno.env.get("GITHUB_ACTIONS") !== "true" || Deno.env.get("RUNNER_ENVIRONMENT") !== "github-hosted") throw new Error("Disposable hosted runner required");
  const admin = connection(url!);
  let writer: ReturnType<typeof connection> | undefined, qa: ReturnType<typeof connection> | undefined;
  try {
    const gate = await Deno.readTextFile(new URL("../../scripts/backend/deploy/verify/0026_production_purchase_operations.sql", import.meta.url));
    assertEquals((await admin.unsafe(gate))[0]!.issues, []);
    await admin`alter role still_entitlement_writer login password 'production-checkout-synthetic-only'`;
    await admin`alter role still_qa_sandbox_writer login password 'production-checkout-synthetic-only'`;
    writer = connection(url!, "still_entitlement_writer", PASSWORD);
    qa = connection(url!, "still_qa_sandbox_writer", PASSWORD);
    const store = new PgPurchaseOperationStore(writer, "production", admission);
    await admin`insert into auth.users(id,email,email_confirmed_at) values
      (${HOLDER}::uuid,'checkout-one@example.invalid',clock_timestamp()),(${OTHER}::uuid,'checkout-two@example.invalid',clock_timestamp())`;
    const id = crypto.randomUUID();
    await assertRejects(() => store.prepare(id, HOLDER, HASH)); // Missing policy is off.
    assertEquals(Number((await admin`select count(*) from private.production_purchase_operations`)[0]!.count), 0);

    const policy = async (revision: number, enabled: boolean, cutoff = false) => {
      const op = crypto.randomUUID();
      const body = { schema: 1, environment: "production", revision, salesEnabled: enabled,
        channels: { apple: { enabled: false, offer: "still-pro-v3" }, web: { enabled, offer: "still-pro-v3" } }, builds: [admission] };
      await admin.begin(async tx => {
        const rendered = (await tx`select private.product_policy_render('sales',${tx.json(body)}) as body`)[0]!.body;
        await tx`insert into private.product_policy_operations(operation_id,kind,namespace,environment,owner_subject,expected_revision,body,preview_hash,created_at,expires_at,status,applied_revision,applied_at)
          values(${op}::uuid,'apply','sales','production',${HOLDER}::uuid,${revision - 1},${rendered},${HASH},clock_timestamp(),clock_timestamp(),'applied',${revision},clock_timestamp())`;
        await tx`insert into private.product_policy_revisions(namespace,environment,revision,body,operation_id,published_at)
          values('sales','production',${revision},${rendered},${op}::uuid,clock_timestamp())`;
        if (cutoff) await tx`insert into private.paid_cutoff(environment,product,benefits,sales_revision,operation_id,activated_at)
          values('production','still-free-v2',array['facebook.reels','instagram.reels','tiktok.all','youtube.shorts'],${revision},${op}::uuid,clock_timestamp())`;
      });
    };
    await policy(1, true); // A policy alone cannot bypass the required free-feature cutoff.
    await assertRejects(() => store.prepare(id, HOLDER, HASH));
    await policy(2, true, true);
    await assertRejects(() => new PgPurchaseOperationStore(writer!, "production", { ...admission, build: "unapproved" }).prepare(id, HOLDER, HASH));
    await assertRejects(() => new PgPurchaseOperationStore(qa!, "production", admission).prepare(id, HOLDER, HASH));
    await assertRejects(() => writer!`select * from private.production_purchase_operations`);
    for (const role of ["anon", "authenticated", "service_role", "still_qa_sandbox_writer"]) {
      assertEquals((await admin`select has_function_privilege(${role},'public.production_prepare_checkout_operation(uuid,uuid,text,text,text)','execute') as allowed`)[0]!.allowed, false);
    }
    await admin`update auth.users set email_confirmed_at=null where id=${OTHER}::uuid`;
    await assertRejects(() => store.prepare(crypto.randomUUID(), OTHER, HASH));
    await admin`update auth.users set email_confirmed_at=clock_timestamp(),banned_until=clock_timestamp()+interval '1 hour' where id=${OTHER}::uuid`;
    await assertRejects(() => store.prepare(crypto.randomUUID(), OTHER, HASH));
    await admin`update auth.users set banned_until=null where id=${OTHER}::uuid`;
    const results = await Promise.all([store.prepare(id, HOLDER, HASH), store.prepare(crypto.randomUUID(), HOLDER, HASH)]);
    assertEquals(results[0]!.operation_id, results[1]!.operation_id);
    const op = results[0]!.operation_id;
    assertEquals(results[0]!.environment, "production");
    const claims = await Promise.all([store.claimCreation(op, HOLDER, HASH), store.claimCreation(op, HOLDER, HASH)]);
    assertEquals(claims.filter(claim => claim.claimed).length, 1);
    await assertRejects(() => store.claimCreation(op, HOLDER, "b".repeat(64)));
    assertEquals(await store.read(op, OTHER), null);
    await assertRejects(() => writer!`select public.production_bind_checkout_session(${op}::uuid,${HOLDER}::uuid,'cs_test_Wrong',${HASH})`);
    await store.recordStatus(op, null, "recovery_required");
    await policy(3, false);
    await assertRejects(() => store.claimCreation(op, HOLDER, HASH));
    await assertRejects(() => store.prepare(crypto.randomUUID(), OTHER, HASH));
    // Stopping sales cannot lose an already-created payment or prevent its reconciliation.
    await store.bindSession(op, HOLDER, SESSION, HASH);
    await store.recordStatus(op, SESSION, "paid_verified");
    await store.recordStatus(op, SESSION, "import_pending");
    await store.recordStatus(op, SESSION, "imported");
    await store.recordStatus(op, SESSION, "access_observed");
    await assertRejects(() => store.recordStatus(op, SESSION, "closed_unpaid"));
    await admin`delete from auth.users where id=${HOLDER}::uuid`;
    const detached = await store.recordDeletedAccountRefund(op, SESSION);
    assertEquals(detached.holder, null);
    assertEquals(detached.status, "refunded");
    assertEquals((await store.recordDeletedAccountRefund(op, SESSION)).operation_id, op);
    await assertRejects(() => store.recordStatus(op, SESSION, "import_pending"));
    assertEquals(Number((await admin`select count(*) from auth.users where id=${HOLDER}::uuid`)[0]!.count), 0);
    assertEquals(Number((await admin`select count(*) from private.qa_sandbox_purchase_operations`)[0]!.count), 0);
    assertEquals((await admin.unsafe(gate))[0]!.issues, []);
    // A same-named index with the wrong predicate must not pass the deployment gate.
    await admin.begin(async tx => {
      await tx`drop index private.production_one_open_checkout`;
      await tx`create unique index production_one_open_checkout on private.production_purchase_operations(holder) where status='prepared'`;
      assertEquals((await tx.unsafe(gate))[0]!.issues, ["one_open_operation_index"]);
      await tx`drop index private.production_one_open_checkout`;
      await tx`create unique index production_one_open_checkout on private.production_purchase_operations(holder) where status not in ('refunded','closed_unpaid')`;
    });
    assertEquals((await admin.unsafe(gate))[0]!.issues, []);
  } finally {
    await writer?.end(); await qa?.end(); await admin.end();
  }
} });
