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
  queryParams,
  resolveRequest,
} from "./catalogue.mjs";
import { CHECK_VIEWS, GuardError, assertSingleSelect } from "./sql-guard.mjs";
import { WITHHELD, formatValue, ref, renderReport } from "./report.mjs";
import { READONLY_ENVIRONMENT, main as protectionMain } from "./protection.mjs";

const ROOT = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PROGRAMME_IDS = Array.from({ length: 38 }, (_, i) => `DB-${String(i + 1).padStart(2, "0")}`);

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

test("every programme DB step is either answered once or marked not read-only", () => {
  const answered = CHECKS.flatMap((c) => c.programIds);
  assert.equal(new Set(answered).size, answered.length, "a step is answered twice");
  assert.deepEqual([...answered, ...Object.keys(NOT_READ_ONLY)].sort(), PROGRAMME_IDS);
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

test("the views the catalogue reads are exactly the views the candidate SQL creates and grants", async () => {
  const sql = await read("scripts/backend/sql/qa-readonly-checks-candidate.sql");
  const created = [...sql.matchAll(/create or replace view still_qa_checks\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...created].sort(), [...CHECK_VIEWS].sort());
  const grant = /grant select on ([\s\S]*?)\s+to still_qa_readonly_checker;/.exec(sql);
  const granted = grant[1].split(",").map((s) => s.trim().replace(/^still_qa_checks\./, ""));
  assert.deepEqual([...granted].sort(), [...CHECK_VIEWS].sort());
  assert.match(sql, new RegExp(`where a\\.grantee = checker\\) <> ${CHECK_VIEWS.length}\\b`));
  // Least privilege: every granted view is used by at least one check.
  const used = new Set(CHECKS.flatMap((c) => c.queries.flatMap((q) => [...assertSingleSelect(q.sql, 2)])));
  assert.deepEqual([...used].sort(), [...CHECK_VIEWS].sort());
  // The role is narrow and read-only by default; the registry table is never granted.
  assert.match(sql, /create role still_qa_readonly_checker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;/);
  assert.match(sql, /alter role still_qa_readonly_checker set default_transaction_read_only = on;/);
  assert.match(sql, /alter role still_qa_readonly_checker set statement_timeout = '15s';/);
  assert.doesNotMatch(sql, /grant [^;]*still_qa_checks\.qa_accounts[^;]*to still_qa_readonly_checker/);
  assert.doesNotMatch(sql, /\bgrant\s+(insert|update|delete|truncate|all)\b/i);
  assert.doesNotMatch(sql, /security definer/i);
});

test("the candidate stays out of supabase/migrations (main ahead of hosted history blocks QA deploys)", async () => {
  const migrations = await readdir(new URL("supabase/migrations/", ROOT));
  assert.ok(!migrations.some((m) => /qa_readonly|readonly_check/.test(m)));
});

test("inputs are a closed check id and QA labels only", () => {
  assert.equal(resolveRequest({ check: "DB-07", account: "web-chrome" }).check.id, "checkout-started");
  assert.deepEqual(resolveRequest({ check: "DB-06", account: "qa-a", accountB: "qa-b" }).labels, ["qa-a", "qa-b"]);
  assert.deepEqual(resolveRequest({ check: "DB-31" }).labels, []);
  const refused = [
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
  assert.equal(formatValue(id, "ref"), ref(id));
  assert.match(ref(id), /^#[0-9a-f]{10}$/);
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
  ])
    assert.equal(formatValue(value, type), WITHHELD, JSON.stringify([value, type]));
  assert.equal(formatValue({ "youtube.shorts": true, instagram: false }, "switches"), "instagram=off, youtube.shorts=on");
  assert.equal(formatValue("0021", "version"), "0021");
  assert.equal(formatValue("0123456789abcdef0123456789abcdef", "fingerprint"), "0123456789abcdef");
  assert.equal(formatValue(new Date("2026-10-10T12:00:00.123Z"), "timestamp"), "2026-10-10T12:00:00Z");
  assert.equal(formatValue(7n, "count"), "7");
  assert.equal(formatValue("qa-a", "label"), "QA A (qa-a)");
});

test("a rendered report never contains a raw id or email, even from a hostile row", () => {
  const request = resolveRequest({ check: "DB-09", account: "web-chrome" });
  const holder = "c0c0c0c0-0000-4000-8000-000000000002";
  const hostile = { status: "a@b.c", paid: true, created_at: new Date(), right_id: holder, environment: holder, provider_source: "apple", provider_product: "still_pro_v3", ownership_revision: 1, active: true, verified: new Date(), legacy_entitlements: holder };
  const results = request.check.queries.map((query) => ({ query, rows: [hostile] }));
  const report = renderReport({ ...request, holders: [holder], results });
  assert.doesNotMatch(report, UUID);
  assert.ok(!report.includes("a@b.c"));
  assert.match(report, /value\(s\) withheld/);
  assert.ok(report.includes(LABELS["web-chrome"]));
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

test("the workflow sees only the read-only secret, only in the check step, and never interpolates inputs into a shell", async () => {
  const { text, workflow } = await loadWorkflow(WORKFLOW);
  assert.deepEqual([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]), ["STILL_QA_READONLY_DB_URL"]);
  for (const step of workflow.jobs.check.steps) {
    assert.doesNotMatch(step.run ?? "", /\$\{\{/, "expressions belong in env, not run");
    if (!/qa-checks\/run\.ts/.test(step.run ?? "")) assert.doesNotMatch(JSON.stringify(step), /secrets\./);
  }
  assert.doesNotMatch(text, /supabase (db|link|login|migration|functions|secrets)|setup-cli/);
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

test("the protection step refuses unless the environment is owner-only and the owner approved this run", async () => {
  const environment = {
    name: READONLY_ENVIRONMENT,
    id: 7,
    can_admins_bypass: false,
    protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 257643931 } }] }],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  };
  const branches = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };
  const approvals = [{ state: "approved", user: { id: 257643931 }, environments: [{ id: 7 }] }];
  const fake = (overrides = {}) => async (url) => {
    const body = { environment, branches, approvals, ...overrides };
    const pick = url.includes("/approvals") ? body.approvals : url.includes("deployment-branch-policies") ? body.branches : body.environment;
    if (!url.includes(`/environments/${READONLY_ENVIRONMENT}`) && !url.includes("/approvals")) return { ok: false, status: 404 };
    return pick === null ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => pick };
  };
  const env = { GITHUB_REPOSITORY: "ZackC-1/still-app", GH_TOKEN: "synthetic", GITHUB_RUN_ID: "1" };
  const quiet = console.log;
  console.log = () => {};
  try {
    assert.equal(await protectionMain(env, fake()), 0);
    assert.equal(await protectionMain(env, fake({ approvals: [] })), 1);
    assert.equal(await protectionMain(env, fake({ environment: { ...environment, can_admins_bypass: true } })), 1);
    assert.equal(await protectionMain(env, fake({ environment: null })), 1);
    assert.equal(await protectionMain(env, fake({ branches: { total_count: 0, branch_policies: [] } })), 1);
  } finally {
    console.log = quiet;
  }
});

