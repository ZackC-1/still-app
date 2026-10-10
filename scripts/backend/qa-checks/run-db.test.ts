// Disposable-database proof for the read-only QA check route. Needs a throwaway database that
// has migrations 0001-0021 and scripts/backend/sql/qa-readonly-checks-candidate.sql installed
// (scripts/backend/rehearse-qa-readonly-checks.sh does this on a GitHub-hosted runner). It seeds
// synthetic owner QA aliases AND synthetic non-QA data, then proves, as the real narrow role:
// only owner QA aliases can be registered or seen; every catalogue check runs and rolls back;
// non-QA rights, holder-less rights from before the QA run and old erasure jobs are invisible;
// nothing raw is printed; production is compared only as a keyed digest; base tables, the
// registry and every write are refused; and every kind of widened role is refused.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import postgres from "postgres";
import { CHECKS, CHECK_INPUTS, LABELS, resolveRequest } from "./catalogue.mjs";
import { renderReport } from "./report.mjs";
import {
  CHECKER_ROLE,
  CheckError,
  compareProduction,
  productionDigest,
  requireCheckerSession,
  runCheck,
  SESSION_SQL,
  verdictFor,
} from "./run.ts";

const adminUrl = Deno.env.get("STILL_QA_CHECKS_TEST_DATABASE_URL");
const required = Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1";
const PASSWORD = "qa-checks-synthetic-only";
const REF_KEY = "5a".repeat(32);

