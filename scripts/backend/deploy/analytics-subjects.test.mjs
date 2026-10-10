// Offline tests for the analytics-subjects operations (analytics-subjects.mjs): plan binding and
// refusals, every hard gate, the decisions and write order of each operation, the public records,
// and the CLI wiring. The database is a small in-memory model of the facts the pinned SQL reads and
// writes; the real-database rehearsal of the whole lifecycle runs in the operation rehearsal job.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertSamePlan,
  checkFreshness,
  defaultExec,
  lintVerificationSql,
  main,
  makeGit,
  Refusal,
  sha256,
} from "./deploy.mjs";
import {
  PROVIDER_CHECK_CODES,
  providerCodes,
  proveProvider,
  secretsTokenProbe,
  ANALYTICS_KIND,
  ANALYTICS_OPERATIONS,
  ANALYTICS_SQL,
  ANALYTICS_TOOLING,
  assertWritableSecret,
  CRON_SCHEDULE,
  createAnalyticsPlan,
  deployedMatches,
  ERASER_ROLE,
  ERASER_URL_SECRET,
  eraserDbUrl,
  EVENT_ID_SECRET,
  FUNCTIONS_OP,
  FUNCTIONS_TOKEN_ENV,
  gateCodes,
  LATER_MIGRATION_CODES,
  MIGRATION_GATE,
  parseFacts,
  POSTHOG_SECRETS,
  rehearsalApi,
  rehearsalGreen,
  REHEARSAL_REPOSITORY,
  REHEARSAL_WORKFLOW,
  renderAnalyticsFinal,
  renderAnalyticsPlan,
  runAnalyticsOperation,
  SCHEDULE_OP,
  SECRETS_OP,
  SECRETS_TOKEN_ENV,
  siblingPlan,
  SWITCH_OP,
  SWITCH_SECRET,
  VAULT_TOKEN_NAME,
  workerCommand,
  WORKER_TOKEN_SECRET,
  WRITABLE_SECRETS,
} from "./analytics-subjects.mjs";
import { ANALYTICS_FUNCTIONS } from "./qa-function-bundles.mjs";
import { scramKeys } from "./qa-secrets.mjs";

const REPO = new URL("../../../", import.meta.url);
const REF = "abcdefghijklmnopqrst";
const real = (path) => readFile(new URL(path, REPO));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}

/** A throwaway repository with the real tooling and pinned SQL, and placeholder migrations. */
async function repo(t, { migrations = ["0017_analytics_erasure", "0018_analytics_account_erasure"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "still-analytics-op-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  for (const path of new Set([...ANALYTICS_TOOLING, ...Object.values(ANALYTICS_SQL).map((p) => p.path)])) {
    await put(root, path, await real(path));
  }
  await put(root, "supabase/config.toml", 'project_id = "still-app"\n');
  for (const name of migrations) await put(root, `supabase/migrations/${name}.sql`, "select 1;\n");
  await put(root, "packages/core/src/index.ts", "export {};\n");
  await put(root, "packages/shared-types/src/index.ts", "export {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

/** Stand-in compiler: writes three small bundles and returns their manifest. */
const fakeBundles = async (set, { artifactDir }) => {
  await mkdir(artifactDir, { recursive: true });
  const functions = [];
  for (const { name, verifyJwt } of set.routes) {
    const file = `${name}.js`;
    const bytes = Buffer.from(`// bundle ${name}\n`);
    await writeFile(join(artifactDir, file), bytes);
    functions.push({ name, verifyJwt, file, sha256: sha256(bytes), bytes: bytes.length });
  }
  return { protocol: 1, kind: set.kind, toolchain: {}, sources: [], functions };
};

async function plan(root, sha, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), "still-analytics-src-"));
  const p = await createAnalyticsPlan({
    git: makeGit(defaultExec, root),
    sha,
    cwd: root,
    exec: defaultExec,
    sourceDir: join(base, "src"),
    artifactDir: join(base, "art"),
    projectRef: REF,
    operation: SECRETS_OP,
    mode: "apply",
    buildBundles: fakeBundles,
    ...extra,
  });
  return { plan: p, sourceDir: join(base, "src"), artifactDir: join(base, "art") };
}

