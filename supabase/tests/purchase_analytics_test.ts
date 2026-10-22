// Disposable hosted database evidence. No provider traffic or production credentials.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connection } from "./synthetic_settings_helpers.ts";
import { PgPurchaseOperationStore } from "../functions/_shared/purchase-operation-store.ts";
import { PgPurchaseAnalyticsStore } from "../functions/analytics-purchase/store.ts";
const url = Deno.env.get("STILL_PRODUCTION_CHECKOUT_TEST_DATABASE_URL");
const HASH = "d".repeat(64), ORIGIN = "e".repeat(64), OTHER_ORIGIN = "f".repeat(64);
const PASSWORD = "purchase-analytics-synthetic-only";
const admission = { surface: "chrome_desktop" as const, build: "3.0.0.1" };

Deno.test({ name: "canonical web analytics: atomic attribution, scoped claims, stable refunds, erasure and role isolation", ignore: !url, fn: async () => {
  if (Deno.env.get("GITHUB_ACTIONS") !== "true" || Deno.env.get("RUNNER_ENVIRONMENT") !== "github-hosted") throw new Error("Disposable hosted runner required");
  const admin = connection(url!);
  let writer: ReturnType<typeof connection> | undefined, eraser: ReturnType<typeof connection> | undefined;
  try {
    const gate = await Deno.readTextFile(new URL("../../scripts/backend/deploy/verify/0028_purchase_analytics.sql",import.meta.url));
    assertEquals((await admin.unsafe(gate))[0]!.issues,[]);
    await admin`alter role still_entitlement_writer login password 'purchase-analytics-synthetic-only'`;
    await admin`alter role still_analytics_eraser login password 'purchase-analytics-synthetic-only'`;
    writer = connection(url!,"still_entitlement_writer",PASSWORD);
    eraser = connection(url!,"still_analytics_eraser",PASSWORD);
    const analytics = new PgPurchaseAnalyticsStore(eraser);
    const account = crypto.randomUUID(), subject = crypto.randomUUID(), otherSubject = crypto.randomUUID();
    await admin`insert into auth.users(id,email,email_confirmed_at) values (${account}::uuid,'analytics@example.invalid',clock_timestamp())`;
    for (const [id,origin] of [[subject,ORIGIN],[otherSubject,OTHER_ORIGIN]]) await admin`
      insert into private.analytics_subjects(subject_id,user_id,origin_key,epoch,created_at,last_activity_month)
      values(${id}::uuid,${account}::uuid,private.analytics_origin_key(decode(${origin},'hex')),0,clock_timestamp(),date_trunc('month',now())::date)`;
    // Publish only synthetic admission in this disposable database; existing test ordering does not matter.
    const revision = Number((await admin`select coalesce(max(revision),0)+1 as next from private.product_policy_revisions where namespace='sales' and environment='production'`)[0]!.next);
    const policyOp = crypto.randomUUID();
    const policy = { schema:1,environment:"production",revision,salesEnabled:true,
      channels:{apple:{enabled:false,offer:"still-pro-v3"},web:{enabled:true,offer:"still-pro-v3"}},builds:[admission] };
    await admin.begin(async tx => {
      const rendered = (await tx`select private.product_policy_render('sales',${tx.json(policy)}) as body`)[0]!.body;
      await tx`insert into private.product_policy_operations(operation_id,kind,namespace,environment,owner_subject,expected_revision,body,preview_hash,created_at,expires_at,status,applied_revision,applied_at)
       values(${policyOp}::uuid,'apply','sales','production',${account}::uuid,${revision-1},${rendered},${HASH},now(),now(),'applied',${revision},now())`;
      await tx`insert into private.product_policy_revisions(namespace,environment,revision,body,operation_id,published_at)
       values('sales','production',${revision},${rendered},${policyOp}::uuid,now())`;
      await tx`insert into private.paid_cutoff(environment,product,benefits,sales_revision,operation_id,activated_at)
       values('production','still-free-v2',array['facebook.reels','instagram.reels','tiktok.all','youtube.shorts'],${revision},${policyOp}::uuid,now()) on conflict do nothing`;
    });
    const payment = new PgPurchaseOperationStore(writer,"production",admission,ORIGIN);
    const otherDevice = new PgPurchaseOperationStore(writer,"production",admission,OTHER_ORIGIN);
    const operation = (await payment.prepare(crypto.randomUUID(),account,HASH)).operation_id;
    const claims = await Promise.all([payment.claimCreation(operation,account,HASH),otherDevice.claimCreation(operation,account,HASH)]);
    assertEquals(claims.filter(c => c.claimed).length,1);
    const origin = claims[0].claimed ? ORIGIN : OTHER_ORIGIN;
    const other = origin === ORIGIN ? OTHER_ORIGIN : ORIGIN;
    const originalSubject = origin === ORIGIN ? subject : otherSubject;
    assertEquals((await admin`select subject_id from private.purchase_analytics_attribution where operation_id=${operation}::uuid`)[0]!.subject_id,originalSubject);
    assertEquals(await analytics.claim(account,origin),null); // Prepared is not a sale.
    const session = "cs_live_AnalyticsSynthetic";
    await payment.bindSession(operation,account,session,HASH);
    assertEquals(await analytics.claim(account,origin),null); // A checkout return alone is not a sale.
    await payment.recordStatus(operation,session,"paid_verified");
    const paid = (await admin`select paid_at from private.production_purchase_operations where operation_id=${operation}::uuid`)[0]!.paid_at;
    await payment.recordStatus(operation,session,"refunded"); // Refund before first report: sale still precedes it.
    assertEquals(await analytics.claim(account,other),null);
    assertEquals(await analytics.claim(crypto.randomUUID(),origin),null);
    const sale = await analytics.claim(account,origin); assert(sale);
    assertEquals(sale.event,"purchase_recorded"); assertEquals(sale.at,new Date(paid).toISOString());
    assertEquals(await analytics.claim(account,origin),null); // In-flight lease excludes concurrent dispatch.
    assertEquals(await analytics.current(account,other,sale),false);
    assertEquals(await analytics.current(account,origin,sale),true);
    assertEquals(await analytics.finish(sale,false),true);
    const retry = await analytics.claim(account,origin); assert(retry);
    assertEquals(retry.id,sale.id); assertEquals(retry.at,sale.at);
    assertEquals(await analytics.finish(sale,true),false); // Stale token cannot clear the successor.
    assertEquals(await analytics.current(account,origin,retry),true);
    assertEquals(await analytics.finish(retry,true),true);
    const refund = await analytics.claim(account,origin); assert(refund);
    assertEquals(refund.event,"purchase_refunded"); assert(refund.id!==sale.id);
    await payment.recordStatus(operation,session,"refunded");
    await payment.bindSession(operation,account,session,HASH); // Late recovery bind must not change refund event time.
    await admin`update private.purchase_analytics_attribution set claim_until=clock_timestamp()-interval '1 second' where operation_id=${operation}::uuid`;
    assertEquals(await analytics.current(account,origin,refund),false);
    assertEquals(await analytics.finish(refund,true),false);
    const refundRetry = await analytics.claim(account,origin); assert(refundRetry);
    assertEquals(refundRetry.id,refund.id); assertEquals(refundRetry.at,refund.at);
    await admin`update private.analytics_subjects set retired_at=now(),retired_reason='device_erasure' where subject_id=${originalSubject}::uuid`;
    assertEquals(await analytics.current(account,origin,refundRetry),false);
    await analytics.finish(refundRetry,false);
    assertEquals(await analytics.claim(account,origin),null);
    // An unattributed checkout cannot acquire attribution on retry, even from a new consenting device.
    const plain = new PgPurchaseOperationStore(writer,"production",admission);
    const untracked = (await plain.prepare(crypto.randomUUID(),account,HASH)).operation_id;
    await plain.claimCreation(untracked,account,HASH);
    await new PgPurchaseOperationStore(writer,"production",admission,other).claimCreation(untracked,account,HASH);
    assertEquals(Number((await admin`select count(*) from private.purchase_analytics_attribution where operation_id=${untracked}::uuid`)[0]!.count),0);
    // A locked optional row must never block a canonical refund. This is a real second SQL session.
    const blockedSession = "cs_live_AnalyticsLocked";
    await plain.bindSession(untracked,account,blockedSession,HASH);
    await plain.recordStatus(untracked,blockedSession,"paid_verified");
    const remainingSubject = origin === ORIGIN ? otherSubject : subject;
    await admin`insert into private.purchase_analytics_attribution(operation_id,subject_id,surface,app_version)
      values(${untracked}::uuid,${remainingSubject}::uuid,'chrome','3.0.0.1')`;
    await admin.begin(async tx => {
      await tx`select 1 from private.purchase_analytics_attribution where operation_id=${untracked}::uuid for update`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([plain.recordStatus(untracked,blockedSession,"refunded"),
          new Promise<null>(resolve => { timer=setTimeout(() => resolve(null),750); })]);
        assert(outcome,"Optional attribution lock delayed payment refund");
        assertEquals(outcome.status,"refunded");
      } finally { clearTimeout(timer); }
    });
    assertEquals((await admin`select refunded_at from private.purchase_analytics_attribution where operation_id=${untracked}::uuid`)[0]!.refunded_at,null);
    const optionalSale = await analytics.claim(account,other); assert(optionalSale);
    assertEquals(optionalSale.event,"purchase_recorded"); await analytics.finish(optionalSale,true);
    assertEquals(await analytics.claim(account,other),null); // No invented timestamp after the skipped optional write.
    for (const role of ['anon','authenticated','service_role','still_qa_sandbox_writer']) {
      assertEquals((await admin`select has_function_privilege(${role},'public.production_claim_checkout_with_analytics(uuid,uuid,text,text,text,text)','execute') as allowed`)[0]!.allowed,false);
      assertEquals((await admin`select has_function_privilege(${role},'private.analytics_claim_purchase(uuid,text)','execute') as allowed`)[0]!.allowed,false);
    }
    await assertRejects(() => writer!`select private.analytics_claim_purchase(${account}::uuid,${origin})`);
    await assertRejects(() => eraser!`select * from private.purchase_analytics_attribution`);
    await admin`delete from auth.users where id=${account}::uuid`;
    assertEquals(Number((await admin`select count(*) from private.purchase_analytics_attribution where operation_id=${operation}::uuid`)[0]!.count),0);
    assertEquals((await admin`select holder,status from private.production_purchase_operations where operation_id=${operation}::uuid`)[0],{holder:null,status:'refunded'});
    assertEquals(await analytics.finish(refundRetry,true),false); // Erased rows cannot be recreated by delayed completions.
    assertEquals((await admin.unsafe(gate))[0]!.issues,[]);
  } finally { await writer?.end(); await eraser?.end(); await admin.end(); }
} });