const id = (n: number) => `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LABEL_IDS = Object.keys(LABELS).map((label, i) => ({ label, holder: id(i + 1) }));
const holder = (label: string) => LABEL_IDS.find((l) => l.label === label)!.holder;
const CUSTOMER = id(99);
const OTHER_ALIAS = id(98);
const UNCONFIRMED_ALIAS = id(97);
const SUBJECTS = ["web-chrome", "web-firefox", "web-android", "fresh", "refund-web", "qa-a", "qa-b"];
const OWNER_BASE = "owner@example.invalid";
const nowMs = "(extract(epoch from clock_timestamp()) * 1000)::bigint";

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
    const report = async (input: string, a?: string, b?: string) => {
      const request = resolveRequest({ check: input, account: a, accountB: b });
      const run = await runCheck(checker!, request);
      const production = run.productionRows ? "unchanged" : undefined;
      const verdict = verdictFor(request, run, production);
      return { run, text: renderReport({ ...request, holders: run.holders, results: run.results, refKey: REF_KEY, production, verdict }) };
    };
    try {
      await admin.begin(async (tx) => {
        // Re-runnable on the same disposable database: remove this test's synthetic rows first.
        const all = [...LABEL_IDS.map((l) => l.holder), CUSTOMER, OTHER_ALIAS, UNCONFIRMED_ALIAS];
        await tx`delete from private.apple_access_observations where right_id in (${id(203)}, ${id(205)})`;
        await tx`delete from private.access_rights where right_id in (${id(201)}, ${id(202)}, ${id(203)}, ${id(204)}, ${id(205)}, ${id(206)})`;
        await tx`delete from private.analytics_erasure_jobs where job_id in (${id(501)}, ${id(502)})`;
        await tx`delete from still_qa_checks.qa_accounts`;
        await tx`delete from still_qa_checks.qa_alias_owner`;
        await tx`delete from auth.users where id in ${tx(all)}`;
        for (const { label, holder: h } of LABEL_IDS) {
          await tx`insert into auth.users(id, email, email_confirmed_at) values (${h}, ${`Owner+stillqa-${label}@example.invalid`}, clock_timestamp())`;
        }
        await tx`insert into auth.users(id, email, email_confirmed_at) values
          (${CUSTOMER}, 'customer@example.invalid', clock_timestamp()),
          (${OTHER_ALIAS}, 'someone+stillqa-fresh@example.invalid', clock_timestamp()),
          (${UNCONFIRMED_ALIAS}, 'owner+stillqa-extra@example.invalid', null)`;
        for (const label of SUBJECTS) {
          await tx`insert into private.qa_sandbox_subjects(holder, enabled) values (${holder(label)}, true)`;
        }
        // A customer wrongly added as a sandbox member is still not a QA alias.
        await tx`insert into private.qa_sandbox_subjects(holder, enabled) values (${CUSTOMER}, true)`;
        const hex = (c: string) => c.repeat(64);
        // Non-QA holder-less sandbox right from BEFORE the QA run started: must stay invisible.
        await tx.unsafe(`insert into private.access_rights(right_id, environment, provider_key, provider_product, holder, active, verified_at, provider_source)
          values ('${id(205)}', 'sandbox', '${hex("e")}', 'still_pro_v3', null, true, ${nowMs} - 86400000, 'apple')`);
        await tx`insert into private.access_rights(right_id, environment, provider_key, provider_product, holder, active, verified_at, provider_source)
          values (${id(206)}, 'sandbox', ${hex("f")}, 'still_pro_v3', ${CUSTOMER}, true, 1, 'revenuecat')`;
        await tx`insert into still_qa_checks.qa_alias_owner(base_sha256) values (encode(sha256(convert_to(${OWNER_BASE}, 'UTF8')), 'hex'))`;
        for (const { label, holder: h } of LABEL_IDS) {
          await tx`insert into still_qa_checks.qa_accounts(label, holder) values (${label}, ${h})`;
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
        await tx.unsafe(`insert into private.access_rights(right_id, environment, provider_key, provider_product, holder, active, verified_at, provider_source)
          values ('${id(201)}', 'sandbox', '${hex("a")}', 'still_pro_v3', '${holder("web-chrome")}', true, ${nowMs}, 'revenuecat'),
                 ('${id(202)}', 'production', '${hex("b")}', 'still_pro_v3', '${CUSTOMER}', true, ${nowMs}, 'revenuecat'),
                 ('${id(203)}', 'sandbox', '${hex("c")}', 'still_pro_v3', null, true, ${nowMs}, 'apple')`);
        await tx`insert into private.apple_access_observations(environment, provider_key, right_id, bundle_id, product_id, original_transaction_id, token, deadline)
          values ('sandbox', ${hex("c")}, ${id(203)}, 'com.example.synthetic', 'still_pro_v3', '1000000001', ${id(301)}, clock_timestamp() + interval '5 minutes'),
                 ('sandbox', ${hex("e")}, ${id(205)}, 'com.example.synthetic', 'still_pro_v3', '1000000002', ${id(302)}, clock_timestamp() + interval '5 minutes')`;
        await tx`insert into private.qa_sandbox_purchase_operations(operation_id, holder, configuration_hash, stripe_session_id, status)
          values (${id(401)}, ${holder("web-chrome")}, ${hex("d")}, 'cs_test_syntheticSession01', 'session_bound'),
                 (${id(402)}, ${CUSTOMER}, ${hex("d")}, 'cs_test_syntheticSession02', 'session_bound')`;
        await tx`insert into private.analytics_erasure_jobs(job_id, scope, scope_key, stage, sweeps, attempts, priority, next_attempt_at, created_at)
          values (${id(501)}, 'device', decode(repeat('ab', 32), 'hex'), 'stop_recorded', 0, 0, 0, clock_timestamp(), clock_timestamp() - interval '2 hours'),
                 (${id(502)}, 'device', decode(repeat('cd', 32), 'hex'), 'stop_recorded', 0, 0, 0, clock_timestamp(), clock_timestamp())`;
        await tx.unsafe(`alter role ${CHECKER_ROLE} with login password '${PASSWORD}'`);
      });
      checker = postgres(parsed.toString(), { max: 1, prepare: false, onnotice: () => {} });

      await t.step("only a confirmed owner QA alias can be registered", async () => {
        for (const other of [CUSTOMER, OTHER_ALIAS, UNCONFIRMED_ALIAS]) {
          await assertRejects(() => admin`update still_qa_checks.qa_accounts set holder = ${other} where label = 'fresh'`);
        }
        await assertRejects(() => admin`insert into still_qa_checks.qa_accounts(label, holder) values ('nobody', ${CUSTOMER})`);
      });

      await t.step("the real role passes the session proof", async () => {
        const [session] = await checker!.begin("read only", (tx) => tx.unsafe(SESSION_SQL));
        requireCheckerSession(session as never);
      });

      await t.step("every catalogue input runs, rolls back and reports nothing raw", async () => {
        const [{ fingerprint }] = await admin`select fingerprint from still_qa_checks.production_rights_fingerprint`;
        for (const input of CHECK_INPUTS) {
          const check = CHECKS.find((c) => c.id === input || c.programIds.includes(input))!;
          const labels = check.accounts.length === 2 ? ["qa-a", "qa-b"] : check.accounts.length ? ["web-chrome"] : [];
          const { text } = await report(input, labels[0], labels[1]);
          assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(text), `${input} printed a raw id`);
          assert(!text.includes("@"), `${input} printed an email`);
          assert(!text.includes("cs_test_synthetic"), `${input} printed a Stripe session id`);
          assert(!text.includes(String(fingerprint).slice(0, 16)), `${input} printed the production fingerprint`);
          assert(!text.includes("<withheld>"), `${input} withheld a value: ${text}`);
        }
        assertEquals((await report("setup")).run.results[0].rows.length, 9);
        assertEquals(verdictFor(resolveRequest({ check: "setup" }), (await report("setup")).run), "pass");
      });

      await t.step("non-QA rights, pre-run holder-less rights, customers and old erasure jobs are invisible", async () => {
        const [row] = await checker!.begin("read only", (tx) => tx.unsafe(
          `select (select count(*) from still_qa_checks.profiles where id = $1::uuid) as profiles,
                  (select count(*) from still_qa_checks.access_rights where holder = $1::uuid or right_id in ($2::uuid, $3::uuid, $4::uuid)) as rights,
                  (select count(*) from still_qa_checks.apple_observations where right_id = $3::uuid) as observations,
                  (select count(*) from still_qa_checks.purchase_operations where holder = $1::uuid) as operations,
                  (select count(*) from still_qa_checks.sessions_summary where user_id = $1::uuid) as sessions,
                  (select count(*) from still_qa_checks.qa_subjects where qa_alias and holder = $1::uuid) as alias_subjects,
                  (select count(*) from still_qa_checks.rights_summary where environment <> 'sandbox') as production_summary`,
          [CUSTOMER, id(202), id(205), id(206)],
          { prepare: false, simple: false } as { prepare: boolean },
        ));
        for (const [key, value] of Object.entries(row)) assertEquals(Number(value), 0, key);
        const [visible] = await checker!.begin("read only", (tx) => tx.unsafe(
          `select (select count(*) from still_qa_checks.access_rights where right_id = $1::uuid) as qa_holderless,
                  (select coalesce(sum(jobs), 0) from still_qa_checks.erasure_jobs_last_hour) as recent_jobs`,
          [id(203)],
          { prepare: false, simple: false } as { prepare: boolean },
        ));
        assertEquals(Number(visible.qa_holderless), 1);
        assertEquals(Number(visible.recent_jobs), 1);
      });

      await t.step("a paid-lane label that is not a sandbox member is out of scope and refused", async () => {
        await admin`delete from private.qa_sandbox_subjects where holder = ${holder("fresh")}`;
        try {
          await assertRejects(() => runCheck(checker!, resolveRequest({ check: "DB-15", account: "fresh" })), CheckError);
          assertEquals(verdictFor(resolveRequest({ check: "setup" }), (await report("setup")).run), "fail");
        } finally {
          await admin`insert into private.qa_sandbox_subjects(holder, enabled) values (${holder("fresh")}, true)`;
        }
      });

      await t.step("production is compared as a keyed digest only", async () => {
        const request = resolveRequest({ check: "DB-01" });
        const first = await runCheck(checker!, request);
        const baseline = JSON.stringify({ v: 1, digest: productionDigest(first.productionRows!, REF_KEY) });
        const again = await runCheck(checker!, resolveRequest({ check: "DB-31" }));
        assertEquals(compareProduction(productionDigest(again.productionRows!, REF_KEY), baseline), "unchanged");
        await admin`update private.access_rights set ownership_revision = ownership_revision + 1 where right_id = ${id(202)}`;
        try {
          const changed = await runCheck(checker!, resolveRequest({ check: "DB-31" }));
          const status = compareProduction(productionDigest(changed.productionRows!, REF_KEY), baseline);
          assertEquals(status, "changed");
          assertEquals(verdictFor(resolveRequest({ check: "DB-31" }), changed, status), "fail");
        } finally {
          await admin`update private.access_rights set ownership_revision = ownership_revision - 1 where right_id = ${id(202)}`;
        }
        assertEquals(compareProduction("0".repeat(64), undefined), "no-baseline");
      });

      await t.step("the deletion check accepts a registered account whose Auth row is gone", async () => {
        await admin`delete from auth.users where id = ${holder("delete")}`;
        const { results } = await runCheck(checker!, resolveRequest({ check: "DB-29", account: "delete" }));
        for (const value of Object.values(results[1].rows[0])) assertEquals(Number(value), 0);
        await assertRejects(() => runCheck(checker!, resolveRequest({ check: "DB-03", account: "delete" })), CheckError);
      });

      await t.step("base tables, the registry, scope views and every write are refused", async () => {
        for (const statement of [
          "select count(*) from private.access_rights",
          "select count(*) from public.profiles",
          "select count(*) from auth.users",
          "select count(*) from still_qa_checks.qa_accounts",
          "select count(*) from still_qa_checks.qa_alias_owner",
          "select count(*) from still_qa_checks.qa_scope",
          "select count(*) from still_qa_checks.qa_rights_scope",
          "select count(*) from supabase_migrations.schema_migrations",
        ]) {
          await assertRejects(() => checker!.begin("read only", (tx) => tx.unsafe(statement)), Error, undefined, statement);
        }
        for (const statement of [
          `update still_qa_checks.profiles set settings_version = 0`,
          `delete from still_qa_checks.purchase_operations`,
          `insert into still_qa_checks.qa_accounts(label, holder) values ('fresh', '${id(96)}')`,
          `create table still_qa_checks.probe(x int)`,
        ]) {
          await assertRejects(() => checker!.unsafe(statement));
        }
        // The runner always uses the extended protocol, which refuses a second statement.
        await assertRejects(() => checker!.unsafe("select 1; select 2", [], { prepare: false, simple: false } as { prepare: boolean }));
        const [{ mode }] = await checker!`select current_setting('default_transaction_read_only') as mode`;
        assertEquals(mode, "on");
      });

      await t.step("every kind of widened role is refused before any read", async () => {
        const widen = [
          [`grant select on private.access_rights to ${CHECKER_ROLE}`, `revoke select on private.access_rights from ${CHECKER_ROLE}`],
          [`grant insert on still_qa_checks.qa_accounts to ${CHECKER_ROLE}`, `revoke insert on still_qa_checks.qa_accounts from ${CHECKER_ROLE}`],
          [`grant create on database postgres to ${CHECKER_ROLE}`, `revoke create on database postgres from ${CHECKER_ROLE}`],
          [`alter role ${CHECKER_ROLE} set default_transaction_read_only = off`, `alter role ${CHECKER_ROLE} set default_transaction_read_only = on`],
          [`alter role ${CHECKER_ROLE} set search_path = public`, `alter role ${CHECKER_ROLE} reset search_path`],
          [
            `create function public.qa_checks_definer_probe() returns int language sql security definer set search_path = '' as 'select 1'; ` +
            `grant execute on function public.qa_checks_definer_probe() to ${CHECKER_ROLE}`,
            `drop function public.qa_checks_definer_probe()`,
          ],
        ];
        for (const [open, close] of widen) {
          await admin.unsafe(open);
          try {
            await assertRejects(() => runCheck(checker!, resolveRequest({ check: "DB-31" })), CheckError, undefined, open);
          } finally {
            await admin.unsafe(close);
          }
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