async function refuses(promise, category) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${error}`);
    assert.equal(error.category, category, error.message);
    return true;
  });
}

// ── In-memory database: the facts the pinned SQL reads and the effects it has ──────────────────

function world({ gate = [], history = ["0017", "0018"] } = {}) {
  const state = {
    gate,
    history,
    eraserLogin: false,
    verifier: null,
    vault: null,
    vaultCount: 0,
    command: null,
    pgNet: false,
    runs: 0,
    ok: 0,
    skipped: 0,
    failing: 0,
    // The provider proof's answer as pg_net would record it (null: no answer yet).
    provider: { status: 200, content: JSON.stringify({ ok: true, codes: ["project_read_ok", "project_key_matches", "delete_scope_ok"] }) },
    providerQueued: 0,
    sqlCalls: [],
    psqlMajor: 16,
  };
  const facts = () => ({
    eraser: state.eraserLogin ? "login" : "nologin",
    pgCron: true,
    pgNet: state.pgNet,
    vaultTokens: state.vaultCount,
    vaultTokenSha256: state.vaultCount === 1 ? sha256(state.vault) : null,
    jobs: state.command === null ? 0 : 1,
    job: state.command === null ? null : {
      schedule: CRON_SCHEDULE,
      active: true,
      username: "postgres",
      commandSha256: sha256(state.command),
    },
    recentRuns: state.runs,
    recentWorkerOk: state.ok,
    recentWorkerSkipped: state.skipped,
    recentWorkerFailing: state.failing,
  });
  const roleFacts = () => [
    `role ${ERASER_ROLE} | login ${state.eraserLogin}`,
    `role ${ERASER_ROLE} | superuser false`,
    "role postgres | login true",
  ].sort();
  const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
  const exec = async (cmd, args, { env = {} } = {}) => {
    if (cmd !== "psql") return defaultExec(cmd, args, { env });
    if (args[0] === "--version") return ok(`psql (PostgreSQL) ${state.psqlMajor}.4\n`);
    const file = args.includes("-f") ? basename(args[args.indexOf("-f") + 1]) : null;
    if (!file) {
      // The sign-in probe: the role and a password that matches the stored SCRAM verifier.
      const role = String(env.PGUSER).replace(`.${REF}`, "");
      const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):/.exec(state.verifier ?? "");
      const good = role === ERASER_ROLE && state.eraserLogin && match &&
        scramKeys(env.PGPASSWORD, Buffer.from(match[2], "base64"), Number(match[1])).storedKey
            .toString("base64") === match[3];
      return good ? ok(`${role}\n`) : { code: 2, stdout: "", stderr: "FATAL:  28P01" };
    }
    state.sqlCalls.push(file);
    switch (file) {
      case "analytics-subjects.verify.sql":
        return ok(`${JSON.stringify(facts())}\n`);
      case "migration-history.sql":
        return ok(`${JSON.stringify(state.history.map((version) => ({ version, name: "m" })))}\n`);
      case basename(MIGRATION_GATE):
        return ok(`${JSON.stringify(state.gate)}\n`);
      case "role-facts.sql":
        return ok(`${JSON.stringify(roleFacts())}\n`);
      case "analytics-subjects-secrets.sql":
        if (env.STILL_ANALYTICS_ERASER_VERIFIER) {
          state.verifier = env.STILL_ANALYTICS_ERASER_VERIFIER;
          state.eraserLogin = true;
        }
        if (env.STILL_ANALYTICS_WORKER_TOKEN) {
          state.vault = env.STILL_ANALYTICS_WORKER_TOKEN;
          state.vaultCount = 1;
        }
        return ok("");
      case "analytics-erasure-schedule-enable.sql":
        if (!env.STILL_ANALYTICS_WORKER_COMMAND) return { code: 3, stdout: "", stderr: "ERROR:  22023" };
        state.pgNet = true;
        state.command = env.STILL_ANALYTICS_WORKER_COMMAND;
        return ok("1\n");
      case "analytics-provider-check.sql":
        if (!env.STILL_ANALYTICS_FUNCTION_URL) return { code: 3, stdout: "", stderr: "ERROR:  22023" };
        state.providerQueued++;
        return ok("42\n");
      case "analytics-provider-check.read.sql":
        return ok(`${JSON.stringify(state.provider ? { found: true, ...state.provider } : { found: false, status: null, content: null })}\n`);
      case "analytics-erasure-schedule-disable.sql":
        state.command = null;
        return ok("");
      default:
        return { code: 3, stdout: "", stderr: "ERROR:  42P01" };
    }
  };
  return { state, exec };
}

function context(p, extra = {}) {
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: REHEARSAL_REPOSITORY,
    GITHUB_RUN_ID: "1",
    GH_TOKEN: "test",
    EXPECTED_PLAN_DIGEST: p.digest,
    DEPLOY_MODE: p.mode,
    DEPLOY_OPERATION: p.operation,
    DEPLOY_POLICY_MODE: p.policyMode,
    SUPABASE_PRODUCTION_PROJECT_REF: REF,
    SUPABASE_DB_URL: `postgresql://postgres.${REF}:admin-password@aws-0-us-west-2.pooler.supabase.com:5432/postgres`,
    [FUNCTIONS_TOKEN_ENV]: p.operation === SECRETS_OP ? "" : "functions-token",
    [SECRETS_TOKEN_ENV]: [SECRETS_OP, SWITCH_OP].includes(p.operation) ? "secrets-token" : "",
    ...extra,
  };
}

/** One harness: a plan of each operation from one commit, the model database and the stub API. */
async function harness(t, options = {}) {
  const { root, head } = await repo(t);
  const made = await plan(root, head, { operation: SWITCH_OP, mode: "apply", policyMode: "enable" });
  const db = world(options);
  const api = rehearsalApi(REF);
  const planFor = (operation, mode = "apply", policyMode = "none") =>
    siblingPlan(made.plan, {
      operation,
      mode,
      policyMode,
      bundles: ANALYTICS_OPERATIONS[operation].bundles ? made.plan.bundles : null,
    });
  const receipts = [];
  const run = async (p, extra = {}) => {
    const receipt = await runAnalyticsOperation({
      plan: p,
      env: context(p, extra),
      platform: "linux",
      cwd: root,
      sourceDir: made.sourceDir,
      artifactDir: made.artifactDir,
      exec: db.exec,
      fetchImpl: api.fetchImpl,
      verifyBundles: async () => true,
      provider: (args) => proveProvider({ ...args, sleep: async () => {}, polls: 2 }),
    });
    receipts.push(receipt);
    return receipt;
  };
  return { root, head, made, db, api, planFor, run, receipts };
}

// ── Plan ─────────────────────────────────────────────────────────────────────────────────────

