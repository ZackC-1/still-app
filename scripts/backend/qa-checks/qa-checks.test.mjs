// Source guards for the protected read-only QA check route (no database, no network):
// the catalogue is closed and every query is one allow-listed SELECT; the views it reads are
// exactly the ones the candidate SQL grants; outputs cannot print raw values; inputs cannot carry
// SQL, ids or emails; and the workflow is manual, main-only, pinned, environment-gated and holds
// only the read-only secret.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parsers } from "prettier/plugins/yaml";
import {
  CHECK_INPUTS,
  CHECKS,
  InputError,
  LABELS,
  NOT_READ_ONLY,
  OPTIONAL_LABELS,
  PRODUCTION_QUERIES,
  REQUIRED_LABELS,
  queryParams,
  resolveRequest,
} from "./catalogue.mjs";
import { CHECK_VIEWS, GuardError, MIGRATION_VIEWS, assertSingleSelect } from "./sql-guard.mjs";
import { lintVerificationSql } from "../deploy/deploy.mjs";
import { WITHHELD, formatValue, ref, renderReport } from "./report.mjs";
import { READONLY_ENVIRONMENT, main as protectionMain } from "./protection.mjs";
import { BASELINE_ARTIFACT, BaselineError, WORKFLOW_PATH, findBaselineRun, main as baselineMain } from "./baseline.mjs";

const ROOT = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PROGRAMME_IDS = Array.from({ length: 38 }, (_, i) => `DB-${String(i + 1).padStart(2, "0")}`);
/** Release checks outside the QA programme's DB steps. */
const RELEASE_IDS = ["PROD-01"];
const MIGRATION_0025 = "supabase/migrations/0025_production_sales_summary_view.sql";
const CANDIDATE_VIEW_COUNT = CHECK_VIEWS.length - Object.keys(MIGRATION_VIEWS).length;

test("every catalogue query is one allow-listed SELECT with contiguous declared parameters", () => {
  for (const check of CHECKS) {
    assert.ok(check.queries.length > 0, check.id);
    for (const query of check.queries) {
      const params = queryParams(query, check.accounts.length);
      assertSingleSelect(query.sql, params.length);
      const used = new Set([...query.sql.matchAll(/\$([1-9])/g)].map((m) => Number(m[1])));
      assert.deepEqual([...used].sort(), params.map((_, i) => i + 1), `${check.id}: ${query.name}`);
      for (const account of params) assert.ok(account < check.accounts.length, `${check.id}: ${query.name}`);
      assert.ok(Object.keys(query.fields).length > 0);
      for (const type of Object.values(query.fields)) formatValue(null, type);
    }
  }
});

test("production queries are allow-listed SELECTs and never part of a printed report", () => {
  for (const query of PRODUCTION_QUERIES) assertSingleSelect(query.sql, 0);
  for (const check of CHECKS)
    for (const query of check.queries) {
      assert.doesNotMatch(query.sql, /production_rights_fingerprint|environment = 'production'/, `${check.id}: ${query.name}`);
      // Only PROD-01 prints production, and only through the one public-facts view.
      const views = assertSingleSelect(query.sql, 2);
      if (views.has("production_sales_summary")) assert.deepEqual([check.id, [...views]], ["production-sales", ["production_sales_summary"]]);
    }
  assert.deepEqual(
    CHECKS.filter((c) => c.production).map((c) => [c.programIds[0], c.production]),
    [["DB-01", "record"], ["DB-35", "compare"], ["DB-31", "compare"]],
  );
});

test("every programme DB step is either answered once or marked not read-only", () => {
  const answered = CHECKS.flatMap((c) => c.programIds);
  assert.equal(new Set(answered).size, answered.length, "a step is answered twice");
  assert.deepEqual([...answered.filter((id) => id.startsWith("DB-")), ...Object.keys(NOT_READ_ONLY)].sort(), PROGRAMME_IDS);
  assert.deepEqual(answered.filter((id) => !id.startsWith("DB-")), RELEASE_IDS);
  assert.deepEqual(Object.keys(NOT_READ_ONLY), ["DB-36"]);
  assert.deepEqual(CHECK_INPUTS, ["setup", ...answered.sort()]);
});

test("the guard refuses writes, second statements, hidden text, base tables and unsafe calls", () => {
  const refused = [
    "delete from still_qa_checks.profiles",
    "select 1; select 2",
    "select 1 -- comment",
    "select 1 /* c */",
    "select $$x$$",
    "select $3",
    "select * from still_qa_checks.profiles for update",
    "select * into t from still_qa_checks.profiles",
    "select count(*) from private.access_rights",
    "select count(*) from public.profiles p",
    "select count(*) from auth.users",
    "select count(*) from still_qa_checks.qa_accounts",
    "select pg_catalog.pg_sleep(10)",
    "select pg_sleep(10)",
    "select nextval('x')",
    "select set_config('default_transaction_read_only', 'off', true)",
    "select pg_catalog.set_config('a', 'b', true)",
    "select dblink('x')",
    "select pg_read_file('/etc/passwd')",
    "with x as (delete from still_qa_checks.profiles returning 1) select 1",
    "select 1 union select 2",
    "select E'\\x41'",
    "select \"id\" from still_qa_checks.profiles",
    "select 'a''b'",
    "select * from x",
    "update still_qa_checks.profiles set settings_version = 0",
    "SELECT 1; COMMIT",
    "select lo_import('/tmp/x')",
    "select * from pg_catalog.pg_authid",
    "select 1 from still_qa_checks.profiles, lateral (select 1) s where 1 = 1 or 1 = (select pg_terminate_backend(1))",
    "explain analyze select 1",
    "select 1",
  ];
  for (const sql of refused) assert.throws(() => assertSingleSelect(sql, 0), GuardError, sql);
  assert.throws(() => assertSingleSelect("select $1::uuid", 0), GuardError);
  assertSingleSelect("select $1::uuid", 1);
});

