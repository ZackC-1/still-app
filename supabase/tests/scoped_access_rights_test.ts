// Behavioral ledger probe for an ephemeral GitHub-hosted Supabase rehearsal at migration 0019.
// A skipped local invocation is NOT runtime evidence. Never connects to the existing hosted app.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connection } from "./synthetic_settings_helpers.ts";
import { PgAccessRightStore } from "../functions/_shared/pg-access-store.ts";

const target = Deno.env.get("STILL_ACCESS_TEST_DATABASE_URL");
const enabled = !!target && Deno.env.get("GITHUB_ACTIONS") === "true" && Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted" && Deno.build.os === "linux";
if (Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1" && !enabled) throw new Error("required-cloud-tests-disabled");
const A = "a1919191-0000-4000-8000-000000000001";
const B = "b1919191-0000-4000-8000-000000000002";
const snapshot = [{ key: "a".repeat(64), product: "still_pro_v3" as const }];

Deno.test({ name: "real private access ledger: idempotency, ownership, refund, stale observation and ACL boundaries",
  ignore: !enabled, fn: async () => {
    const admin = connection(target!);
    // This disposable role credential never leaves the synthetic runner or reaches deployment.
    await admin`alter role still_entitlement_writer login password 'access-synthetic-writer-only'`;
    const writer = connection(target!, "still_entitlement_writer", "access-synthetic-writer-only");
    const store = new PgAccessRightStore(writer);
    try {
      await admin`insert into auth.users(id,email) values(${A}::uuid,'access-a@example.invalid'),(${B}::uuid,'access-b@example.invalid')`;
      const before = await admin`select still_sync from public.entitlements where user_id = ${A}::uuid`;
      const token = await store.begin(A, "sandbox");
      const first = await store.commit(A, "sandbox", token, snapshot);
      assert(first.status === "committed");
      assertEquals(first.rights.length, 1);
      const right = first.rights[0]!;
      assert(right.right !== A && right.right !== B);
      assertEquals(await store.commit(A, "sandbox", token, snapshot), first);
      await assertRejects(() => store.commit(A, "sandbox", token, []));
      assertEquals(await store.confirm(A, "sandbox", token), true);
      const bToken = await store.begin(B, "sandbox");
      const conflict = await store.commit(B, "sandbox", bToken, snapshot);
      assertEquals(conflict.status, "conflict");
      if (conflict.status !== "stale") assertEquals(conflict.rights.length, 0);
      const old = await store.begin(A, "sandbox");
      const latest = await store.begin(A, "sandbox");
      assertEquals(await store.commit(A, "sandbox", old, snapshot), { status: "stale" });
      const refund = await store.commit(A, "sandbox", latest, []);
      assert(refund.status === "committed");
      assertEquals(refund.rights, []);
      assertEquals(refund.revocations, [{ right: right.right, revision: 1 }]);
      assertEquals(await store.confirm(A, "sandbox", token), false);
      const reverified = await store.commit(A, "sandbox", await store.begin(A, "sandbox"), snapshot);
      assert(reverified.status === "committed");
      assertEquals(reverified.rights[0]?.right, right.right);
      assertEquals(reverified.rights[0]?.revision, 2);
      const operation = crypto.randomUUID();
      const transfer = () => writer`select public.transfer_access_right(${operation}::uuid,${right.right}::uuid,'sandbox',${A}::uuid,${B}::uuid,2) as result`;
      const [transferred, concurrentRetry] = await Promise.all([transfer(), transfer()]);
      assertEquals(transferred[0]?.result, { status: "transferred", revision: 3 });
      assertEquals(concurrentRetry, transferred);
      assertEquals(await transfer(), transferred);
      await assertRejects(() => writer`select public.transfer_access_right(${operation}::uuid,${right.right}::uuid,'sandbox',${B}::uuid,${A}::uuid,3)`);
      const current = await store.commit(B, "sandbox", await store.begin(B, "sandbox"), snapshot);
      assert(current.status === "committed");
      assertEquals(current.rights[0]?.holder, B);
      assertEquals(current.rights[0]?.revision, 3);
      const former = await store.commit(A, "sandbox", await store.begin(A, "sandbox"), snapshot);
      assertEquals(former.status, "conflict");
      if (former.status !== "stale") assertEquals(former.rights, []);
      const sandboxId = current.rights[0]!.right;
      const production = await store.commit(B, "production", await store.begin(B, "production"), snapshot);
      assert(production.status === "committed");
      assert(production.rights[0]?.right !== sandboxId);
      const older = await store.begin(B, "sandbox");
      const newer = await store.begin(B, "sandbox");
      const [oldResult, newResult] = await Promise.all([
        store.commit(B, "sandbox", older, []), store.commit(B, "sandbox", newer, snapshot),
      ]);
      assertEquals(oldResult, { status: "stale" });
      assertEquals(newResult.status, "committed");
      const invalidToken = await store.begin(B, "sandbox");
      await assertRejects(() => writer`select public.commit_access_observation(${B}::uuid,'sandbox',${invalidToken}::uuid,'[{"key":"bad","product":"still_pro_v3"}]'::jsonb)`);
      assertEquals((await admin`select still_sync from public.entitlements where user_id = ${A}::uuid`), before);
      await assertRejects(() => writer`select * from private.access_rights`);
      for (const role of ["anon", "authenticated", "service_role"]) {
        const allowed = await admin`select has_function_privilege(${role},'public.begin_access_observation(uuid,text)','EXECUTE') as allowed`;
        assertEquals(allowed[0]?.allowed, false);
      }
      await admin`delete from auth.users where id = ${B}::uuid`;
      assertEquals(await store.confirm(B, "sandbox", invalidToken), false);
      const detached = await admin`select holder from private.access_rights where right_id = ${sandboxId}::uuid`;
      assertEquals(detached[0]?.holder, null);
    } finally {
      await admin`delete from private.access_transfer_operations where source_holder in (${A}::uuid,${B}::uuid) or target_holder in (${A}::uuid,${B}::uuid)`;
      await admin`delete from private.access_revocations where holder in (${A}::uuid,${B}::uuid)`;
      await admin`delete from private.access_rights where provider_key = ${snapshot[0]!.key}`;
      await admin`delete from auth.users where id in (${A}::uuid,${B}::uuid)`;
      await writer.end();
      await admin`alter role still_entitlement_writer nologin password null`;
      await admin.end();
    }
  },
});