test("the pinned hashes are the reviewed bytes and the verification SQL is a single read-only SELECT", async () => {
  for (const pin of Object.values(ANALYTICS_SQL)) {
    assert.equal(sha256(await real(pin.path)), pin.sha256, pin.path);
  }
  assert.equal(lintVerificationSql((await real(ANALYTICS_SQL.verify.path)).toString()), true);
  assert.equal(lintVerificationSql((await real(ANALYTICS_SQL.providerRead.path)).toString()), true);
  const probe = (await real(ANALYTICS_SQL.providerCheck.path)).toString();
  assert.match(probe, /\\bind :analytics_function_url \\g/);
  assert.match(probe, /'\{"action":"provider-check"\}'::jsonb/);
  assert.match(probe, /vault\.decrypted_secrets s where s\.name = 'still_analytics_erasure_worker_token'/);
  // A worker answer counts only with failed = 0 and lost = 0.
  assert.match(
    (await real(ANALYTICS_SQL.verify.path)).toString(),
    /coalesce\(r\.content::jsonb ->> 'failed', ''\) <> '0' or coalesce\(r\.content::jsonb ->> 'lost', ''\) <> '0' then 'failing'/,
  );
  assert.equal(lintVerificationSql((await real(MIGRATION_GATE)).toString()), true);
  // The SQL that carries a value takes it only from the psql environment, as a bind parameter.
  const secrets = (await real(ANALYTICS_SQL.secrets.path)).toString();
  assert.match(secrets, /\\getenv analytics_worker_token STILL_ANALYTICS_WORKER_TOKEN/);
  assert.match(secrets, /\\bind :analytics_worker_token \\g/);
  assert.doesNotMatch(secrets, /:'analytics_worker_token'/);
  assert.match(secrets, /alter role still_analytics_eraser with login password :'analytics_eraser_verifier';/);
  const enable = (await real(ANALYTICS_SQL.scheduleEnable.path)).toString();
  assert.match(enable, /cron\.schedule\('still-analytics-erasure-worker', '\*\/15 \* \* \* \*', \$1\) \\bind :analytics_worker_command \\g/);
  const disable = (await real(ANALYTICS_SQL.scheduleDisable.path)).toString();
  assert.match(disable, /cron\.unschedule\(j\.jobid\) from cron\.job j where j\.jobname = 'still-analytics-erasure-worker';/);
});

test("the plan binds the operation, the commit on main, the pinned SQL and the bundles under one digest", async (t) => {
  const { root, head } = await repo(t);
  const { plan: p } = await plan(root, head);
  assert.equal(p.kind, ANALYTICS_KIND);
  assert.equal(p.operation, SECRETS_OP);
  assert.equal(p.policyMode, "none");
  assert.equal(p.revision, head);
  assert.equal(p.bundles, null);
  assert.deepEqual(p.writable, [...WRITABLE_SECRETS]);
  assert.equal(p.workerCommandSha256, sha256(workerCommand(REF)));
  for (const pin of Object.values(ANALYTICS_SQL)) {
    assert.ok(p.files.some((f) => f.path === pin.path && f.sha256 === pin.sha256), pin.path);
  }
  for (const path of ANALYTICS_TOOLING) assert.ok(p.files.some((f) => f.path === path), path);
  assertSamePlan(JSON.parse(JSON.stringify(p)), p.digest);
  assert.equal((await plan(root, head)).plan.digest, p.digest);
  assert.notEqual((await plan(root, head, { mode: "rotate" })).plan.digest, p.digest);
  const schedule = (await plan(root, head, { operation: SCHEDULE_OP, policyMode: "enable" })).plan;
  assert.deepEqual(schedule.bundles.functions.map((f) => f.name), ANALYTICS_FUNCTIONS.map((f) => f.name));
  assert.deepEqual(ANALYTICS_FUNCTIONS.map((f) => [f.name, f.verifyJwt]), [
    ["analytics-erasure", false],
    ["analytics-identify", true],
    ["delete-user", true],
  ]);
  assert.notEqual(
    (await plan(root, head, { operation: SCHEDULE_OP, policyMode: "disable" })).plan.digest,
    schedule.digest,
  );
  // Freshness: main moving without touching a bound file is fine; touching one is not.
  const g = makeGit(defaultExec, root);
  await put(root, "README.md", "unrelated\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "unrelated");
  assert.equal((await checkFreshness({ git: g, plan: p, tipRef: "HEAD" })).mode, "files-identical");
  await put(root, ANALYTICS_SQL.scheduleDisable.path, "select 1;\n");
  git(root, "commit", "-q", "-am", "edit sql");
  await refuses(checkFreshness({ git: g, plan: p, tipRef: "HEAD" }), "main-moved");
});

test("the plan refuses unknown operations, wrong modes and inputs, a commit off main, missing history and edited SQL", async (t) => {
  const { root, head } = await repo(t);
  await refuses(plan(root, head, { operation: "analytics-everything" }), "analytics-operation-unknown");
  await refuses(plan(root, head, { mode: "baseline-only" }), "analytics-input-invalid");
  await refuses(plan(root, head, { mode: "disable" }), "analytics-input-invalid");
  await refuses(plan(root, head, { operation: FUNCTIONS_OP, mode: "rotate" }), "analytics-input-invalid");
  await refuses(plan(root, head, { operation: SCHEDULE_OP }), "analytics-input-invalid");
  await refuses(plan(root, head, { operation: SWITCH_OP, policyMode: "on" }), "analytics-input-invalid");
  await refuses(plan(root, head, { policyMode: "enable" }), "analytics-input-invalid");
  await refuses(plan(root, head, { migrations: "0017_analytics_erasure.sql" }), "analytics-input-invalid");
  await refuses(plan(root, head, { functions: "delete-user" }), "analytics-input-invalid");
  await refuses(plan(root, head, { expectedRevision: "1" }), "analytics-input-invalid");
  await refuses(plan(root, head, { subjectsSha256: "1:ab" }), "analytics-input-invalid");
  await refuses(plan(root, head, { baselineSha256: "a".repeat(64) }), "analytics-input-invalid");
  await refuses(plan(root, head, { projectRef: "short" }), "analytics-input-invalid");
  await refuses(plan(root, "main"), "analytics-input-invalid");
  git(root, "checkout", "-q", "-b", "side");
  await put(root, "side.txt", "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "side");
  const side = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  await refuses(plan(root, side), "analytics-commit-not-on-main");
  await put(root, ANALYTICS_SQL.secrets.path, "alter role postgres superuser;\n");
  git(root, "commit", "-q", "-am", "edit sql");
  await refuses(plan(root, git(root, "rev-parse", "HEAD")), "analytics-sql-unpinned");
  const early = await repo(t, { migrations: ["0016_product_policy"] });
  await refuses(plan(early.root, early.head), "analytics-prerequisite-history-missing");
});

test("the schedule command reads the token from Vault at run time and carries no secret", () => {
  const command = workerCommand(REF);
  assert.equal(
    command,
    "select net.http_post(url := 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analytics-erasure', " +
      "headers := pg_catalog.jsonb_build_object('Content-Type', 'application/json', 'Authorization', " +
      "(select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'still_analytics_erasure_worker_token')), " +
      "body := '{\"action\":\"work\"}'::jsonb, timeout_milliseconds := 60000)",
  );
  assert.ok(command.includes(VAULT_TOKEN_NAME));
  assert.throws(() => workerCommand("x'; drop table y; --"), Refusal);
  const url = eraserDbUrl(REF, "a".repeat(64));
  assert.equal(url, `postgresql://${ERASER_ROLE}:${"a".repeat(64)}@db.${REF}.supabase.co:5432/postgres?sslmode=require`);
  assert.throws(() => eraserDbUrl(REF, "not-hex%"), Refusal);
  for (const name of WRITABLE_SECRETS) assertWritableSecret(name);
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "POSTHOG_PERSONAL_API_KEY", "ENTITLEMENT_WRITER_DB_URL", "analytics_subjects_enabled"]) {
    assert.throws(() => assertWritableSecret(name), Refusal, name);
  }
});

