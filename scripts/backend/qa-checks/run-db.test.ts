// Disposable-database proof for the read-only QA check route. Needs a throwaway database that
// has migrations 0001-0021 and scripts/backend/sql/qa-readonly-checks-candidate.sql installed
// (scripts/backend/rehearse-qa-readonly-checks.sh does this on a GitHub-hosted runner). It seeds
// synthetic QA accounts AND a synthetic customer, then proves, as the real narrow role:
// every catalogue check runs and rolls back; the customer is invisible; nothing raw is printed;
// base tables, the registry and every write are refused; and a widened role is refused.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import postgres from "postgres";
import { CHECKS, CHECK_INPUTS, LABELS, resolveRequest } from "./catalogue.mjs";
import { renderReport } from "./report.mjs";
import { CHECKER_ROLE, CheckError, requireCheckerSession, runCheck, SESSION_SQL } from "./run.ts";

const adminUrl = Deno.env.get("STILL_QA_CHECKS_TEST_DATABASE_URL");
const required = Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1";
const PASSWORD = "qa-checks-synthetic-only";

const id = (n: number) => `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LABEL_IDS = Object.keys(LABELS).map((label, i) => ({ label, holder: id(i + 1) }));
const holder = (label: string) => LABEL_IDS.find((l) => l.label === label)!.holder;
const CUSTOMER = id(99);
const CUSTOMER_EMAIL = "real-customer@example.invalid";
const SUBJECTS = ["web-chrome", "web-firefox", "web-android", "fresh", "refund-web", "qa-a", "qa-b"];

Deno.test({
  name: "read-only QA check route on a disposable database",
  ignore: !adminUrl && !required,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    assert(adminUrl, "STILL_QA_CHECKS_TEST_DATABASE_URL is required in the cloud rehearsal");
    const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    const parsed = new URL(adminUrl);
    parsed.username = CHECKER_ROLE;
    parsed.password = PASSWORD;
    let checker: ReturnType<typeof postgres> | undefined;
    try {
      await admin.begin(async (tx) => {
        // Re-runnable on the same disposable database: remove this test's synthetic rows first.
        const all = [...LABEL_IDS.map((l) => l.holder), CUSTOMER];
        await tx`delete from private.apple_access_observations where right_id = ${id(203)}`;
        await tx`delete from private.access_rights where right_id in (${id(201)}, ${id(202)}, ${id(203)})`;
        await tx`delete from still_qa_checks.qa_accounts`;
        await tx`delete from auth.users where id in ${tx(all)}`;
        for (const { label, holder: h } of LABEL_IDS) {
          await tx`insert into auth.users(id, email, email_confirmed_at) values (${h}, ${`qa-${label}@example.invalid`}, clock_timestamp())`;
          await tx`insert into still_qa_checks.qa_accounts(label, holder) values (${label}, ${h})`;
        }
        await tx`insert into auth.users(id, email, email_confirmed_at) values (${CUSTOMER}, ${CUSTOMER_EMAIL}, clock_timestamp())`;
        for (const label of SUBJECTS) {
          await tx`insert into private.qa_sandbox_subjects(holder, enabled) values (${holder(label)}, true)`;
        }
        const doc = (on: boolean) => ({
          schemaVersion: 2,
          globalOn: true,
          services: { youtube: on, instagram: true },
          sites: { "youtube.shorts": on },
          clocks: { services: { baseRevision: 3, localStep: 1 } },
        });
        await tx`insert into public.profiles(id, settings, settings_version) values (${holder("preserved")}, ${tx.json(doc(true))}, 4)`;
        await tx`insert into public.profiles(id, settings, settings_version) values (${holder("qa-a")}, ${tx.json(doc(false))}, 1)`;
        await tx`insert into public.profiles(id, settings, settings_version) values (${CUSTOMER}, ${tx.json(doc(true))}, 9)`;
        const hex = (c: string) => c.repeat(64);
        await tx`insert into private.access_rights(right_id, environment, provider_key, provider_product, holder, active, verified_at, provider_source)
          values (${id(201)}, 'sandbox', ${hex("a")}, 'still_pro_v3', ${holder("web-chrome")}, true, ${Date.now()}, 'revenuecat'),
                 (${id(202)}, 'production', ${hex("b")}, 'still_pro_v3', ${CUSTOMER}, true, ${Date.now()}, 'revenuecat'),
                 (${id(203)}, 'sandbox', ${hex("c")}, 'still_pro_v3', null, true, ${Date.now()}, 'apple')`;
        await tx`insert into private.apple_access_observations(environment, provider_key, right_id, bundle_id, product_id, original_transaction_id, token, deadline)
          values ('sandbox', ${hex("c")}, ${id(203)}, 'com.example.synthetic', 'still_pro_v3', '1000000001', ${id(301)}, clock_timestamp() + interval '5 minutes')`;
        await tx`insert into private.qa_sandbox_purchase_operations(operation_id, holder, configuration_hash, stripe_session_id, status)
          values (${id(401)}, ${holder("web-chrome")}, ${hex("d")}, 'cs_test_syntheticSession01', 'session_bound')`;
        await tx.unsafe(`alter role ${CHECKER_ROLE} with login password '${PASSWORD}'`);
      });
      checker = postgres(parsed.toString(), { max: 1, prepare: false, onnotice: () => {} });

      await t.step("the real role passes the session proof", async () => {
        const [session] = await checker!.begin("read only", (tx) => tx.unsafe(SESSION_SQL));
        requireCheckerSession(session as never);
      });

      await t.step("every catalogue input runs, rolls back and prints nothing raw", async () => {
        for (const input of CHECK_INPUTS) {
          const check = CHECKS.find((c) => c.id === input || c.programIds.includes(input))!;
          const labels = check.accounts.length === 2 ? ["qa-a", "qa-b"] : check.accounts.length ? ["web-chrome"] : [];
          const request = resolveRequest({ check: input, account: labels[0], accountB: labels[1] });
          const { holders, results } = await runCheck(checker!, request);
          const report = renderReport({ ...request, holders, results });
          assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(report), `${input} printed a raw id`);
          assert(!report.includes("@"), `${input} printed an email`);
          assert(!report.includes("cs_test_synthetic"), `${input} printed a Stripe session id`);
          assert(!report.includes("<withheld>"), `${input} withheld a value: ${report}`);
        }
      });

      await t.step("the deletion check accepts a registered account whose Auth row is gone", async () => {
        await admin`delete from auth.users where id = ${holder("delete")}`;
        const request = resolveRequest({ check: "DB-29", account: "delete" });
        const { results } = await runCheck(checker!, request);
        const left = (results[1] as { rows: Record<string, unknown>[] }).rows[0];
        for (const value of Object.values(left)) assertEquals(Number(value), 0);
        await assertRejects(
          () => runCheck(checker!, resolveRequest({ check: "DB-03", account: "delete" })),
          CheckError,
        );
      });

      await t.step("the customer is invisible through every per-account view", async () => {
        const rows = await checker!.begin("read only", (tx) => tx.unsafe(
          `select (select count(*) from still_qa_checks.profiles where id = $1::uuid) +
                  (select count(*) from still_qa_checks.access_rights where holder = $1::uuid or right_id = $2::uuid) +
                  (select count(*) from still_qa_checks.purchase_operations where holder = $1::uuid) +
                  (select count(*) from still_qa_checks.sessions_summary where user_id = $1::uuid) as visible`,
          [CUSTOMER, id(202)],
        ));
        assertEquals(Number(rows[0].visible), 0);
      });

      await t.step("base tables, the registry and every write are refused", async () => {
        for (const statement of [
          "select count(*) from private.access_rights",
          "select count(*) from public.profiles",
          "select count(*) from auth.users",
          "select count(*) from still_qa_checks.qa_accounts",
          "select count(*) from supabase_migrations.schema_migrations",
        ]) {
          await assertRejects(() => checker!.begin("read only", (tx) => tx.unsafe(statement)));
        }
        for (const statement of [
          `update still_qa_checks.profiles set settings_version = 0`,
          `delete from still_qa_checks.purchase_operations`,
          `insert into still_qa_checks.qa_accounts(label, holder) values ('fresh', '${id(98)}')`,
          `create table still_qa_checks.probe(x int)`,
        ]) {
          // Default transaction mode is read only for this role; a plain session also refuses.
          await assertRejects(() => checker!.unsafe(statement));
        }
        // The runner always uses the extended protocol, which refuses a second statement.
        await assertRejects(() => checker!.unsafe("select 1; select 2", [], { prepare: false, simple: false } as { prepare: boolean }));
        const [{ mode }] = await checker!`select current_setting('default_transaction_read_only') as mode`;
        assertEquals(mode, "on");
      });

      await t.step("a widened role is refused before any read", async () => {
        await admin.unsafe(`grant select on private.access_rights to ${CHECKER_ROLE}`);
        try {
          const request = resolveRequest({ check: "DB-31" });
          await assertRejects(() => runCheck(checker!, request), CheckError);
        } finally {
          await admin.unsafe(`revoke select on private.access_rights from ${CHECKER_ROLE}`);
        }
        await admin.unsafe(`grant insert on still_qa_checks.qa_accounts to ${CHECKER_ROLE}`);
        try {
          await assertRejects(() => runCheck(checker!, resolveRequest({ check: "DB-31" })), CheckError);
        } finally {
          await admin.unsafe(`revoke insert on still_qa_checks.qa_accounts from ${CHECKER_ROLE}`);
        }
        await runCheck(checker!, resolveRequest({ check: "DB-31" }));
      });

      await t.step("an admin session is refused by the session proof", async () => {
        const [session] = await admin.begin("read only", (tx) => tx.unsafe(SESSION_SQL));
        assertThrows(() => requireCheckerSession(session as never), CheckError);
      });
    } finally {
      await checker?.end({ timeout: 5 });
      await admin.unsafe(`alter role ${CHECKER_ROLE} with nologin password null`).catch(() => {});
      await admin.end({ timeout: 5 });
    }
  },
});