test("the views the catalogue reads are exactly the views the candidate SQL and migration 0025 create and grant", async () => {
  const sql = await read("scripts/backend/sql/qa-readonly-checks-candidate.sql");
  const migration = await read(MIGRATION_0025);
  const fromCandidate = CHECK_VIEWS.filter((v) => !Object.hasOwn(MIGRATION_VIEWS, v));
  assert.equal(fromCandidate.length, CANDIDATE_VIEW_COUNT);
  assert.deepEqual(MIGRATION_VIEWS, { production_sales_summary: "0025" });
  const created = [...sql.matchAll(/create or replace view still_qa_checks\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...created].sort(), [...fromCandidate, "qa_rights_scope", "qa_scope"].sort());
  const fromMigration = [...migration.matchAll(/create or replace view still_qa_checks\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(fromMigration, Object.keys(MIGRATION_VIEWS));
  const grant = /grant select on ([\s\S]*?)\s+to still_qa_readonly_checker;/.exec(sql);
  const granted = grant[1].split(",").map((s) => s.trim().replace(/^still_qa_checks\./, ""));
  assert.deepEqual([...granted].sort(), [...fromCandidate].sort());
  assert.match(sql, new RegExp(`where a\\.grantee = checker\\) <> ${CANDIDATE_VIEW_COUNT} \\+ migration_views\\b`));
  // Re-running the candidate keeps each migration view's grant whenever that view exists.
  for (const view of Object.keys(MIGRATION_VIEWS)) {
    assert.match(sql, new RegExp(`to_regclass\\('still_qa_checks\\.${view}'\\) is not null then\\s+execute 'grant select on still_qa_checks\\.${view} to still_qa_readonly_checker'`));
    assert.match(sql, new RegExp(`when pg_catalog\\.to_regclass\\('still_qa_checks\\.${view}'\\) is null then 0 else 1 end`));
  }
  // Least privilege: every granted view is used by at least one check.
  const queries = [...CHECKS.flatMap((c) => c.queries), ...PRODUCTION_QUERIES];
  const used = new Set(queries.flatMap((q) => [...assertSingleSelect(q.sql, 2)]));
  assert.deepEqual([...used].sort(), [...CHECK_VIEWS].sort());
  // The role is narrow and read-only by default; the registry table is never granted.
  assert.match(sql, /create role still_qa_readonly_checker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;/);
  assert.match(sql, /alter role still_qa_readonly_checker set default_transaction_read_only = on;/);
  assert.match(sql, /alter role still_qa_readonly_checker set statement_timeout = '15s';/);
  assert.doesNotMatch(sql, /grant [^;]*still_qa_checks\.qa_accounts[^;]*to still_qa_readonly_checker/);
  assert.doesNotMatch(sql, /\bgrant\s+(insert|update|delete|truncate|all)\b/i);
  assert.doesNotMatch(sql, /security definer/i);
  assert.doesNotMatch(sql, /grant [^;]*(qa_scope|qa_rights_scope|qa_alias_owner|qa_accounts_guard)[^;]*to still_qa_readonly_checker/);
});

test("one owner-QA-alias rule guards registration, scope, members and the owner preview", async () => {
  const sql = await read("scripts/backend/sql/qa-readonly-checks-candidate.sql");
  const setup = await read("scripts/backend/qa-checks/owner-setup.mjs");
  const tag = "'^[^+@]+\\+stillqa-[a-z0-9-]+@[^@]+$'";
  const strip = "'\\+stillqa-[a-z0-9-]+@', '@'";
  for (const piece of [tag, strip]) assert.equal(sql.split(piece).length - 1, 3, piece);
  assert.ok(setup.includes(tag.replace(/\\/g, "\\\\")) && setup.includes(strip.replace(/\\/g, "\\\\")));
  // Paid-lane labels must also be sandbox members; deleted accounts stay in scope only by registry.
  assert.match(sql, /a\.label in \('preserved', 'delete'\)\s+or exists \(select 1 from private\.qa_sandbox_subjects/);
  assert.match(sql, /before insert or update on still_qa_checks\.qa_accounts/);
  assert.doesNotMatch(sql, /@cadmuslabs|@gmail|zchartash/i, "no owner address is committed");
  // Holder-less rights are visible only when QA-linked or verified after the registry was filled.
  assert.match(sql, /r\.holder is null and r\.environment = 'sandbox'/);
  assert.match(sql, /from private\.analytics_erasure_jobs j where j\.created_at > pg_catalog\.now\(\) - interval '1 hour'/);
  assert.match(sql, /from private\.access_rights r where r\.environment = 'sandbox'\s+group by/);
});

test("migration 0025 adds one owner-run view of public policy facts and the cutoff, readable only by the checker", async () => {
  const sql = await read(MIGRATION_0025);
  const code = sql.replace(/--[^\n]*/g, "");
  // Ordinary postgres migration role, forward-only, wrapped in one transaction.
  assert.match(code, /^\s*begin;/);
  assert.match(code, /commit;\s*$/);
  assert.match(code, /current_user <> 'postgres' or session_user <> 'postgres'/);
  assert.doesNotMatch(code, /\b(drop|delete|update|insert|truncate|alter)\b/i, "no destructive or data-changing statement");
  assert.doesNotMatch(code, /security definer|security_invoker/i);
  assert.match(code, /create or replace view still_qa_checks\.production_sales_summary with \(security_barrier = true\) as/);
  // It reads only the two product policy tables, and only their production sales rows.
  const relations = [...code.matchAll(/\b(?:from|join)\s+([a-z_]+\.[a-z_]+)/g)].map((m) => m[1])
    .filter((r) => !r.startsWith("pg_catalog."));
  assert.deepEqual([...new Set(relations)].sort(), ["private.paid_cutoff", "private.product_policy_revisions"]);
  assert.match(code, /where r\.namespace = 'sales' and r\.environment = 'production'/);
  assert.match(code, /on c\.environment = 'production'/);
  for (const forbidden of ["access_rights", "auth.users", "profiles", "operation_id", "owner_subject", "preview_hash", "product_policy_owners", "email"])
    assert.ok(!code.includes(forbidden), `the view must not read ${forbidden}`);
  // Grants: clients revoked; SELECT only, only to the narrow checker, only when that role exists.
  assert.match(code, /revoke all on still_qa_checks\.production_sales_summary from public, anon, authenticated, service_role;/);
  const grants = [...code.matchAll(/grant ([a-z ]+?) on ([\w. ]+?) to (\w+)/g)].map((m) => m.slice(1).join(" | "));
  assert.deepEqual(grants, ["select | still_qa_checks.production_sales_summary | still_qa_readonly_checker"]);
  assert.match(code, /if exists \(select 1 from pg_catalog\.pg_roles where rolname = 'still_qa_readonly_checker'\) then\s+execute 'grant select/);
  // The deploy gate and the row invariant exist and pass the deploy runner's read-only lint.
  const gate = await read("scripts/backend/deploy/verify/0025_production_sales_summary_view.sql");
  const invariant = await read("scripts/backend/deploy/verify/0025_production_sales_summary_view.invariant.sql");
  assert.equal(lintVerificationSql(gate), true);
  assert.equal(lintVerificationSql(invariant), true);
  for (const issue of ["migration_version", "view_missing", "view_reads", "view_grant", "client_reach", "checker_select_missing", "schema_grant"])
    assert.ok(gate.includes(`'${issue}'`), issue);
  assert.ok(gate.includes("array['private.paid_cutoff','private.product_policy_revisions']"));
  // With no checker role, `grantee = checker` is NULL; it must never excuse another grantee.
  assert.equal(gate.split("and not coalesce(acl.grantee=roles.checker and").length - 1, 2);
  assert.doesNotMatch(gate, /not \(acl\.grantee=roles\.checker/);
  assert.match(code, /and not coalesce\(a\.grantee = checker and a\.privilege_type = 'SELECT' and not a\.is_grantable, false\)\)/);
  // The gate pins the same column list the catalogue reads.
  const columns = /is distinct from ('[\s\S]*?')\n union all select 'view_reads'/.exec(gate)[1]
    .replace(/'\s*\|\|\s*'/g, "").replace(/^'|'$/g, "").split(",").map((c) => c.split(":")[0]);
  const read0025 = CHECKS.find((c) => c.id === "production-sales").queries
    .flatMap((q) => [...q.sql.matchAll(/\bs\.(\w+)/g)].map((m) => m[1]));
  for (const column of read0025) assert.ok(columns.includes(column), column);
  assert.ok(columns.every((c) => code.includes(` as ${c}`)), "every pinned column is defined by the migration");
});

test("the candidate stays out of supabase/migrations (main ahead of hosted history blocks QA deploys)", async () => {
  const migrations = await readdir(new URL("supabase/migrations/", ROOT));
  assert.ok(!migrations.some((m) => /qa_readonly|readonly_check/.test(m)));
});

test("inputs are a closed check id and QA labels only", () => {
  assert.equal(resolveRequest({ check: "DB-07", account: "web-chrome" }).check.id, "checkout-started");
  assert.deepEqual(resolveRequest({ check: "DB-06", account: "qa-a", accountB: "qa-b" }).labels, ["qa-a", "qa-b"]);
  assert.deepEqual(resolveRequest({ check: "DB-31" }).labels, []);
  assert.equal(resolveRequest({ check: "PROD-01" }).check.id, "production-sales");
  assert.deepEqual(resolveRequest({ check: "PROD-01" }).labels, []);
  const refused = [
    { check: "PROD-01", account: "qa-a" },
    { check: "PROD-02" },
    { check: "production-sales" },
    { check: "DB-36" },
    { check: "DB-99" },
    { check: "account-deleted", account: "delete" },
    { check: "select 1" },
    { check: "DB-07" },
    { check: "DB-07", account: "qa+chrome@example.invalid" },
    { check: "DB-07", account: "c0c0c0c0-0000-4000-8000-000000000001" },
    { check: "DB-07", account: "web-chrome", accountB: "qa-b" },
    { check: "DB-06", account: "qa-a" },
    { check: "DB-06", account: "qa-a", accountB: "qa-a" },
    { check: "DB-31", account: "qa-a" },
  ];
  for (const input of refused) assert.throws(() => resolveRequest(input), InputError, JSON.stringify(input));
});

test("output prints only declared shapes and withholds anything else", () => {
  const id = "c0c0c0c0-0000-4000-8000-000000000001";
  const refKey = "7e".repeat(32);
  assert.equal(formatValue(id, "ref", { refKey }), ref(id, refKey));
  assert.match(ref(id, refKey), /^#[0-9a-f]{10}$/);
  assert.equal(ref(id, refKey), ref(id.toUpperCase(), refKey), "stable");
  assert.notEqual(ref(id, refKey), ref(id, "8f".repeat(32)), "keyed");
  assert.notEqual(ref(id, refKey), `#${createHash("sha256").update(id).digest("hex").slice(0, 10)}`, "not a plain hash");
  assert.throws(() => ref(id, undefined));
  for (const [value, type] of [
    [id, "key"],
    [id, "name"],
    ["a0123456789abcdef0123", "key"],
    ["x_0123456789abcdef01", "name"],
    [{ [id]: true }, "switches"],
    ["someone@example.com", "key"],
    ["someone@example.com", "name"],
    ["cs_test_abc", { type: "state", values: ["session_bound"] }],
    ["not-a-uuid", "ref"],
    ["Bearer abc", "version"],
    [{ "a@b.c": true }, "switches"],
    [{ youtube: "yes" }, "switches"],
    ["12", "bool"],
    [-5, "count"],
    ["2026-13-45", "timestamp"],
    ["abc", "fingerprint"],
    ["root", "label"],
    ["2.1.1.420; drop", "id"],
    ["Still-Free", "id"],
    [id, "id"],
    ["a0123456789abcdef0123", "id"],
    ["someone@example.com", "id"],
    [["youtube.shorts", "someone@example.com"], "ids"],
    [["youtube.shorts", id], "ids"],
    ["youtube.shorts", "ids"],
    [Array.from({ length: 33 }, (_, i) => `b${i}`), "ids"],
    ["still-pro-v4", { type: "state", values: ["still-pro-v3"] }],
  ])
    assert.equal(formatValue(value, type), WITHHELD, JSON.stringify([value, type]));
  assert.equal(formatValue({ "youtube.shorts": true, instagram: false }, "switches"), "instagram=off, youtube.shorts=on");
  assert.equal(formatValue("0021", "version"), "0021");
  assert.equal(formatValue("0123456789abcdef0123456789abcdef", "fingerprint"), "0123456789abcdef");
  assert.equal(formatValue(new Date("2026-10-10T12:00:00.123Z"), "timestamp"), "2026-10-10T12:00:00Z");
  assert.equal(formatValue(7n, "count"), "7");
  assert.equal(formatValue("qa-a", "label"), "QA A (qa-a)");
  assert.equal(formatValue("2.1.1.420", "id"), "2.1.1.420");
  assert.equal(formatValue("still-free-v2", "id"), "still-free-v2");
  assert.equal(formatValue(["facebook.reels", "youtube.shorts"], "ids"), "facebook.reels, youtube.shorts");
  assert.equal(formatValue([], "ids"), "(empty)");
  assert.equal(formatValue("9", "number"), "9");
});

test("PROD-01 renders production sales facts and the cutoff, and withholds anything else", () => {
  const request = resolveRequest({ check: "PROD-01" });
  const [policy, builds, cutoff] = request.check.queries;
  const at = new Date("2026-10-21T12:00:00Z");
  const render = (rows) =>
    renderReport({ ...request, holders: [], refKey: "7e".repeat(32), verdict: "needs-review",
      results: request.check.queries.map((query, i) => ({ query, rows: rows[i] })) });
  // Before go-live: no revision (Off), expected revision 0, no cutoff.
  const off = render([
    [{ sales_revision: null, expected_revision: "0", sales_published_at: null, sales_enabled: null, apple_enabled: null, apple_offer: null, web_enabled: null, web_offer: null }],
    [],
    [{ cutoff_present: false, cutoff_product: null, cutoff_benefits: null, cutoff_sales_revision: null, cutoff_activated_at: null }],
  ]);
  assert.match(off, /\| none \| 0 \| none \| none \| none \| none \| none \| none \|/);
  assert.match(off, /### production approved builds\n\n\(no rows\)/);
  assert.match(off, /\| no \| none \| none \| none \| none \|/);
  assert.doesNotMatch(off, /withheld/);
  // After go-live: the revision, both offers, the 3.0 builds and the write-once cutoff.
  const on = render([
    [{ sales_revision: "3", expected_revision: "3", sales_published_at: at, sales_enabled: true, apple_enabled: true, apple_offer: "still-pro-v3", web_enabled: true, web_offer: "still-pro-v3" }],
    [{ surface: "apple_mobile_host", build: "3.0.0" }, { surface: "chrome_desktop", build: "3.0.0.1" }],
    [{ cutoff_present: true, cutoff_product: "still-free-v2", cutoff_benefits: ["facebook.reels", "youtube.shorts"], cutoff_sales_revision: "3", cutoff_activated_at: at }],
  ]);
  assert.match(on, /\| 3 \| 3 \| 2026-10-21T12:00:00Z \| yes \| yes \| still-pro-v3 \| yes \| still-pro-v3 \|/);
  assert.match(on, /\| apple_mobile_host \| 3\.0\.0 \|/);
  assert.match(on, /\| yes \| still-free-v2 \| facebook\.reels, youtube\.shorts \| 3 \| 2026-10-21T12:00:00Z \|/);
  assert.doesNotMatch(on, /withheld/);
  // A hostile row never prints an id, an email or free text.
  const holder = "c0c0c0c0-0000-4000-8000-000000000002";
  const hostile = render([
    [{ sales_revision: holder, expected_revision: "a@b.c", sales_published_at: "x", sales_enabled: "yes", apple_enabled: true, apple_offer: "free text", web_enabled: true, web_offer: holder }],
    [{ surface: "https://example.com", build: holder }],
    [{ cutoff_present: true, cutoff_product: "a@b.c", cutoff_benefits: [holder], cutoff_sales_revision: 1, cutoff_activated_at: at }],
  ]);
  assert.doesNotMatch(hostile, UUID);
  assert.ok(!hostile.includes("a@b.c") && !hostile.includes("free text") && !hostile.includes("example.com"));
  assert.match(hostile, /10 value\(s\) withheld/);
  assert.deepEqual(Object.values(policy.fields).map((t) => (typeof t === "string" ? t : t.type)), ["number", "number", "timestamp", "bool", "bool", "state", "bool", "state"]);
  assert.deepEqual(builds.fields.build, "id");
  assert.deepEqual(cutoff.fields.cutoff_benefits, "ids");
});

test("a rendered report never contains a raw id or email, even from a hostile row", () => {
  const request = resolveRequest({ check: "DB-09", account: "web-chrome" });
  const holder = "c0c0c0c0-0000-4000-8000-000000000002";
  const hostile = { status: "a@b.c", paid: true, created_at: new Date(), right_id: holder, environment: holder, provider_source: "apple", provider_product: "still_pro_v3", ownership_revision: 1, active: true, verified: new Date(), legacy_entitlements: holder };
  const results = request.check.queries.map((query) => ({ query, rows: [hostile] }));
  const report = renderReport({ ...request, holders: [holder], results, refKey: "7e".repeat(32), verdict: "needs-review" });
  assert.doesNotMatch(report, UUID);
  assert.ok(!report.includes("a@b.c"));
  assert.match(report, /value\(s\) withheld/);
  assert.ok(report.includes(LABELS["web-chrome"]));
});

test("machine verdicts are only pass or fail where the expectation is exact; otherwise needs-review", () => {
  const check = (id) => CHECKS.find((c) => c.programIds.includes(id) || c.id === id);
  assert.equal(check("DB-15").verdict([[{ rights: 0, operations: "0" }]]), "pass");
  assert.equal(check("DB-15").verdict([[{ rights: 1, operations: 0 }]]), "fail");
  assert.equal(check("DB-33").verdict([[{ a: 0, b: 0, c: 0 }]]), "pass");
  assert.equal(check("DB-32").verdict([[], [], [{ row_security: true }]]), "pass");
  assert.equal(check("DB-32").verdict([[{ relation: "x" }], [], []]), "fail");
  assert.equal(check("DB-31").verdict([[], [{ a: 0, b: 0, c: 0 }], []], "unchanged"), "pass");
  assert.equal(check("DB-31").verdict([[], [{ a: 0, b: 0, c: 0 }], []], "changed"), "fail");
  assert.equal(check("DB-31").verdict([[], [{ a: 0, b: 0, c: 0 }], []], "no-baseline"), undefined);
  assert.equal(check("DB-35").verdict([], "changed"), "fail");
  assert.equal(check("DB-35").verdict([], "unchanged"), undefined);
  const registry = (labels, extra = {}) => labels.map((label) => ({ label, in_scope: true, ...extra }));
  const all = Object.keys(LABELS);
  const eight = all.filter((l) => l !== "preserved");
  assert.deepEqual(REQUIRED_LABELS, eight);
  assert.deepEqual(OPTIONAL_LABELS, ["preserved"]);
  assert.equal(check("setup").verdict([registry(all)]), "pass");
  assert.equal(check("setup").verdict([registry(eight)]), "pass", "preserved is optional");
  assert.equal(check("setup").verdict([registry(eight.filter((l) => l !== "qa-a"))]), "fail");
  assert.equal(check("setup").verdict([[...registry(eight), { label: "preserved", in_scope: false }]]), "fail");
  assert.equal(check("setup").verdict([[...registry(eight), ...registry(["qa-a"])]]), "fail", "duplicate label");
  assert.deepEqual(check("setup").notes([registry(eight)]), [
    'Preserved QA account (preserved): not registered (not a QA alias); checks that name it answer "unavailable".',
  ]);
  assert.deepEqual(check("setup").notes([registry(all)]), []);
  const identity = { auth_present: true, confirmed: true, banned: false, deleted: false, in_scope: true };
  assert.equal(check("DB-02").verdict([registry(eight, identity)]), "pass");
  assert.equal(check("DB-02").verdict([registry(eight, { ...identity, confirmed: false })]), "fail");
  assert.deepEqual(check("DB-02").notes([registry(eight, identity)]).length, 1);
  assert.equal(check("DB-07").verdict, undefined);
  // PROD-01 states facts for the operator to read: only a missing summary row is a machine failure.
  assert.equal(check("PROD-01").verdict([[{}], [], [{}]]), undefined);
  assert.equal(check("PROD-01").verdict([[], [], []]), "fail");
  assert.equal(check("PROD-01").verdict([[{}, {}], [], [{}]]), "fail");
});

const WORKFLOW = ".github/workflows/supabase-readonly-checks.yml";

function value(node) {
  if (node.type === "mapping" || node.type === "flowMapping")
    return Object.fromEntries(node.children.map(({ children: [k, v] }) => [value(k), value(v)]));
  if (node.type === "sequence" || node.type === "flowSequence") return node.children.map(value);
  if (["plain", "quoteDouble", "quoteSingle", "blockLiteral", "blockFolded"].includes(node.type)) return node.value;
  if (["mappingKey", "mappingValue", "sequenceItem", "flowSequenceItem", "documentBody"].includes(node.type))
    return node.children.length ? value(node.children[0]) : null;
  assert.fail(`Unsupported workflow node: ${node.type}`);
}
async function loadWorkflow(path) {
  const text = await read(path);
  return { text, workflow: value((await parsers.yaml.parse(text)).children[0].children[1]) };
}

test("the workflow is manual, main-only, serialized, pinned and offers exactly the catalogue", async () => {
  const { workflow } = await loadWorkflow(WORKFLOW);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const { inputs } = workflow.on.workflow_dispatch;
  assert.deepEqual(Object.keys(inputs), ["check", "account", "account_b"]);
  for (const input of Object.values(inputs)) assert.equal(input.type, "choice");
  assert.deepEqual(inputs.check.options, CHECK_INPUTS);
  assert.deepEqual(inputs.account.options, ["none", ...Object.keys(LABELS)]);
  assert.deepEqual(inputs.account_b.options, ["none", ...Object.keys(LABELS)]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, { group: "supabase-readonly-checks", "cancel-in-progress": "false" });
  assert.deepEqual(Object.keys(workflow.jobs), ["check"]);
  const job = workflow.jobs.check;
  assert.equal(job.environment, READONLY_ENVIRONMENT);
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  for (const step of job.steps.filter((s) => s.uses))
    assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, step.uses);
  const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["persist-credentials"], "false");
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  const protection = job.steps.findIndex((s) => /protection\.mjs/.test(s.run ?? ""));
  const run = job.steps.findIndex((s) => /qa-checks\/run\.ts/.test(s.run ?? ""));
  assert.ok(protection >= 0 && run > protection, "protection must be verified before the check");
});

test("the workflow sees only its two secrets, only in the check step, and never interpolates inputs into a shell", async () => {
  const { text, workflow } = await loadWorkflow(WORKFLOW);
  assert.deepEqual([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]), ["STILL_QA_READONLY_DB_URL", "STILL_QA_READONLY_REF_KEY"]);
  assert.deepEqual([...text.matchAll(/vars\.(\w+)/g)].map((m) => m[1]), ["STILL_QA_READONLY_AUTHORIZATION", "STILL_QA_READONLY_REPORT_PUBKEY", "STILL_QA_READONLY_CA_PEM"]);
  for (const step of workflow.jobs.check.steps) {
    assert.doesNotMatch(step.run ?? "", /\$\{\{/, "expressions belong in env, not run");
    if (!/qa-checks\/run\.ts/.test(step.run ?? "")) assert.doesNotMatch(JSON.stringify(step), /secrets\./);
  }
  assert.doesNotMatch(text, /supabase (db|link|login|migration|functions|secrets)|setup-cli/);
  // The public log never receives the report: it is encrypted with a pinned, checksummed age.
  assert.match(text, /age-v1\.2\.1-linux-amd64\.tar\.gz/);
  assert.match(text, /7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50 {2}\$RUNNER_TEMP\/age\.tgz" \| sha256sum -c -/);
  const uploads = workflow.jobs.check.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
  assert.deepEqual(uploads.map((u) => u.with.path), ["${{ runner.temp }}/qa-report/report.age", "${{ runner.temp }}/qa-baseline-out/baseline.json"]);
  assert.doesNotMatch(text, /GITHUB_STEP_SUMMARY.*report|cat .*report/);
  assert.doesNotMatch(text, /SUPABASE_PRODUCTION|QA_SANDBOX_SUBJECT_EMAILS_JSON|SERVICE_ROLE/);
});

test("no other workflow can reach the read-only environment or its secret", async () => {
  for (const name of await readdir(new URL(".github/workflows/", ROOT))) {
    if (`.github/workflows/${name}` === WORKFLOW || !/\.ya?ml$/.test(name)) continue;
    const { text, workflow } = await loadWorkflow(`.github/workflows/${name}`);
    for (const job of Object.values(workflow.jobs ?? {})) {
      const environment = typeof job.environment === "object" ? job.environment?.name : job.environment;
      assert.notEqual(String(environment ?? "").toLowerCase(), READONLY_ENVIRONMENT, name);
    }
    assert.ok(!text.includes("STILL_QA_READONLY_DB_URL"), name);
  }
});

function protectionFixture() {
  const environment = {
    name: READONLY_ENVIRONMENT, id: 7, can_admins_bypass: false,
    protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 257643931 } }] }, { type: "branch_policy" }],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  };
  const branches = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };
  const approvals = [{ state: "approved", user: { id: 257643931 }, environments: [{ id: 7 }] }];
  const repository = "ZackC-1/still-app", sha = "a".repeat(40);
  const run = { head_branch: "main", head_sha: sha, event: "workflow_dispatch", run_attempt: 1,
    path: ".github/workflows/supabase-readonly-checks.yml", repository: { full_name: repository }, head_repository: { full_name: repository } };
  const env = { GITHUB_REPOSITORY: repository, GH_TOKEN: "synthetic", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `${repository}/${run.path}@refs/heads/main` };
  const fake = (overrides = {}) => async (url, options) => {
    assert.equal(options.method, "GET");
    const body = { environment, branches, approvals, run, ...overrides };
    const pick = url.endsWith("/approvals") ? body.approvals : url.includes("deployment-branch-policies") ? body.branches
      : url.endsWith("/actions/runs/1") ? body.run : url.endsWith(`/environments/${READONLY_ENVIRONMENT}`) ? body.environment : null;
    return pick === null ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => pick };
  };
  return { environment, branches, approvals, env, fake, run };
}
async function quietProtection(env, fake) {
  const quiet = console.log; console.log = () => {};
  try { return await protectionMain(env, fake); } finally { console.log = quiet; }
}
test("default protection still requires exactly the owner and observed run approval", async () => {
  const f = protectionFixture();
  assert.equal(await quietProtection(f.env, f.fake()), 0);
  for (const override of [{ approvals: [] }, { environment: { ...f.environment, can_admins_bypass: true } },
    { environment: null }, { branches: { total_count: 0, branch_policies: [] } }]) {
    assert.equal(await quietProtection(f.env, f.fake(override)), 1);
  }
});
test("standing authorization permits only the dedicated main workflow without a reviewer gate", async () => {
  const f = protectionFixture();
  const env = { ...f.env, STILL_QA_READONLY_AUTHORIZATION: "standing-v1" };
  const environment = { ...f.environment, protection_rules: [{ type: "branch_policy" }] };
  assert.equal(await quietProtection(env, f.fake({ environment, approvals: [] })), 0);
  assert.equal(await quietProtection(f.env, f.fake({ environment, approvals: [] })), 1);
  assert.equal(await quietProtection(env, f.fake()), 1, "standing must not silently accept a still-gated environment");
  for (const override of [
    { environment: { ...environment, name: "supabase-production" } },
    { environment: { ...environment, can_admins_bypass: true } },
    { environment: { ...environment, protection_rules: [{ type: "wait_timer" }] } },
    { environment: { ...environment, protection_rules: [{ type: "custom_protection_rule" }] } },
    { branches: { total_count: 1, branch_policies: [{ name: "main", type: "tag" }] } },
    { branches: { total_count: 2, branch_policies: [{ name: "main" }, { name: "*" }] } },
    { run: { ...f.run, path: ".github/workflows/supabase-deploy.yml" } },
    { run: { ...f.run, head_branch: "feature" } },
    { run: { ...f.run, head_sha: "b".repeat(40) } },
    { run: { ...f.run, event: "push" } },
    { run: { ...f.run, run_attempt: 2 } },
    { run: { ...f.run, head_repository: { full_name: "other/repo" } } },
    { run: null },
  ]) assert.equal(await quietProtection(env, f.fake({ environment, approvals: [], ...override })), 1);
  for (const override of [
    { STILL_QA_READONLY_AUTHORIZATION: "yes" }, { GITHUB_REF: "refs/tags/main" },
    { GITHUB_WORKFLOW_REF: "ZackC-1/still-app/.github/workflows/other.yml@refs/heads/main" },
    { GITHUB_EVENT_NAME: "push" }, { GITHUB_RUN_ID: "1/approvals" },
  ]) assert.equal(await quietProtection({ ...env, ...override }, f.fake({ environment, approvals: [] })), 1);
});