test("the provider proof keeps the function's fixed codes and fails closed", async () => {
  const ts = (await real("supabase/functions/_shared/posthog-erasure.ts")).toString();
  const listed = /export const PROVIDER_CHECK_CODES = \[([\s\S]*?)\] as const;/.exec(ts)[1];
  assert.deepEqual([...listed.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]), [...PROVIDER_CHECK_CODES]);
  const pass = ["project_read_ok", "project_key_matches", "delete_scope_ok"];
  assert.deepEqual(providerCodes(JSON.stringify({ ok: true, codes: pass })), []);
  assert.deepEqual(providerCodes(JSON.stringify({ ok: false, codes: ["project_read_ok", "project_key_mismatch", "delete_scope_ok"] })), ["provider:project_key_mismatch"]);
  assert.deepEqual(providerCodes(JSON.stringify({ ok: false, codes: ["project_read_ok"] })), ["provider_check_failed"]);
  assert.deepEqual(providerCodes(JSON.stringify({ ok: true, codes: ["project_read_ok"] })), ["provider_check_shape"]);
  assert.deepEqual(providerCodes(JSON.stringify({ ok: false, codes: pass })), ["provider_check_shape"]);
  assert.deepEqual(providerCodes(JSON.stringify({ ok: true, codes: [...pass, "phc_secret"] })), ["provider_check_shape"]);
  assert.deepEqual(providerCodes("<html>"), ["provider_check_shape"]);
  // The queue-and-read loop, with the model database.
  const db = world();
  const conn = { host: "db.abcdefghijklmnopqrst.supabase.co", port: "5432", user: "postgres", password: "x", database: "postgres", sslmode: "require" };
  const args = { exec: db.exec, cwd: "/", conn, sourceDir: "/src", projectRef: REF, sleep: async () => {}, polls: 2 };
  assert.deepEqual(await proveProvider(args), []);
  db.state.provider = { status: null, content: null };
  assert.deepEqual(await proveProvider(args), ["provider_check_http_none"]);
  db.state.provider = { status: 401, content: null };
  assert.deepEqual(await proveProvider(args), ["provider_check_http_401"]);
  db.state.provider = null;
  assert.deepEqual(await proveProvider(args), ["provider_check_unanswered"]);
  assert.equal(db.state.providerQueued, 4);
});

test("the Secrets-only token must be refused by the functions endpoint", async () => {
  const reply = (status) => async () => new Response("{}", { status });
  assert.equal(await secretsTokenProbe({ fetchImpl: reply(403), projectRef: REF, token: "t" }), null);
  assert.equal(await secretsTokenProbe({ fetchImpl: reply(401), projectRef: REF, token: "t" }), null);
  assert.equal(await secretsTokenProbe({ fetchImpl: reply(200), projectRef: REF, token: "t" }), "secrets_token_too_broad");
  assert.equal(await secretsTokenProbe({ fetchImpl: reply(500), projectRef: REF, token: "t" }), "secrets_token_probe_failed");
  assert.equal(await secretsTokenProbe({ fetchImpl: async () => { throw new Error("x"); }, projectRef: REF, token: "t" }), "secrets_token_probe_failed");
  assert.equal(await secretsTokenProbe({ fetchImpl: reply(403), projectRef: REF, token: "" }), "secrets_token_missing");
});

