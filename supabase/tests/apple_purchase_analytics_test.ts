// Disposable GitHub-hosted PostgreSQL proof; never a live account or provider request.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connection } from "./synthetic_settings_helpers.ts";
import { PgAppleAnalyticsStore } from "../functions/analytics-apple-purchase/store.ts";
import type { VerifiedAppleTransaction } from "../functions/_shared/apple-access.ts";
const url = Deno.env.get("STILL_PRODUCTION_CHECKOUT_TEST_DATABASE_URL");
const hash = (n: number) => n.toString(16).padStart(64, "0");
const password = "apple-analytics-synthetic-only";
Deno.test({
  name:
    "Apple canonical attribution: original scope, expiry, stable refund, erasure and SQL isolation",
  ignore: !url,
  fn: async () => {
    if (
      Deno.env.get("GITHUB_ACTIONS") !== "true" ||
      Deno.env.get("RUNNER_ENVIRONMENT") !== "github-hosted"
    ) throw new Error("Disposable hosted runner required");
    const admin = connection(url!);
    let eraser: ReturnType<typeof connection> | undefined;
    try {
      await admin`alter role still_analytics_eraser login password 'apple-analytics-synthetic-only'`;
      eraser = connection(url!, "still_analytics_eraser", password);
      const store = new PgAppleAnalyticsStore(eraser);
      const scope = {
        originProof: hash(101),
        projectKeySha256: hash(102),
        holder: null,
        anonIndex: 0,
      };
      assert(await store.prepare(hash(1), scope, "app-ios", "3.0.0"));
      assert(await store.prepare(hash(2), scope, "app-ios", "3.0.0"));
      assertEquals(
        await store.prepare(hash(3), scope, "app-ios", "3.0.0"),
        false,
      );
      assertEquals(await store.read(hash(1), { ...scope, anonIndex: 1 }), null);
      assertEquals(
        await store.read(hash(1), { ...scope, originProof: hash(999) }),
        null,
      );
      assertEquals(
        await store.read(hash(1), { ...scope, projectKeySha256: hash(999) }),
        null,
      );
      const paid = Date.now();
      const tx: VerifiedAppleTransaction = {
        key: hash(201),
        environment: "production",
        bundleId: "com.chartash.still",
        productId: "still_pro_v3",
        originalTransactionId: "123",
        transactionId: "124",
        active: true,
        purchasedAt: paid,
      };
      await admin`update private.apple_purchase_analytics set prepared_at=to_timestamp(${paid}/1000.0)-interval '1 second',expires_at=clock_timestamp()+interval '1 minute' where capability_hash=${
        hash(1)
      }`;
      assertEquals(
        await store.commit(hash(1), scope, { ...tx, environment: "sandbox" }),
        null,
      );
      assertEquals(
        await store.commit(hash(1), scope, {
          ...tx,
          purchasedAt: paid - 20_000,
        }),
        null,
      );
      assertEquals(
        await store.commit(
          hash(1),
          scope,
          { ...tx, key: null } as unknown as VerifiedAppleTransaction,
        ),
        null,
      );
      const bound = await store.commit(hash(1), scope, tx);
      assert(bound);
      assertEquals(bound.purchasedAt, paid);
      // Another prepared capability cannot claim the same canonical transaction.
      await admin`update private.apple_purchase_analytics set prepared_at=to_timestamp(${paid}/1000.0)-interval '1 second' where capability_hash=${
        hash(2)
      }`;
      assertEquals(await store.commit(hash(2), scope, tx), null);
      // Ten-minute intent expiry does not expire bound refund observation.
      await admin`update private.apple_purchase_analytics set expires_at=clock_timestamp()-interval '1 second' where capability_hash in (${
        hash(1)
      },${hash(2)})`;
      assertEquals(await store.read(hash(2), scope), null);
      assertEquals(
        await store.commit(hash(2), scope, { ...tx, key: hash(202) }),
        null,
      );
      assert(await store.read(hash(1), scope));
      const refunded = await store.commit(hash(1), scope, {
        ...tx,
        active: false,
        fullRefundAt: paid,
      });
      assert(refunded);
      assertEquals(refunded.refundedAt, paid);
      assertEquals(refunded.saleId, bound.saleId);
      const retried = await store.commit(hash(1), scope, {
        ...tx,
        active: false,
        fullRefundAt: Date.now(),
      });
      assert(retried);
      assertEquals(retried.refundId, refunded.refundId);
      assertEquals(retried.refundedAt, paid);
      assertEquals(
        await store.commit(hash(1), scope, { ...tx, transactionId: "125" }),
        null,
      );
      // Expiry is evaluated at final commit, independently of any earlier provider read.
      const expiring = { ...scope, originProof: hash(103) };
      assert(await store.prepare(hash(4), expiring, "app-macos", "3.0.0"));
      assert(await store.read(hash(4), expiring));
      await admin`update private.apple_purchase_analytics set expires_at=clock_timestamp()-interval '1 second' where capability_hash=${
        hash(4)
      }`;
      assertEquals(
        await store.commit(hash(4), expiring, { ...tx, key: hash(204) }),
        null,
      );
      // Device deletion fences even a provider completion already in flight; cleanup cannot revive it.
      await admin`insert into private.analytics_erasure_jobs(job_id,scope,scope_key,stage,sweeps,attempts,priority,next_attempt_at,created_at)
      values(${crypto.randomUUID()}::uuid,'device',private.analytics_origin_key(decode(${scope.originProof},'hex')),'stop_recorded',0,0,1,clock_timestamp(),clock_timestamp())`;
      assertEquals(
        (await admin`select retired from private.apple_purchase_analytics where capability_hash=${
          hash(1)
        }`)[0].retired,
        true,
      );
      await assertRejects(() => store.commit(hash(1), scope, tx));
      await eraser`select private.apple_analytics_cleanup()`;
      await assertRejects(() =>
        store.prepare(hash(5), scope, "app-ios", "3.0.0")
      );
      // Signed-in capability is tied to the original active subject, with cascade on deletion.
      const user = crypto.randomUUID(), subject = crypto.randomUUID();
      const signed = {
        ...scope,
        originProof: hash(104),
        holder: user,
        anonIndex: null,
      };
      await admin`insert into auth.users(id,email,email_confirmed_at) values(${user}::uuid,'apple-analytics@example.invalid',clock_timestamp())`;
      await admin`insert into private.analytics_subjects(subject_id,user_id,origin_key,epoch,created_at,last_activity_month)
      values(${subject}::uuid,${user}::uuid,private.analytics_origin_key(decode(${signed.originProof},'hex')),0,clock_timestamp(),date_trunc('month',now())::date)`;
      assert(await store.prepare(hash(6), signed, "app-ios", "3.0.0"));
      assertEquals(
        await store.read(hash(6), { ...signed, holder: null, anonIndex: 0 }),
        null,
      );
      await admin`update private.analytics_subjects set retired_at=clock_timestamp(),retired_reason='device_erasure' where subject_id=${subject}::uuid`;
      await assertRejects(() => store.read(hash(6), signed));
      await admin`delete from auth.users where id=${user}::uuid`;
      assertEquals(
        Number(
          (await admin`select count(*) from private.apple_purchase_analytics where capability_hash=${
            hash(6)
          }`)[0].count,
        ),
        0,
      );
      // Expired bound records are removed without an originating-device return or a provider call.
      const old = { ...scope, originProof: hash(105) };
      assert(await store.prepare(hash(7), old, "app-ios", "3.0.0"));
      await admin`update private.apple_purchase_analytics set transaction_key=${
        hash(207)
      },transaction=${
        admin.json(tx)
      },purchased_at=extract(epoch from clock_timestamp()-interval '91 days')*1000 where capability_hash=${
        hash(7)
      }`;
      assertEquals(await store.read(hash(7), old), null);
      await eraser`select private.apple_analytics_cleanup()`;
      assertEquals(
        Number(
          (await admin`select count(*) from private.apple_purchase_analytics where capability_hash=${
            hash(7)
          }`)[0].count,
        ),
        0,
      );
      for (
        const role of [
          "anon",
          "authenticated",
          "service_role",
          "still_entitlement_writer",
          "still_qa_sandbox_writer",
        ]
      ) {
        assertEquals(
          (await admin`select has_function_privilege(${role},'private.apple_analytics_prepare(text,text,uuid,integer,text,text,text)','execute') as allowed`)[
            0
          ].allowed,
          false,
        );
        assertEquals(
          (await admin`select has_table_privilege(${role},'private.apple_purchase_analytics','select') as allowed`)[
            0
          ].allowed,
          false,
        );
      }
      await assertRejects(() =>
        eraser!`select * from private.apple_purchase_analytics`
      );
      assertEquals(
        (await admin`select relrowsecurity from pg_class where oid='private.apple_purchase_analytics'::regclass`)[
          0
        ].relrowsecurity,
        true,
      );
      // Global anonymous capacity is fixed, including callers that rotate their origin proof.
      await admin`insert into private.apple_purchase_analytics(capability_hash,origin_key,anon_index,project_hash,surface,app_version)
      select lpad(to_hex(10000+i),64,'0'),decode(${
        hash(106)
      },'hex'),0,${scope.projectKeySha256},'app-ios','3.0.0' from generate_series(1,2048) i`;
      assertEquals(
        await store.prepare(
          hash(8),
          { ...scope, originProof: hash(107) },
          "app-ios",
          "3.0.0",
        ),
        false,
      );
      await admin`delete from private.apple_purchase_analytics where origin_key=decode(${
        hash(106)
      },'hex')`;
    } finally {
      await eraser?.end();
      await admin.end();
    }
  },
});