function baselineFixture() {
  const repository = "ZackC-1/still-app";
  const db01 = (id, created, extra = {}) => ({ id, created_at: created, path: WORKFLOW_PATH, head_branch: "main",
    event: "workflow_dispatch", status: "completed", conclusion: "success",
    display_title: "Read-only QA check DB-01 none none",
    repository: { full_name: repository }, head_repository: { full_name: repository }, ...extra });
  const artifact = { name: BASELINE_ARTIFACT, expired: false };
  /** pages: arrays of runs; artifacts: run id -> artifact list. Records every requested URL. */
  const fake = ({ pages, artifacts = {}, failRuns = false }) => {
    const urls = [];
    const fetchImpl = async (url, options) => {
      urls.push(url);
      assert.equal(options.method, "GET");
      const runs = url.match(/\/actions\/workflows\/supabase-readonly-checks\.yml\/runs\?per_page=100&page=(\d+)$/);
      if (runs) {
        if (failRuns) return { ok: false, status: 500 };
        const total = pages.reduce((n, p) => n + p.length, 0);
        return { ok: true, status: 200, json: async () => ({ total_count: total, workflow_runs: pages[Number(runs[1]) - 1] ?? [] }) };
      }
      const art = url.match(/\/actions\/runs\/(\d+)\/artifacts\?name=qa-production-baseline&per_page=100$/);
      if (art) return { ok: true, status: 200, json: async () => ({ artifacts: artifacts[art[1]] ?? [] }) };
      return { ok: false, status: 404 };
    };
    return { fetchImpl, urls };
  };
  return { repository, db01, artifact, fake };
}
const findBaseline = (f, options) => findBaselineRun({ repository: f.repository, token: "synthetic", ...options });
const baselineReason = (promise) => promise.then(() => assert.fail("expected a refusal"), (e) => {
  assert.ok(e instanceof BaselineError, String(e));
  return e.message;
});