test("facts, gate codes and the GoTrue rehearsal read-back accept only the expected shapes", async () => {
  const good = {
    eraser: "login", pgCron: true, pgNet: true, vaultTokens: 1, vaultTokenSha256: "a".repeat(64), jobs: 1,
    job: { schedule: CRON_SCHEDULE, active: true, username: "postgres", commandSha256: "b".repeat(64) },
    recentRuns: 1, recentWorkerOk: 1, recentWorkerSkipped: 0, recentWorkerFailing: 0,
  };
  assert.deepEqual(parseFacts(JSON.stringify(good)), good);
  // Unreadable pg_net responses are reported as null (both together), never guessed.
  const unreadable = { ...good, recentWorkerOk: null, recentWorkerSkipped: null, recentWorkerFailing: null };
  assert.deepEqual(parseFacts(JSON.stringify(unreadable)), unreadable);
  assert.throws(() => parseFacts(JSON.stringify({ ...good, recentWorkerOk: null })), Refusal);
  for (const bad of [
    { ...good, eraser: "maybe" },
    { ...good, vaultTokens: 2 },
    { ...good, vaultTokenSha256: "secret" },
    { ...good, jobs: 0 },
    { ...good, job: { ...good.job, commandSha256: "select" } },
    { ...good, recentRuns: -1 },
    [good],
  ]) assert.throws(() => parseFacts(JSON.stringify(bad)), Refusal);
  assert.throws(() => parseFacts("not json"), Refusal);
  assert.deepEqual(gateCodes(["role_missing:still_analytics_eraser", "Some free text with EMAIL@x"], "g"), [
    "g:role_missing:still_analytics_eraser",
    "g:unrecognized",
  ]);
  assert.deepEqual(gateCodes(null, "g"), ["g:unrecognized"]);
  const sha = "c".repeat(40);
  const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
  const run = { head_sha: sha, conclusion: "success", path: REHEARSAL_WORKFLOW };
  assert.equal(await rehearsalGreen({ fetchImpl: reply({ workflow_runs: [run] }), repository: "o/r", sha }), true);
  assert.equal(await rehearsalGreen({ fetchImpl: reply({ workflow_runs: [{ ...run, path: `${REHEARSAL_WORKFLOW}@refs/heads/main` }] }), repository: "o/r", sha }), true);
  for (const runs of [[], [{ ...run, head_sha: "d".repeat(40) }], [{ ...run, conclusion: "failure" }], [{ ...run, path: ".github/workflows/other.yml" }]]) {
    assert.equal(await rehearsalGreen({ fetchImpl: reply({ workflow_runs: runs }), repository: "o/r", sha }), false);
  }
  assert.equal(await rehearsalGreen({ fetchImpl: reply({}, 404), repository: "o/r", sha }), false);
  assert.equal(await rehearsalGreen({ fetchImpl: async () => { throw new Error("down"); }, repository: "o/r", sha }), false);
  assert.equal(await rehearsalGreen({ fetchImpl: reply({ workflow_runs: [run] }), repository: "bad repo", sha }), false);
});

test("a deployed route matches only the exact single-file bundle with the planned metadata", async () => {
  const upload = { name: "analytics-erasure", verifyJwt: false, file: "analytics-erasure.js" };
  const bytes = Buffer.from("// bundle\n");
  const metadata = {
    status: "ACTIVE", verify_jwt: false, import_map: false, import_map_path: null,
    entrypoint_path: "/tmp/user_fn/source/analytics-erasure.js",
  };
  const body = (...files) => async () => {
    const form = new FormData();
    form.set("metadata", "{}");
    for (const [name, content] of files) form.append("file", new Blob([content]), name);
    return form;
  };
  assert.equal(await deployedMatches(body(["source/analytics-erasure.js", bytes]), upload, bytes, metadata), true);
  assert.equal(await deployedMatches(body(["source/analytics-erasure.js", "other"]), upload, bytes, metadata), false);
  assert.equal(await deployedMatches(body(["source/analytics-erasure.js", bytes], ["source/x.js", "y"]), upload, bytes, metadata), false);
  assert.equal(await deployedMatches(body(["source/index.ts", bytes]), upload, bytes, metadata), false);
  assert.equal(await deployedMatches(body(["source/analytics-erasure.js", bytes]), upload, bytes, { ...metadata, verify_jwt: true }), false);
  assert.equal(await deployedMatches(body(["source/analytics-erasure.js", bytes]), upload, bytes, { ...metadata, import_map: true }), false);
  assert.equal(await deployedMatches(body(["source/analytics-erasure.js", bytes]), upload, bytes, undefined), false);
  assert.equal(await deployedMatches(async () => { throw new Refusal("qa-management-read-failed"); }, upload, bytes, metadata), false);
});

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

test("secrets apply installs three generated values, the eraser login and the Vault token; a repeat changes nothing", async (t) => {
  const h = await harness(t);
  const receipt = await h.run(h.planFor(SECRETS_OP));
  assert.equal(receipt.status, "verified", receipt.issues.join(" "));
  for (const name of [ERASER_URL_SECRET, EVENT_ID_SECRET, WORKER_TOKEN_SECRET]) {
    assert.match(h.api.secrets.get(name), name === ERASER_URL_SECRET ? /^postgresql:\/\/still_analytics_eraser:[a-f0-9]{64}@db\.abcdefghijklmnopqrst\.supabase\.co:5432\/postgres\?sslmode=require$/ : /^[a-f0-9]{64}$/);
  }
  assert.equal(h.api.secrets.has(SWITCH_SECRET), false);
  assert.equal(h.db.state.eraserLogin, true);
  assert.equal(h.db.state.vault, h.api.secrets.get(WORKER_TOKEN_SECRET));
  // Install order: the secrets first (an unused URL if the database step fails), then the SQL.
  assert.equal(h.api.calls.secretPosts, 1);
  const again = await h.run(h.planFor(SECRETS_OP));
  assert.equal(again.status, "no-change");
  assert.equal(h.api.calls.secretPosts, 1);
  assert.ok(!h.db.state.sqlCalls.slice(h.db.state.sqlCalls.lastIndexOf("analytics-subjects-secrets.sql") + 1).includes("analytics-subjects-secrets.sql"));
  const printed = JSON.stringify(h.receipts) + renderAnalyticsFinal(receipt);
  for (const value of h.api.secrets.values()) {
    if (value.length > 8) {
      assert.ok(!printed.includes(value));
      assert.ok(!printed.includes(sha256(value)));
    }
  }
});

