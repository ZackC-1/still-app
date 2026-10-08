// Ephemeral GitHub-hosted Supabase ONLY. Ignored on the owner's Mac; mocks are not provider proof.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connection } from "./synthetic_settings_helpers.ts";
import { PgAppleAccessStore, type AppleAccessCommit } from "../functions/_shared/apple-access-store.ts";
import { PgAccessRightStore } from "../functions/_shared/pg-access-store.ts";
import type { VerifiedAppleTransaction } from "../functions/_shared/apple-access.ts";
const target = Deno.env.get("STILL_ACCESS_TEST_DATABASE_URL");
const enabled = !!target && Deno.env.get("GITHUB_ACTIONS") === "true" && Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted" && Deno.build.os === "linux";
if (Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1" && !enabled) throw new Error("required-cloud-tests-disabled");
const A = "a2020202-0000-4000-8000-000000000001", B = "b2020202-0000-4000-8000-000000000002";
const tx: VerifiedAppleTransaction = { key: "b".repeat(64), environment: "sandbox", bundleId: "com.example.still",
 productId: "still_pro_v3", originalTransactionId: "900719925474099312345", transactionId: "12345", active: true };
const rcKeys = ["c".repeat(64), "d".repeat(64)];
const revokedFirst = { ...tx, key: "e".repeat(64), originalTransactionId: "23456", transactionId: "23456", active: false };
function granted(result: AppleAccessCommit) {
 assert("right" in result); return result.right;
}
Deno.test({ name: "Apple ledger runtime: anonymous right, explicit ownership, exact replay, transfer, refund, deletion and ACL fences", ignore: !enabled, fn: async t => {
 const admin = connection(target!);
    try {
      const fixtureRows =
        await admin`select count(*)::int as count from private.access_rights where provider_key in (${tx.key},${revokedFirst.key},${
          rcKeys[0]
        },${rcKeys[1]})`;
      assertEquals(
        fixtureRows[0]?.count,
        0,
        "synthetic fixture keys already present",
      );
    } catch (error) {
      await admin.end();
      throw error;
    }
 await admin`alter role still_entitlement_writer login password 'apple-synthetic-writer-only'`;
 const writer = connection(target!, "still_entitlement_writer", "apple-synthetic-writer-only");
 const local = new PgAppleAccessStore(writer, "sandbox"), account = new PgAccessRightStore(writer);
 let rightId = ""; let operation = crypto.randomUUID();
 try {
  await admin`insert into auth.users(id,email,email_confirmed_at) values(${A}::uuid,'apple-a@example.invalid',now()),(${B}::uuid,'apple-b@example.invalid',now())`;
      await t.step(
        "actual retained limiter admits Apple IP and account buckets and preserves policy/privacy/ACL",
        async () => {
          const ip = "apple-access:ip:198.51.100.202";
          assertEquals(
            (await writer`select public.consume_rate_limit(${ip},1,60) as retry`)[
              0
            ]?.retry,
            0,
          );
          assert(
            Number(
              (await writer`select public.consume_rate_limit(${ip},1,60) as retry`)[
                0
              ]?.retry,
            ) > 0,
          );
          assertEquals(
            (await writer`select public.consume_rate_limit(${
              "apple-access:user:" + A
            },10,60) as retry`)[0]?.retry,
            0,
          );
          for (
            const [bucket, max, window] of [
              ["unreviewed:ip:198.51.100.203", 1, 60],
              [ip, 0, 60],
              [ip, 10001, 60],
              [ip, 1, 1],
              ["apple-access:user:00000000-0000-4000-8000-000000000000", 1, 60],
            ] as const
          ) {
            await assertRejects(() =>
              writer`select public.consume_rate_limit(${bucket},${max},${window})`
            );
          }
          const counters =
            await admin`select bucket_key from public.rate_limit_counters where bucket_key like 'apple-access:%'`;
          assert(counters.length > 0);
          for (const counter of counters) {
            assert(
              /^apple-access:(ip|user):[0-9a-f]{64}$/.test(counter.bucket_key),
            );
            assert(
              !counter.bucket_key.includes(A) &&
                !counter.bucket_key.includes("198.51.100"),
            );
          }
          for (const role of ["anon", "authenticated", "service_role"]) {
            assertEquals(
              (await admin`select has_function_privilege(${role},'public.consume_rate_limit(text,integer,integer)','EXECUTE') as allowed`)[
                0
              ]?.allowed,
              false,
            );
          }
          for (
            const role of [
              "still_entitlement_writer",
              "still_settings_writer",
              "still_analytics_eraser",
            ]
          ) {
            assertEquals(
              (await admin`select has_function_privilege(${role},'public.consume_rate_limit(text,integer,integer)','EXECUTE') as allowed`)[
                0
              ]?.allowed,
              true,
            );
          }
        },
      );
  await t.step("stable local right needs no account and stale observations cannot complete", async () => {
   const old = await local.begin(tx), current = await local.begin(tx);
   assertEquals(await local.commit(tx, old), { status: "stale" });
   const committed = await local.commit(tx, current);
   const right = granted(committed); rightId = right.right;
   assert("issuer_time" in committed); assertEquals(committed.issuer_time, right.verified_at);
   assert(rightId !== A && rightId !== B); assertEquals(right.holder, rightId); assertEquals(right.revision, 0);
   assertEquals(await local.confirm(tx, current, right), true);
   assertEquals(granted(await local.commit(tx, await local.begin(tx))).right, rightId);
  });
  await t.step("a refund as first canonical observation is durable and cannot activate a placeholder", async () => {
   assertEquals(await local.commit(revokedFirst, await local.begin(revokedFirst)), { status: "revoked" });
   const row = await admin`select right_id,active,ownership_revision,verified_at from private.access_rights where provider_key=${revokedFirst.key}`;
   assertEquals(row[0]?.active, false); assert(Number(row[0]?.verified_at)>0);
   assertEquals(await local.commit({ ...revokedFirst, active: true }, await local.begin(revokedFirst)), { status: "revoked" });
   assertEquals(await local.commit(revokedFirst, await local.begin(revokedFirst)), { status: "revoked" });
   const after = await admin`select right_id,active,ownership_revision,verified_at from private.access_rights where provider_key=${revokedFirst.key}`;
   assertEquals(Array.from(after), Array.from(row));
  });
  await t.step("explicit first association returns both scopes at incremented revision and exact retry succeeds", async () => {
   const token = await local.begin(tx), link = { holder: A, operation, expectedRevision: 0 };
   const first = await local.commit(tx, token, link); assertEquals(first.status, "linked");
   assert("issuer_time" in first); assertEquals(first.issuer_time, granted(first).verified_at);
   assertEquals(await local.linkedTransactions(A, "sandbox"), [{ ...tx, transactionId: tx.originalTransactionId }]);
   assertEquals(await local.linkedTransactions(B, "sandbox"), []);
   assertEquals(granted(first).revision, 1); assertEquals(granted(first).holder, A);
   const replay = await local.commit(tx, await local.begin(tx), link); assertEquals(replay.status, "linked");
   assertEquals(granted(replay).revision, 1); assertEquals(granted(replay).right, rightId);
   await assertRejects(async () => local.commit(tx, await local.begin(tx), { ...link, holder: B }));
  });
  await t.step("a new operation for current owner is already linked and conflict cannot move local rights", async () => {
   const same = await local.commit(tx, await local.begin(tx), { holder: A, operation: crypto.randomUUID(), expectedRevision: 1 });
   assertEquals(same.status, "already_linked");
   assertEquals(await local.commit(tx, await local.begin(tx), { holder: B, operation: crypto.randomUUID(), expectedRevision: 1 }), { status: "owned_elsewhere" });
   assertEquals(granted(await local.commit(tx, await local.begin(tx))).holder, rightId);
  });
  await t.step("RC full absence never refunds independently verified Apple rights", async () => {
   const empty = await account.commit(A, "sandbox", await account.begin(A, "sandbox"), []);
   assert(empty.status !== "stale"); assertEquals(empty.rights.length, 1); assertEquals(empty.rights[0]?.right, rightId);
  });
  await t.step("RC missing/partial listing preserves independent rights and deadlines; explicit refund affects only its transaction", async () => {
   const snapshot = rcKeys.map(key => ({ key, product: "still_pro_v3" as const }));
   const first = await account.commit(A, "sandbox", await account.begin(A, "sandbox"), snapshot);
   assert(first.status === "committed"); assertEquals(first.rights.length, 3);
   const before = await admin`select provider_key,right_id,ownership_revision,verified_at from private.access_rights where provider_key in (${rcKeys[0]},${rcKeys[1]}) order by provider_key`;
   const absent = await account.commit(A, "sandbox", await account.begin(A, "sandbox"), []);
   assert(absent.status === "committed"); assertEquals(absent.rights.length, 3); assertEquals(absent.revocations, []);
   assertEquals(absent.observed_rights, []);
   const after = await admin`select provider_key,right_id,ownership_revision,verified_at from private.access_rights where provider_key in (${rcKeys[0]},${rcKeys[1]}) order by provider_key`;
   assertEquals(Array.from(after), Array.from(before));
   const refunded = await account.commit(A, "sandbox", await account.begin(A, "sandbox"), [{ ...snapshot[0]!, state: "revoked" }]);
   assert(refunded.status === "committed"); assertEquals(refunded.rights.length, 2);
   assertEquals(refunded.observed_rights, []);
   assertEquals(refunded.revocations, [{ right: before[0]!.right_id, revision: 1 }]);
   assertEquals(refunded.rights.find(r => r.right === before[1]!.right_id)?.verified_at, Number(before[1]!.verified_at));
   assertEquals(refunded.rights.some(r => r.right === rightId), true);
   const replay = await account.commit(A, "sandbox", await account.begin(A, "sandbox"), [{ ...snapshot[0]!, state: "revoked" }]);
   assert(replay.status === "committed"); assertEquals(replay.revocations, refunded.revocations);
   const bad = await account.begin(A, "sandbox");
   await assertRejects(() => account.commit(A, "sandbox", bad, [{ ...snapshot[0]!, state: "free" as "revoked" }]));
  });
  await t.step("generic transfer cannot bypass the Apple link ledger, including historical operation replay", async () => {
   const before = await admin`select to_jsonb(r) as row from private.access_rights r where right_id=${rightId}::uuid`;
   const appleBefore = await admin`select to_jsonb(o) as row from private.apple_access_observations o where provider_key=${tx.key} and environment='sandbox'`;
   const bypass = crypto.randomUUID();
   assertEquals((await writer`select public.transfer_access_right(${bypass}::uuid,${rightId}::uuid,'sandbox',${A}::uuid,${B}::uuid,1) as result`)[0]?.result, { status: "unavailable" });
   assertEquals((await admin`select count(*)::int as count from private.access_transfer_operations where operation_id=${bypass}::uuid`)[0]?.count, 0);
   await admin`insert into private.access_transfer_operations(operation_id,right_id,environment,source_holder,target_holder,expected_revision,result)
     values(${bypass}::uuid,${rightId}::uuid,'sandbox',${A}::uuid,${B}::uuid,1,'{"status":"transferred","revision":2}'::jsonb)`;
   try {
    assertEquals((await writer`select public.transfer_access_right(${bypass}::uuid,${rightId}::uuid,'sandbox',${A}::uuid,${B}::uuid,1) as result`)[0]?.result, { status: "unavailable" });
    await assertRejects(() => writer`select public.transfer_access_right(${bypass}::uuid,${rightId}::uuid,'sandbox',${B}::uuid,${A}::uuid,1)`);
    assertEquals(Array.from(await admin`select to_jsonb(r) as row from private.access_rights r where right_id=${rightId}::uuid`), Array.from(before));
    assertEquals(Array.from(await admin`select to_jsonb(o) as row from private.apple_access_observations o where provider_key=${tx.key} and environment='sandbox'`), Array.from(appleBefore));
    assertEquals((await admin`select count(*)::int as count from private.access_revocations where right_id=${rightId}::uuid`)[0]?.count, 0);
   } finally { await admin`delete from private.access_transfer_operations where operation_id=${bypass}::uuid`; }
  });
  await t.step("generic RevenueCat transfer and exact replay retain their existing contract", async () => {
   const rc = (await admin`select right_id,verified_at from private.access_rights where provider_key=${rcKeys[1]} and environment='sandbox'`)[0]!;
   const op = crypto.randomUUID();
   try {
    const first = (await writer`select public.transfer_access_right(${op}::uuid,${rc.right_id}::uuid,'sandbox',${A}::uuid,${B}::uuid,0) as result`)[0]?.result;
    assertEquals(first, { status: "transferred", revision: 1 });
    assertEquals((await writer`select public.transfer_access_right(${op}::uuid,${rc.right_id}::uuid,'sandbox',${A}::uuid,${B}::uuid,0) as result`)[0]?.result, first);
    const moved = (await admin`select holder,verified_at from private.access_rights where right_id=${rc.right_id}::uuid`)[0]!;
    assertEquals(moved.holder, B); assertEquals(moved.verified_at, rc.verified_at);
   } finally { await admin`delete from private.access_transfer_operations where operation_id=${op}::uuid`; }
  });
  await t.step("explicit dual-authority transfer CAS fences old replies and records former owner revocation", async () => {
   const before = await local.begin(tx); const oldRight = granted(await local.commit(tx, before, { holder: A, operation: crypto.randomUUID(), expectedRevision: 1 }));
   operation = crypto.randomUUID();
   const moved = await local.commit(tx, await local.begin(tx), { holder: B, sourceHolder: A, operation, expectedRevision: 1 });
   assertEquals(moved.status, "linked"); assertEquals(granted(moved).revision, 2); assertEquals(granted(moved).holder, B);
   assertEquals(await local.confirm(tx, before, oldRight), false);
   const revoked = await admin`select revision from private.access_revocations where holder=${A}::uuid and right_id=${rightId}::uuid`;
   assertEquals(Number(revoked[0]?.revision), 2);
   const again = await local.commit(tx, await local.begin(tx), { holder: B, sourceHolder: A, operation, expectedRevision: 1 });
   assertEquals(granted(again).revision, 2);
   await assertRejects(async () => local.commit(tx, await local.begin(tx), { holder: A, sourceHolder: B, operation, expectedRevision: 2 }));
  });
  await t.step("sandbox and production cannot collide", async () => {
   const prod = new PgAppleAccessStore(writer, "production"), production = { ...tx, environment: "production" as const };
   assert(granted(await prod.commit(production, await prod.begin(production))).right !== rightId);
   await assertRejects(() => prod.begin(tx));
  });
  await t.step("known refund revokes exactly this right and an old active snapshot cannot resurrect it", async () => {
   const token = await local.begin(tx), before = granted(await local.commit(tx, token));
   assertEquals(await local.commit({ ...tx, active: false }, await local.begin(tx)), { status: "revoked" });
   assertEquals(await local.confirm(tx, token, before), false);
   assertEquals(await local.linkedTransactions(B, "sandbox"), []);
   assertEquals(await local.commit(tx, await local.begin(tx)), { status: "revoked" });
  });
  await t.step("known removal survives positive deadline failure but remains account/environment/current-token fenced", async () => {
   const token = await account.begin(B, "sandbox");
   const before = await admin`select right_id,active,ownership_revision,verified_at from private.access_rights where right_id=${rightId}::uuid`;
   await admin`update private.access_observations set deadline=clock_timestamp()-interval '1 second' where holder=${B}::uuid and environment='sandbox'`;
   assertEquals(await account.commit(B, "sandbox", token, []), { status: "stale" });
   const receipt = await account.removals(B, "sandbox", token);
   assert(receipt); assertEquals(receipt.holder, B); assertEquals(receipt.environment, "sandbox");
   assertEquals(receipt.revocations, [{ right: rightId, revision: 3 }]);
   assertEquals(await account.removals(A, "sandbox", token), null);
   assertEquals(await account.removals(B, "production", token), null);
   await account.begin(B, "sandbox"); assertEquals(await account.removals(B, "sandbox", token), null);
   const after = await admin`select right_id,active,ownership_revision,verified_at from private.access_rights where right_id=${rightId}::uuid`;
   assertEquals(Array.from(after), Array.from(before));
  });
  await t.step("account deletion preserves the transaction row and prevents silent adopted ownership", async () => {
   await admin`delete from auth.users where id=${B}::uuid`;
   const row = await admin`select holder,right_id from private.access_rights where right_id=${rightId}::uuid`;
   assertEquals(row[0]?.holder, null); assertEquals(row[0]?.right_id, rightId);
   const production = { ...tx, environment: "production" as const };
   const prod = new PgAppleAccessStore(writer, "production");
   const linked = await prod.commit(production, await prod.begin(production), { holder: A, operation: crypto.randomUUID(), expectedRevision: 0 });
   assertEquals(linked.status, "linked");
   await admin`delete from auth.users where id=${A}::uuid`;
   assertEquals((await prod.commit(production, await prod.begin(production))).status, "verified");
  });
  await t.step("no client grants or writer table reachability", async () => {
   await assertRejects(() => writer`select * from private.apple_access_observations`);
   await assertRejects(() => writer`select * from private.apple_access_link_operations`);
   for (const role of ["anon","authenticated","service_role"]) {
    for (const signature of ["public.begin_apple_access_observation(text,text,text,text,text)",
      "public.commit_apple_access_observation(text,text,uuid,boolean,uuid,uuid,bigint,uuid)",
      "public.confirm_apple_access_observation(text,text,uuid,uuid,uuid,bigint,bigint)", "public.read_linked_apple_transactions(uuid,text)", "public.read_access_removals(uuid,text,uuid)",
      "public.transfer_access_right(uuid,uuid,text,uuid,uuid,bigint)"]) {
     assertEquals((await admin`select has_function_privilege(${role},${signature},'EXECUTE') as allowed`)[0]?.allowed, false);
    }
   }
  });
 } finally {
  await admin`delete from private.apple_access_link_operations where provider_key=${tx.key}`;
  await admin`delete from private.apple_access_observations where provider_key=${tx.key}`;
  await admin`delete from private.access_revocations where right_id in (select right_id from private.access_rights where provider_key=${tx.key})`;
  await admin`delete from private.access_rights where provider_key=${tx.key}`;
  await admin`delete from private.access_revocations where right_id in (select right_id from private.access_rights where provider_key in (${rcKeys[0]},${rcKeys[1]}))`;
  await admin`delete from private.access_rights where provider_key in (${rcKeys[0]},${rcKeys[1]})`;
  await admin`delete from private.apple_access_observations where provider_key=${revokedFirst.key}`;
  await admin`delete from private.access_rights where provider_key=${revokedFirst.key}`;
  await admin`delete from auth.users where id in (${A}::uuid,${B}::uuid)`;
  await writer.end(); await admin`alter role still_entitlement_writer nologin password null`; await admin.end();
 }
} });