test("the baseline lookup lists runs without a branch or status filter (ISS-0120)", async () => {
  const f = baselineFixture();
  const { fetchImpl, urls } = f.fake({ pages: [[f.db01(39718854455, "2026-10-21T10:00:00Z")]], artifacts: { 39718854455: [f.artifact] } });
  assert.equal(await findBaseline(f, { fetchImpl }), 39718854455);
  for (const url of urls) assert.doesNotMatch(url, /[?&](branch|status|event)=/);
  const { text } = await loadWorkflow(WORKFLOW);
  assert.match(text, /node scripts\/backend\/qa-checks\/baseline\.mjs/);
  assert.doesNotMatch(text, /gh run list|--branch main|--status success/);
  assert.doesNotMatch(text, /--name qa-production-baseline[^\n]*\|\| true/, "a failed download must not be ignored");
});

test("the baseline lookup picks the newest successful main DB-01 dispatch that still carries the artifact", async () => {
  const f = baselineFixture();
  const skipped = [
    f.db01(901, "2026-10-22T09:00:00Z", { head_branch: "feature" }),
    f.db01(902, "2026-10-22T08:00:00Z", { event: "push" }),
    f.db01(903, "2026-10-22T07:00:00Z", { conclusion: "failure" }),
    f.db01(904, "2026-10-22T06:00:00Z", { display_title: "Read-only QA check DB-35 none none" }),
    f.db01(905, "2026-10-22T05:00:00Z", { head_repository: { full_name: "fork/still-app" } }),
    f.db01(906, "2026-10-22T04:00:00Z"), // right shape, artifact missing
    f.db01(907, "2026-10-22T03:00:00Z"), // right shape, artifact expired
  ];
  const older = f.db01(800, "2026-10-01T00:00:00Z");
  const newest = f.db01(850, "2026-10-21T00:00:00Z");
  const artifacts = Object.fromEntries([...skipped, older, newest].map((r) => [r.id, [f.artifact]]));
  artifacts[906] = [{ name: "qa-report-906", expired: false }];
  artifacts[907] = [{ ...f.artifact, expired: true }];
  // Older run listed first and the newest one on the second page: order comes from created_at.
  const pages = [[older, ...skipped, ...Array.from({ length: 92 }, (_, i) => f.db01(100 + i, "2026-09-01T00:00:00Z", { conclusion: "cancelled" }))], [newest]];
  const { fetchImpl, urls } = f.fake({ pages, artifacts });
  assert.equal(await findBaseline(f, { fetchImpl }), 850);
  assert.ok(urls.some((u) => u.endsWith("page=2")), "paginates past a full first page");
  for (const id of [901, 902, 903, 904, 905]) assert.ok(!urls.some((u) => u.includes(`/runs/${id}/`)), `run ${id} is not a candidate`);
  // With the newest gone, the artifact check skips the missing and expired ones.
  const second = f.fake({ pages: [[older, ...skipped]], artifacts });
  assert.equal(await findBaseline(f, { fetchImpl: second.fetchImpl }), 800);
});