test("secrets apply refuses a mixed state and names rotate; rotate replaces the password and token everywhere", async (t) => {
  const h = await harness(t);
  h.db.state.eraserLogin = true; // LOGIN without its URL secret: someone may hold a password.
  const mixed = await h.run(h.planFor(SECRETS_OP));
  assert.equal(mixed.status, "stopped-before-write");
  assert.deepEqual(mixed.issues, ["analytics-eraser-mismatch"]);
  assert.match(mixed.recovery, /Nothing was written/);
  assert.equal(h.api.calls.secretPosts, 0);
  h.db.state.eraserLogin = false;
  h.db.state.vault = "f".repeat(64);
  h.db.state.vaultCount = 1; // A Vault token without the function secret.
  assert.deepEqual((await h.run(h.planFor(SECRETS_OP))).issues, ["analytics-worker-token-mismatch"]);
  h.db.state.vault = null;
  h.db.state.vaultCount = 0;
  assert.equal((await h.run(h.planFor(SECRETS_OP))).status, "verified");
  const before = new Map(h.api.secrets);
  const rotated = await h.run(h.planFor(SECRETS_OP, "rotate"));
  assert.equal(rotated.status, "verified", rotated.issues.join(" "));
  assert.notEqual(h.api.secrets.get(ERASER_URL_SECRET), before.get(ERASER_URL_SECRET));
  assert.notEqual(h.api.secrets.get(WORKER_TOKEN_SECRET), before.get(WORKER_TOKEN_SECRET));
  assert.equal(h.api.secrets.get(EVENT_ID_SECRET), before.get(EVENT_ID_SECRET));
  assert.equal(h.db.state.vault, h.api.secrets.get(WORKER_TOKEN_SECRET));
  assert.ok(rotated.steps.some((s) => s.name === `role ${ERASER_ROLE}` && s.outcome === "password-rotated"));
});

test("every writing run first proves the migrations, the GoTrue rehearsal and owner approval", async (t) => {
  const h = await harness(t, { gate: ["subject_snapshot_trigger:disabled"], history: ["0017"] });
  h.api.setRehearsalGreen(false);
  const stopped = await h.run(h.planFor(SECRETS_OP));
  assert.equal(stopped.status, "stopped-before-write");
  assert.deepEqual(stopped.issues, [
    "analytics-gate-failed",
    "gotrue_rehearsal_not_green",
    "history_missing:0018",
    "migration_gate:subject_snapshot_trigger:disabled",
  ]);
  assert.equal(h.api.calls.secretPosts, 0);
  // The one code a later reviewed migration explains is accepted; everything else still stops.
  h.api.setRehearsalGreen(true);
  h.db.state.history = ["0017", "0018"];
  h.db.state.gate = [...LATER_MIGRATION_CODES];
  assert.equal((await h.run(h.planFor(SECRETS_OP))).status, "verified");
  // A plan the owner did not approve, or a different operation, mode or target, never runs.
  const p = h.planFor(SWITCH_OP, "apply", "disable");
  for (const extra of [
    { EXPECTED_PLAN_DIGEST: "f".repeat(64) },
    { DEPLOY_OPERATION: SECRETS_OP },
    { DEPLOY_POLICY_MODE: "enable" },
    { DEPLOY_MODE: "plan-only" },
    { SUPABASE_PRODUCTION_PROJECT_REF: "bcdefghijklmnopqrstu" },
    { GITHUB_REF: "refs/heads/feature" },
    { SUPABASE_DB_URL: "postgresql://postgres:x@db.otherprojectrefabcd.supabase.co:5432/postgres" },
    { [SECRETS_TOKEN_ENV]: "" },
  ]) {
    const r = await h.run(p, extra);
    assert.equal(r.status, "stopped-before-write", JSON.stringify(extra));
    assert.equal(r.writeAttempted, false);
  }
  assert.equal(h.api.secrets.has(SWITCH_SECRET), false);
  // A Secrets-only token that can also reach functions is refused before any write.
  const broad = await h.run(h.planFor(SECRETS_OP, "rotate"), { [SECRETS_TOKEN_ENV]: "broad-token" });
  assert.deepEqual(broad.issues, ["analytics-gate-failed", "secrets_token_too_broad"]);
  // Rotate is the recovery path: no history, migration or rehearsal gate; the role check stays.
  h.api.setRehearsalGreen(false);
  h.db.state.history = [];
  h.db.state.gate = ["subject_snapshot_trigger:disabled"];
  const rotated = await h.run(h.planFor(SECRETS_OP, "rotate"));
  assert.equal(rotated.status, "verified", rotated.issues.join(" "));
  assert.equal((await h.run(h.planFor(SECRETS_OP))).status, "stopped-before-write", "apply keeps every gate");
});

test("functions deploy exactly three routes in order after the secrets exist; a repeat changes nothing; a bad readback stops before delete-user", async (t) => {
  const h = await harness(t);
  const early = await h.run(h.planFor(FUNCTIONS_OP));
  assert.equal(early.status, "stopped-before-write");
  for (const code of ["eraser_cannot_sign_in", "worker_token_mismatch", `missing_secret:${ERASER_URL_SECRET}`]) {
    assert.ok(early.issues.includes(code), code);
  }
  assert.equal(h.api.calls.deploys, 0);
  await h.run(h.planFor(SECRETS_OP));
  for (const name of POSTHOG_SECRETS) assert.ok(h.api.secrets.has(name));
  const deployed = await h.run(h.planFor(FUNCTIONS_OP));
  assert.equal(deployed.status, "verified", deployed.issues.join(" "));
  assert.deepEqual(deployed.steps.map((s) => [s.name, s.outcome]), [
    ["analytics-erasure", "created"],
    ["analytics-identify", "deployed"],
    ["delete-user", "deployed"],
  ]);
  assert.equal(h.api.functions.get("analytics-identify").version, 2);
  assert.equal(h.api.functions.get("delete-user").version, 19);
  assert.equal(h.api.functions.get("analytics-erasure").verify_jwt, false);
  const again = await h.run(h.planFor(FUNCTIONS_OP));
  assert.equal(again.status, "no-change");
  assert.equal(h.api.calls.deploys, 3);

  // A route whose stored body does not read back stops the run; delete-user is never attempted.
  const g = await harness(t);
  await g.run(g.planFor(SECRETS_OP));
  const original = g.api.fetchImpl;
  const broken = async (url, init) => {
    if (/\/functions\/analytics-identify\/body$/.test(url)) {
      const form = new FormData();
      form.set("metadata", "{}");
      form.append("file", new Blob(["tampered"]), "source/analytics-identify.js");
      return new Response(form, { status: 200 });
    }
    return original(url, init);
  };
  const receipt = await runAnalyticsOperation({
    plan: g.planFor(FUNCTIONS_OP), env: context(g.planFor(FUNCTIONS_OP)), platform: "linux", cwd: g.root,
    sourceDir: g.made.sourceDir, artifactDir: g.made.artifactDir, exec: g.db.exec, fetchImpl: broken,
    verifyBundles: async () => true,
  });
  assert.equal(receipt.status, "outcome-unknown");
  assert.deepEqual(receipt.steps.map((s) => s.outcome), ["created", "outcome-unknown", "not-attempted"]);
  assert.equal(g.api.functions.get("delete-user").version, 18);
  assert.match(receipt.recovery, /never blindly retry/);
  assert.match(renderAnalyticsFinal(receipt), /status: outcome-unknown/);
});