test("owner setup helpers emit only a SCRAM verifier and email digests", async () => {
  const { loginArtifacts, registrySql } = await import("./owner-setup.mjs");
  const password = "0123456789abcdef".repeat(4);
  const login = loginArtifacts({ projectRef: "abcdefghijklmnopqrst", poolerHost: "aws-0-us-west-2.pooler.supabase.com", password });
  const [statement] = login.split("\n").filter((l) => l.startsWith("alter role"));
  assert.match(statement, /^alter role still_qa_readonly_checker with login password 'SCRAM-SHA-256\$4096:[^']+';$/);
  assert.ok(!statement.includes(password));
  assert.match(login, /postgresql:\/\/still_qa_readonly_checker\.abcdefghijklmnopqrst:[0-9a-f]{64}@aws-0-us-west-2\.pooler\.supabase\.com:5432\/postgres/);
  assert.throws(() => loginArtifacts({ projectRef: "x", poolerHost: "aws-0-us-west-2.pooler.supabase.com", password }));
  assert.throws(() => loginArtifacts({ projectRef: "abcdefghijklmnopqrst", poolerHost: "evil.example.com", password }));
  const accounts = Object.fromEntries(Object.keys(LABELS).map((l) => [l, `QA+${l}@Example.invalid`]));
  const sql = registrySql(accounts);
  assert.ok(!sql.includes("@"), "an email reached the registry SQL");
  assert.equal([...sql.matchAll(/'[0-9a-f]{64}'/g)].length, 9);
  assert.ok(sql.includes(createHash("sha256").update("qa+qa-a@example.invalid").digest("hex")));
  assert.throws(() => registrySql({ ...accounts, admin: "x@example.invalid" }));
  assert.throws(() => registrySql({ "qa-a": "x@example.invalid" }));
  assert.throws(() => registrySql({ ...accounts, "qa-b": accounts["qa-a"] }));
  assert.throws(() => registrySql({ ...accounts, "qa-b": "x'); drop table y; --@example.invalid" }));
});