test("no baseline is a named failure, never a silent pass-through", async () => {
  const f = baselineFixture();
  assert.equal(await baselineReason(findBaseline(f, { fetchImpl: f.fake({ pages: [[]] }).fetchImpl })), "baseline-not-found");
  assert.equal(await baselineReason(findBaseline(f, { fetchImpl: f.fake({ pages: [[f.db01(1, "2026-10-21T00:00:00Z", { head_branch: "release" })]], artifacts: { 1: [f.artifact] } }).fetchImpl })), "baseline-not-found");
  assert.equal(await baselineReason(findBaseline(f, { fetchImpl: f.fake({ pages: [[f.db01(2, "2026-10-21T00:00:00Z")]] }).fetchImpl })), "baseline-not-found");
  assert.equal(await baselineReason(findBaseline(f, { fetchImpl: f.fake({ pages: [], failRuns: true }).fetchImpl })), "github-runs-unreadable");
  assert.equal(await baselineReason(findBaseline(f, { fetchImpl: async () => { throw new Error("offline"); } })), "github-runs-unreadable");
  assert.equal(await baselineReason(findBaselineRun({ repository: "bad repo", fetchImpl: f.fake({ pages: [[]] }).fetchImpl })), "repository-invalid");
  const quiet = { log: console.log, error: console.error };
  const out = [];
  console.log = (line) => out.push(line); console.error = () => {};
  try {
    const env = { GITHUB_REPOSITORY: f.repository, GH_TOKEN: "synthetic" };
    assert.equal(await baselineMain(env, f.fake({ pages: [[]] }).fetchImpl), 1);
    assert.deepEqual(out, [], "nothing on stdout for the workflow to mistake for a run id");
    assert.equal(await baselineMain(env, f.fake({ pages: [[f.db01(42, "2026-10-21T00:00:00Z")]], artifacts: { 42: [f.artifact] } }).fetchImpl), 0);
    assert.deepEqual(out, ["42"]);
  } finally { Object.assign(console, quiet); }
});