test("the schedule needs analytics-erasure at source, stores the exact command, and disable removes only the job", async (t) => {
  const h = await harness(t);
  await h.run(h.planFor(SECRETS_OP));
  const early = await h.run(h.planFor(SCHEDULE_OP, "apply", "enable"));
  assert.ok(early.issues.includes("function_not_at_source:analytics-erasure"));
  assert.equal(h.db.state.command, null);
  await h.run(h.planFor(FUNCTIONS_OP));
  h.db.state.psqlMajor = 15;
  assert.deepEqual((await h.run(h.planFor(SCHEDULE_OP, "apply", "enable"))).issues, ["analytics-psql-too-old"]);
  h.db.state.psqlMajor = 16;
  const scheduled = await h.run(h.planFor(SCHEDULE_OP, "apply", "enable"));
  assert.equal(scheduled.status, "verified", scheduled.issues.join(" "));
  assert.equal(h.db.state.command, workerCommand(REF));
  assert.equal((await h.run(h.planFor(SCHEDULE_OP, "apply", "enable"))).status, "no-change");
  const removed = await h.run(h.planFor(SCHEDULE_OP, "apply", "disable"));
  assert.equal(removed.status, "verified");
  assert.equal(h.db.state.command, null);
  assert.equal(h.db.state.eraserLogin, true);
  assert.equal((await h.run(h.planFor(SCHEDULE_OP, "apply", "disable"))).status, "no-change");
  // A different stored command is not "already scheduled": enable replaces it.
  h.db.state.command = "select 1";
  assert.equal((await h.run(h.planFor(SCHEDULE_OP, "apply", "enable"))).status, "verified");
  assert.equal(h.db.state.command, workerCommand(REF));
});

test("the switch turns on only with a running schedule and a worker that deletes; off always works", async (t) => {
  const h = await harness(t);
  // Off needs nothing, even before anything else exists.
  const offFirst = await h.run(h.planFor(SWITCH_OP, "apply", "disable"));
  assert.equal(offFirst.status, "no-change");
  await h.run(h.planFor(SECRETS_OP));
  await h.run(h.planFor(FUNCTIONS_OP));
  const noSchedule = await h.run(h.planFor(SWITCH_OP, "apply", "enable"));
  assert.ok(noSchedule.issues.includes("schedule_missing"));
  await h.run(h.planFor(SCHEDULE_OP, "apply", "enable"));
  const notRunning = await h.run(h.planFor(SWITCH_OP, "apply", "enable"));
  assert.deepEqual(notRunning.issues, ["analytics-gate-failed", "schedule_not_running", "worker_not_succeeding"]);
  h.db.state.runs = 1;
  h.db.state.ok = null;
  h.db.state.skipped = null;
  h.db.state.failing = null;
  assert.deepEqual((await h.run(h.planFor(SWITCH_OP, "apply", "enable"))).issues, [
    "analytics-gate-failed",
    "worker_evidence_unreadable",
  ]);
  h.db.state.ok = 0;
  h.db.state.skipped = 0;
  h.db.state.failing = 1; // A worker run that failed or lost jobs does not count.
  assert.deepEqual((await h.run(h.planFor(SWITCH_OP, "apply", "enable"))).issues, [
    "analytics-gate-failed",
    "worker_failing",
  ]);
  h.db.state.skipped = 1;
  assert.deepEqual((await h.run(h.planFor(SWITCH_OP, "apply", "enable"))).issues, [
    "analytics-gate-failed",
    "worker_provider_unconfigured",
  ]);
  h.db.state.ok = 1;
  // A route changed since the functions run is not "at source".
  h.api.functions.get("delete-user").verify_jwt = false;
  assert.deepEqual((await h.run(h.planFor(SWITCH_OP, "apply", "enable"))).issues, [
    "analytics-gate-failed",
    "function_not_at_source:delete-user",
  ]);
  h.api.functions.get("delete-user").verify_jwt = true;
  // Last gate: the PostHog provider proof, run inside the function. It must prove the same project.
  assert.equal(h.db.state.providerQueued, 0, "the proof runs only once everything else holds");
  h.db.state.provider = {
    status: 200,
    content: JSON.stringify({ ok: false, codes: ["project_read_ok", "project_key_mismatch", "delete_scope_ok"] }),
  };
  assert.deepEqual((await h.run(h.planFor(SWITCH_OP, "apply", "enable"))).issues, [
    "analytics-gate-failed",
    "provider:project_key_mismatch",
  ]);
  h.db.state.provider = { status: 200, content: JSON.stringify({ ok: false, codes: ["project_read_forbidden", "delete_forbidden"] }) };
  assert.deepEqual((await h.run(h.planFor(SWITCH_OP, "apply", "enable"))).issues, [
    "analytics-gate-failed",
    "provider:delete_forbidden",
    "provider:project_read_forbidden",
  ]);
  h.db.state.provider = null;
  assert.deepEqual((await h.run(h.planFor(SWITCH_OP, "apply", "enable"))).issues, [
    "analytics-gate-failed",
    "provider_check_unanswered",
  ]);
  assert.equal(h.api.secrets.has(SWITCH_SECRET), false);
  // A Secrets-only token that could reach functions blocks the switch-on too (never the off).
  h.db.state.provider = { status: 200, content: JSON.stringify({ ok: true, codes: ["project_read_ok", "project_key_matches", "delete_scope_ok"] }) };
  assert.deepEqual((await h.run(h.planFor(SWITCH_OP, "apply", "enable"), { [SECRETS_TOKEN_ENV]: "broad-token" })).issues, [
    "analytics-gate-failed",
    "secrets_token_too_broad",
  ]);
  const identify = h.api.functions.get("analytics-identify").version;
  const on = await h.run(h.planFor(SWITCH_OP, "apply", "enable"));
  assert.equal(on.status, "verified", on.issues.join(" "));
  assert.equal(h.api.secrets.get(SWITCH_SECRET), "true");
  assert.equal(h.api.functions.get("analytics-identify").version, identify + 1);
  assert.equal((await h.run(h.planFor(SWITCH_OP, "apply", "enable"))).status, "no-change");
  // Emergency off: no schedule, no worker evidence, no provider proof, no token probe needed.
  h.db.state.command = null;
  h.db.state.ok = 0;
  h.db.state.provider = null;
  const queued = h.db.state.providerQueued;
  const off = await h.run(h.planFor(SWITCH_OP, "apply", "disable"), { [SECRETS_TOKEN_ENV]: "broad-secrets-token" });
  assert.equal(h.db.state.providerQueued, queued);
  assert.equal(off.status, "verified");
  assert.equal(h.api.secrets.get(SWITCH_SECRET), "false");
  assert.equal(h.api.functions.get("analytics-identify").version, identify + 2);
  assert.equal((await h.run(h.planFor(SWITCH_OP, "apply", "disable"))).status, "no-change");
});

