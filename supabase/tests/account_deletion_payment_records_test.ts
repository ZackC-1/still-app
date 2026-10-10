// Real SQL only on a disposable GitHub-hosted Linux rehearsal at exactly 0022, upgraded from the
// 0021 seed in account_deletion_payment_records_seed.sql. Local SKIP is not a PASS.
// Uses the existing loopback-only connection guard, never the owner's hosted backend.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connection } from "./synthetic_settings_helpers.ts";
import { PgQaPurchaseOperationStore } from "../functions/_shared/qa-purchase-operation-store.ts";

const target = Deno.env.get("STILL_ACCESS_TEST_DATABASE_URL");
const enabled = !!target && Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted" && Deno.build.os === "linux";
if (Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1" && !enabled) throw new Error("required-cloud-tests-disabled");

const A = "a2222222-0000-4000-8000-000000000001";
const B = "b2222222-0000-4000-8000-000000000002";
const right = (account: "a" | "b" | "c", n: number) => `${account}2222222-1000-4000-8000-00000000000${n}`;
const operation = (account: "a" | "b" | "c") => `${account}2222222-2000-4000-8000-000000000001`;
const GATE = "scripts/backend/deploy/verify/0022_account_deletion_keeps_payment_records.sql";

type Row = { holder: string | null; active: boolean; ownership_revision: string; verified_at: string };

Deno.test({
  name: "account deletion keeps payment records, clears the account id and deactivates web rights",
  ignore: !enabled,
  fn: async (t) => {
    const admin = connection(target!);
    const gate = await Deno.readTextFile(GATE);
    const rights = async () => {
      const rows = await admin<(Row & { right_id: string })[]>`
        select right_id::text, holder::text, active, ownership_revision::text, verified_at::text from private.access_rights
        where right_id::text like '_2222222-1000-%' order by right_id`;
      return new Map(rows.map((row) => [row.right_id, row]));
    };
    let qa: ReturnType<typeof connection> | undefined;
    try {
      await t.step("0022 end state and pre-0022 orphan repair", async () => {
        assertEquals((await admin.unsafe(gate))[0]?.coalesce, []);
        const before = await rights();
        // C was deleted before 0022: its detached right is now inactive, one revision later.
        const repaired = before.get(right("c", 1))!;
        assertEquals([repaired.holder, repaired.active, repaired.ownership_revision], [null, false, "1"]);
        assert(Number(repaired.verified_at) > 1000);
        // Live accounts' rows are untouched by the repair.
        for (const [id, revision, active] of [[right("a", 1), "0", true], [right("a", 2), "2", false], [right("a", 3), "1", true], [right("b", 1), "0", true]] as const) {
          const row = before.get(id)!;
          assertEquals([row.active, row.ownership_revision, row.verified_at], [active, revision, "1000"], id);
        }
      });

      await t.step("deleting an account deactivates its web rights and keeps its checkout operation", async () => {
        await admin`delete from auth.users where id = ${A}::uuid`;
        const after = await rights();
        const web = after.get(right("a", 1))!;
        assertEquals([web.holder, web.active, web.ownership_revision], [null, false, "1"]);
        assert(Number(web.verified_at) > 1000);
        // An already-inactive right only loses its account id.
        const refunded = after.get(right("a", 2))!;
        assertEquals([refunded.holder, refunded.active, refunded.ownership_revision, refunded.verified_at], [null, false, "2", "1000"]);
        // Apple rights stay accountless and keep Apple's verdict (0020): detached, still active.
        const apple = after.get(right("a", 3))!;
        assertEquals([apple.holder, apple.active, apple.ownership_revision, apple.verified_at], [null, true, "1", "1000"]);
        // Another account is untouched.
        const other = after.get(right("b", 1))!;
        assertEquals([other.holder, other.active, other.ownership_revision], [B, true, "0"]);
        const kept = await admin`select holder::text, stripe_session_id, status from private.qa_sandbox_purchase_operations
          where operation_id = ${operation("a")}::uuid`;
        assertEquals(Array.from(kept), [{ holder: null, stripe_session_id: "cs_test_DeletionA", status: "access_observed" }]);
        assertEquals((await admin`select count(*)::int as n from private.access_observations where holder = ${A}::uuid`)[0]?.n, 0);
        assertEquals((await admin.unsafe(gate))[0]?.coalesce, []);
      });

      await t.step("a later full refund settles the kept record through the fixed QA RPC without the account", async () => {
        await admin`alter role still_qa_sandbox_writer login password 'qa-deletion-synthetic-only'`;
        qa = connection(target!, "still_qa_sandbox_writer", "qa-deletion-synthetic-only");
        const store = new PgQaPurchaseOperationStore(qa);
        const settled = await store.recordDeletedAccountRefund(operation("a"), "cs_test_DeletionA");
        assertEquals([settled.holder, settled.status, settled.stripe_session_id], [null, "refunded", "cs_test_DeletionA"]);
        assertEquals((await store.recordDeletedAccountRefund(operation("a"), "cs_test_DeletionA")).status, "refunded");
        // The deleted account cannot be addressed through any scoped route. A live account's record
        // is refused as a deleted-account refund: the webhook calls this only for a Session Stripe
        // reports fully refunded, so the stored status is true either way; only the acknowledgement
        // is withheld, and the ordinary scoped refund path then completes it.
        await assertRejects(() => store.read(operation("a"), A));
        await assertRejects(() => store.recordDeletedAccountRefund(operation("a"), "cs_test_DeletionB"));
        await assertRejects(() => store.recordDeletedAccountRefund(operation("b"), "cs_test_DeletionB"));
        assertEquals((await admin`select holder::text from auth.users where id = ${A}::uuid`).length, 0);
      });

      await t.step("gate reports drift in the trigger routine and a reappearing orphan", async () => {
        const rollback = new Error("rollback 0022 drift probe");
        for (const [drift, code] of [
          ["grant execute on function private.deactivate_deleted_account_rights() to anon", "routine_acl"],
          ["alter function private.deactivate_deleted_account_rights() security invoker", "routine_definer"],
          [`update private.access_rights set active = true where right_id = '${right("c", 1)}'`, "orphaned_active_right"],
          ["alter table private.qa_sandbox_purchase_operations drop constraint qa_sandbox_purchase_operations_holder_fkey", "purchase_operation_account_reference_count"],
        ] as const) {
          await assertRejects(() => admin.begin(async (tx) => {
            await tx.unsafe(drift);
            const issues = (await tx.unsafe(gate))[0]?.coalesce as string[];
            assert(issues.includes(code), `${code}: ${JSON.stringify(issues)}`);
            throw rollback;
          }), Error, rollback.message);
        }
        assertEquals((await admin.unsafe(gate))[0]?.coalesce, []);
      });
    } finally {
      await qa?.end();
      await admin`alter role still_qa_sandbox_writer nologin password null`;
      await admin.end();
    }
  },
});