test("owner setup helpers emit only a verifier, an expiry, a key and digests", async () => {
  const { loginArtifacts, registrySql } = await import("./owner-setup.mjs");
  const password = "0123456789abcdef".repeat(4);
  const refKey = "fe".repeat(32);
  const login = loginArtifacts({
    projectRef: "abcdefghijklmnopqrst",
    poolerHost: "aws-0-us-west-2.pooler.supabase.com",
    password,
    refKey,
    validUntil: new Date("2026-12-09T00:00:00Z"),
  });
  const [statement] = login.split("\n").filter((l) => l.startsWith("alter role"));
  assert.match(statement, /^alter role still_qa_readonly_checker with login password 'SCRAM-SHA-256\$4096:[^']+' valid until '2026-12-09';$/);
  assert.ok(!statement.includes(password));
  assert.match(login, /postgresql:\/\/still_qa_readonly_checker\.abcdefghijklmnopqrst:[0-9a-f]{64}@aws-0-us-west-2\.pooler\.supabase\.com:5432\/postgres/);
  assert.ok(login.includes(`STILL_QA_READONLY_REF_KEY:\n${refKey}`));
  assert.throws(() => loginArtifacts({ projectRef: "x", poolerHost: "aws-0-us-west-2.pooler.supabase.com", password }));
  assert.throws(() => loginArtifacts({ projectRef: "abcdefghijklmnopqrst", poolerHost: "evil.example.com", password }));
  const accounts = Object.fromEntries(Object.keys(LABELS).map((l) => [l, `Owner+stillqa-${l}@Example.invalid`]));
  const sql = registrySql(accounts);
  assert.ok(!sql.includes("@Example") && !sql.includes("owner+") && !/owner@/i.test(sql), "an email reached the registry SQL");
  const [preview, commit] = sql.split("-- B. COMMIT");
  assert.match(preview, /^-- A\. PREVIEW/);
  assert.doesNotMatch(preview, /\binsert\b|\bupdate\b|\bbegin\b/i, "the preview only reads");
  assert.match(preview, /masked_email/);
  assert.match(preview, /as qa_alias/);
  assert.match(commit, /begin;[\s\S]*insert into still_qa_checks\.qa_alias_owner[\s\S]*insert into still_qa_checks\.qa_accounts[\s\S]*commit;/);
  const base = createHash("sha256").update("owner@example.invalid").digest("hex");
  assert.equal(sql.split(`'${base}'`).length - 1, 2, "base mailbox digest in preview and commit");
  assert.ok(sql.includes(createHash("sha256").update("owner+stillqa-qa-a@example.invalid").digest("hex")));
  assert.match(sql, /-- Expect 9\./);
  // The Preserved QA account is not an alias: it is optional and left out, never registered.
  const { preserved: _preserved, ...eight } = accounts;
  for (const input of [eight, { ...eight, preserved: "older.account@example.invalid" }]) {
    const without = registrySql(input);
    assert.match(without, /^-- preserved: left out \(not a \+stillqa alias/);
    assert.match(without, /Every one of the 8 rows/);
    assert.match(without, /-- Expect 8\./);
    assert.ok(!without.includes("('preserved'"), "preserved must not be previewed or registered");
    assert.ok(!without.includes(createHash("sha256").update("older.account@example.invalid").digest("hex")));
    assert.ok(!without.includes("older.account"));
  }
  assert.throws(() => registrySql({ ...eight, "qa-a": undefined }), /qa-a needs one email/);
  const { "qa-a": _qaA, ...seven } = eight;
  assert.throws(() => registrySql(seven), /missing: qa-a/);
  assert.throws(() => registrySql({ ...accounts, admin: "owner+stillqa-x@example.invalid" }));
  assert.throws(() => registrySql({ "qa-a": accounts["qa-a"] }));
  assert.throws(() => registrySql({ ...accounts, "qa-b": accounts["qa-a"] }));
  assert.throws(() => registrySql({ ...accounts, "qa-b": "customer@example.invalid" }), /not a \+stillqa/);
  assert.throws(() => registrySql({ ...accounts, "qa-b": "someone+stillqa-qa-b@example.invalid" }), /same mailbox/);
  assert.throws(() => registrySql({ ...accounts, "qa-b": "x'); drop table y; --+stillqa-a@example.invalid" }));
});