// ── Records and CLI ──────────────────────────────────────────────────────────────────────────

test("plan and closing records name steps and fixed codes only", async (t) => {
  const { root, head } = await repo(t);
  const { plan: p } = await plan(root, head, { operation: SWITCH_OP, policyMode: "enable" });
  const shown = renderAnalyticsPlan(p);
  for (const needle of [p.digest, head, "ANALYTICS_SUBJECTS_ENABLED=true", "GoTrue deletion", "analytics-identify"]) {
    assert.ok(shown.includes(needle), needle);
  }
  assert.ok(!shown.includes(REF), "the project ref is bound, not printed");
  assert.match(renderAnalyticsPlan({ ...p, policyMode: "disable" }), /this is the way back/);
  assert.match(renderAnalyticsFinal(null, { applyOutcome: "skipped" }), /stopped-before-write/);
  assert.match(renderAnalyticsFinal(null, { operation: SWITCH_OP }), /no durable receipt for `analytics-subjects-switch`/);
  const interrupted = renderAnalyticsFinal({
    kind: ANALYTICS_KIND, operation: SECRETS_OP, policyMode: "none", mode: "apply", status: "writing-secrets",
    writeAttempted: true, steps: [{ name: WORKER_TOKEN_SECRET, outcome: "outcome-unknown" }],
    counts: { "outcome-unknown": 1 }, issues: [], recovery: "",
  });
  assert.match(interrupted, /status: outcome-unknown/);
  assert.match(interrupted, /rotate/);
});

test("the CLI routes analytics operations to this module and keeps rotate and policy inputs closed", async (t) => {
  const { root, head } = await repo(t);
  const out = { text: "", write(s) { this.text += s; } };
  const env = (extra) => ({ DEPLOY_SHA: head, SUPABASE_PRODUCTION_PROJECT_REF: REF, DEPLOY_MIGRATIONS: "", DEPLOY_FUNCTIONS: "", ...extra });
  const source = await mkdtemp(join(tmpdir(), "still-analytics-cli-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  assert.equal(
    await main(["plan", "--source-dir", join(source, "a")], env({ DEPLOY_OPERATION: SECRETS_OP, DEPLOY_MODE: "plan-only", DEPLOY_POLICY_MODE: "none" }), { cwd: root, out }),
    0,
  );
  assert.match(out.text.trim(), /^[a-f0-9]{64}$/);
  assert.equal(
    await main(["plan", "--source-dir", join(source, "b")], env({ DEPLOY_OPERATION: SECRETS_OP, DEPLOY_MODE: "rotate" }), { cwd: root, out }),
    0,
  );
  await refuses(main(["plan", "--source-dir", join(source, "c")], env({ DEPLOY_OPERATION: FUNCTIONS_OP, DEPLOY_MODE: "rotate" }), { cwd: root, out }), "mode-invalid");
  await refuses(main(["plan", "--source-dir", join(source, "d")], env({ DEPLOY_OPERATION: SECRETS_OP, DEPLOY_MODE: "disable" }), { cwd: root, out }), "mode-invalid");
  await refuses(main(["plan", "--source-dir", join(source, "e")], env({ DEPLOY_OPERATION: "analytics-other", DEPLOY_MODE: "plan-only" }), { cwd: root, out }), "operation-unknown");
  await refuses(main(["plan", "--source-dir", join(source, "f")], env({ DEPLOY_OPERATION: SECRETS_OP, DEPLOY_MODE: "plan-only", DEPLOY_POLICY_EXPECTED_REVISION: "1" }), { cwd: root, out }), "analytics-input-invalid");
  const summary = { text: "", write(s) { this.text += s; } };
  assert.equal(await main(["final-summary", "--receipt", join(source, "missing.json")], { DEPLOY_OPERATION: SWITCH_OP, APPLY_OUTCOME: "failure" }, { out: summary }), 0);
  assert.match(summary.text, /Analytics closing record/);
});
