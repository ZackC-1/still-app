// Offline tests for the protected deploy logic. No database, no network, no secrets: git runs
// against throwaway repositories and every database/CLI call goes to an in-memory fake.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  CLI_TARBALL_SHA256,
  Refusal,
  TOOLING_PATHS,
  assertSamePlan,
  checkProtection,
  compareHistory,
  createDeployPlan,
  defaultExec,
  diffFacts,
  lintVerificationSql,
  main,
  makeGit,
  maskValues,
  parseDbUrl,
  parseDryRun,
  parseInputs,
  pgEnv,
  prepareWorkdir,
  readProtection,
  redact,
  renderPlan,
  renderFinal,
  renderReceipt,
  runDeploy,
  checkFreshness,
  failureFacts,
  issueCounts,
  runReplay,
  sha256,
} from "./deploy.mjs";

const SECRET = "synthetic-password-sentinel-9f2c";
const REF = "abcdefghijklmnopqrst";
const PROD_URL = `postgresql://postgres.${REF}:${SECRET}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function put(root, path, text) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), "still-deploy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  await put(root, "supabase/config.toml", 'project_id = "still-app"\n');
  await put(
    root,
    "supabase/migrations/0001_init.sql",
    "create table a (id int);\n",
  );
  await put(
    root,
    "supabase/migrations/0002_harden.sql",
    "revoke all on a from anon;\n",
  );
  await put(
    root,
    "scripts/backend/deploy/verify/0002_harden.sql",
    "select '[]';\n",
  );
  await put(
    root,
    "scripts/backend/deploy/verify/0002_harden.invariant.sql",
    "select '{}';\n",
  );
  for (const path of TOOLING_PATHS) await put(root, path, `tooling ${path}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

const plan = (root, sha, migrations = "0002_harden.sql", extra = {}) =>
  createDeployPlan({
    git: makeGit(defaultExec, root),
    sha,
    migrations,
    ...extra,
  });

async function refuses(promise, category) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${error}`);
    assert.equal(error.category, category);
    return true;
  });
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────

test("inputs: exact SHA, bare migration names, no duplicates, functions refused", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(
    parseInputs({ sha, migrations: " 0014_x.sql, 0015_y.sql ", functions: "" })
      .migrations,
    ["0014_x.sql", "0015_y.sql"],
  );
  for (const [input, category] of [
    [{ sha: "a".repeat(39), migrations: "0014_x.sql" }, "input-invalid"],
    [{ sha: "A".repeat(40), migrations: "0014_x.sql" }, "input-invalid"],
    [{ sha: "main", migrations: "0014_x.sql" }, "input-invalid"],
    [{ sha, migrations: "" }, "input-invalid"],
    [{ sha, migrations: "../0014_x.sql" }, "input-invalid"],
    [{ sha, migrations: "supabase/migrations/0014_x.sql" }, "input-invalid"],
    [{ sha, migrations: "0014_x.sql;rm" }, "input-invalid"],
    [{ sha, migrations: "0014_X.sql" }, "input-invalid"],
    [{ sha, migrations: "0014_x.sql,0014_x.sql" }, "input-invalid"],
    [
      { sha, migrations: "0014_x.sql", functions: "sync-settings" },
      "functions-unsupported",
    ],
    [{ sha, migrations: "0014_x.sql", functions: "$(id)" }, "input-invalid"],
  ]) {
    assert.throws(
      () => parseInputs(input),
      (e) => e instanceof Refusal && e.category === category,
      JSON.stringify(input),
    );
  }
});

// ── Plan ─────────────────────────────────────────────────────────────────────────────────────

test("plan binds commit, hashes, verification, tooling and exact expected history", async (t) => {
  const { root, head } = await repo(t);
  const p = await plan(root, head);
  assert.equal(p.revision, head);
  assert.equal(p.workflowRevision, head);
  assert.equal(p.environment, "supabase-production");
  assert.equal(p.cli.tarballSha256, CLI_TARBALL_SHA256);
  assert.deepEqual(p.expectedHistoryBefore, [
    { version: "0001", name: "init" },
  ]);
  assert.deepEqual(p.expectedHistoryAfter, [
    { version: "0001", name: "init" },
    { version: "0002", name: "harden" },
  ]);
  assert.equal(p.migrations.length, 1);
  assert.equal(p.migrations[0].sha256, sha256("revoke all on a from anon;\n"));
  assert.equal(p.migrations[0].verification.sha256, sha256("select '[]';\n"));
  assert.deepEqual(
    p.priorMigrations.map((m) => m.file),
    ["0001_init.sql"],
  );
  assert.deepEqual(p.functions, []);
  assert.equal(p.tooling.length, TOOLING_PATHS.length);
  assert.equal(p.newerMigrationsOnMain, 0);
  assert.match(p.recovery, /fix-forward/);
  // Deterministic: the apply job re-derives exactly the same digest.
  assert.equal((await plan(root, head)).digest, p.digest);
  assertSamePlan(p, p.digest);
  const shown = renderPlan(p);
  assert.match(shown, /0002_harden\.sql/);
  // Everything the approval binds is on the page: migration, end-state check, row-count check.
  for (const file of [
    p.migrations[0],
    p.migrations[0].verification,
    p.migrations[0].invariant,
  ])
    assert.ok(shown.includes(file.sha256), file.path ?? file.file);
  assert.ok(
    shown.includes("scripts/backend/deploy/verify/0002_harden.invariant.sql"),
  );
  assert.match(shown, /row-count check \(counts never printed\)/);
  assert.match(shown, /on main's own line of history \(first parent\)/);
  assert.doesNotMatch(shown, /⚠️/);
});

test("plan refuses commits that are not on main", async (t) => {
  const { root } = await repo(t);
  git(root, "checkout", "-q", "-b", "feature");
  await put(root, "supabase/migrations/0003_extra.sql", "select 1;\n");
  await put(
    root,
    "scripts/backend/deploy/verify/0003_extra.sql",
    "select '[]';\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "unmerged");
  const feature = git(root, "rev-parse", "HEAD");
  await refuses(
    plan(root, feature, "0003_extra.sql", { mainRef: "main" }),
    "not-on-main",
  );
  await refuses(
    plan(root, "f".repeat(40), "0003_extra.sql", { mainRef: "main" }),
    "commit-unknown",
  );
});

test("plan requires exactly the newest migrations at the commit", async (t) => {
  const { root, head } = await repo(t);
  await refuses(plan(root, head, "0001_init.sql"), "not-pending-tail");
  await refuses(plan(root, head, "0003_missing.sql"), "migration-missing");
  await refuses(
    plan(root, head, "0001_init.sql,0002_harden.sql"),
    "no-prior-history",
  );
  await refuses(
    plan(root, head, "0002_harden.sql", { functions: "delete-user" }),
    "functions-unsupported",
  );
});

test("plan requires a lint-clean read-only verification query at the commit", async (t) => {
  const { root } = await repo(t);
  await rm(join(root, "scripts/backend/deploy/verify/0002_harden.sql"));
  git(root, "commit", "-q", "-am", "drop verification");
  await refuses(
    plan(root, git(root, "rev-parse", "HEAD")),
    "verification-missing",
  );
  await put(
    root,
    "scripts/backend/deploy/verify/0002_harden.sql",
    "select 1; delete from a;\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "bad verification");
  await refuses(
    plan(root, git(root, "rev-parse", "HEAD")),
    "verification-sql-invalid",
  );
});

test("plan refuses when main changed the migration bytes or history after the commit", async (t) => {
  const { root, head } = await repo(t);
  await put(
    root,
    "supabase/migrations/0002_harden.sql",
    "revoke all on a from anon, authenticated;\n",
  );
  git(root, "commit", "-q", "-am", "edit applied migration");
  await refuses(plan(root, head), "migration-changed-on-main");

  const second = await repo(t);
  await rm(join(second.root, "supabase/migrations/0001_init.sql"));
  git(second.root, "commit", "-q", "-am", "drop old migration");
  await refuses(plan(second.root, second.head), "main-history-diverges");
});

test("an older commit may be deployed when main only added newer migrations", async (t) => {
  const { root, head } = await repo(t);
  await put(root, "supabase/migrations/0003_later.sql", "select 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "later");
  const p = await plan(root, head);
  assert.equal(p.newerMigrationsOnMain, 1);
  assert.deepEqual(
    p.expectedHistoryAfter.map((h) => h.version),
    ["0001", "0002"],
  );
  assert.match(renderPlan(p), /1 newer migration/);
});

test("any change to verification, config or tooling changes the digest; tampering is refused", async (t) => {
  const { root, head } = await repo(t);
  const original = await plan(root, head);
  await put(root, TOOLING_PATHS[1], "changed tooling\n");
  git(root, "commit", "-q", "-am", "tooling");
  const changed = await plan(root, head);
  assert.notEqual(changed.digest, original.digest);
  assert.throws(() => assertSamePlan(changed, original.digest), /differs/);
  const tampered = {
    ...original,
    migrations: [{ ...original.migrations[0], sha256: "0".repeat(64) }],
  };
  assert.throws(
    () => assertSamePlan(tampered, original.digest),
    (e) => e.category === "plan-differs",
  );
  assert.throws(
    () => assertSamePlan(original, ""),
    (e) => e.category === "plan-digest-missing",
  );
});

// ── Verification SQL contract ────────────────────────────────────────────────────────────────

test("verification lint accepts the real 0014 query and rejects writes or multiple statements", async () => {
  const real = await readFile(
    new URL(
      "./verify/0014_server_rpc_privilege_hardening.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(lintVerificationSql(real), true);
  for (const bad of [
    "select 1; select 2;",
    "select 1",
    "update t set a = 1;",
    "with x as (delete from t returning 1) select * from x;",
    "select 1 into t;",
    "do $$ begin end $$;",
    "select set_config('a','b',false), 1; ",
    "/* select */ grant all on t to anon;",
    "select 1; commit; delete from t;",
  ]) {
    assert.throws(
      () => lintVerificationSql(bad),
      (e) => e.category === "verification-sql-invalid",
      bad,
    );
  }
  // Keywords inside string literals or comments are data, not commands.
  assert.equal(
    lintVerificationSql("-- delete\nselect 'INSERT,UPDATE' as x;"),
    true,
  );
});

test("the 0014 verification covers the migration author's whole end-state list", async () => {
  const read = (name) =>
    readFile(new URL(`./verify/${name}`, import.meta.url), "utf8");
  const real = await read("0014_server_rpc_privilege_hardening.sql");
  for (const code of [
    "migration_missing:0014",
    "routine_missing:",
    "routine_extra_grantee:",
    "routine_grantee_missing:",
    "routine_reachable:",
    "purchase_rpc_not_plpgsql:",
    "purchase_rpc_not_definer:",
    "routine_owner:",
    "guard_missing:",
    "free_sync_body_changed",
    "unpinned_search_path:",
    "client_execute:",
    "table_missing:",
    "rls_disabled:",
    "public_write:",
    "role_write:",
    "writer_table_privilege:",
    "client_read:",
    "client_read_missing:",
    "entitlements_table_select:",
    "service_role_changed:",
    "client_schema_create",
    "postgres_global_function_default_missing",
    "postgres_global_function_default",
    "postgres_public_default_service_role_missing:",
    "residual:supabase_admin_public_default:",
    "default_reaches_client:",
  ]) {
    assert.ok(real.includes(`'${code}`), `missing check ${code}`);
  }
  for (const sig of [
    "public.set_entitlement(uuid,boolean,text,text)",
    "public.record_revenuecat_event(text,text,jsonb)",
    "public.claim_revenuecat_event(text,text,jsonb)",
    "public.complete_revenuecat_event(text,uuid)",
    "public.release_revenuecat_event(text,uuid)",
    "public.consume_rate_limit(text,integer,integer)",
    "public.cleanup_rate_limit_counters()",
    "public.sync_rate_limit_account()",
    "public.write_profile_settings(jsonb,uuid)",
    "public.get_current_rule_set()",
  ]) {
    assert.ok(real.includes(`'${sig}'`), sig);
  }
  assert.match(real, /order by i\.issue collate "C"/);
  // The free-sync body hash is the md5 of the exact 0012 body (what PostgreSQL stores as prosrc).
  const m0012 = await readFile(
    new URL(
      "../../../supabase/migrations/0012_profiles_write_free_sync.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const start =
    m0012.indexOf(
      "$$",
      m0012.indexOf("function public.write_profile_settings"),
    ) + 2;
  const body = m0012.slice(start, m0012.indexOf("$$", start));
  const md5 = createHash("md5").update(body).digest("hex");
  assert.ok(real.includes(`'${md5}'`), `free-sync md5 ${md5}`);
  const invariant = await read(
    "0014_server_rpc_privilege_hardening.invariant.sql",
  );
  assert.equal(lintVerificationSql(invariant), true);
  for (const table of [
    "auth.users",
    "public.canary_state",
    "public.entitlements",
    "public.profiles",
    "public.revenuecat_events",
    "public.rule_sets",
  ])
    assert.ok(invariant.includes(`from ${table})`), table);
  assert.doesNotMatch(invariant, /from public\.rate_limit/);
});

// ── Secrets handling ─────────────────────────────────────────────────────────────────────────

test("database URL is parsed, masked and redacted without ever echoing it", () => {
  const conn = parseDbUrl(PROD_URL);
  assert.equal(conn.host, "aws-0-us-west-2.pooler.supabase.com");
  assert.equal(conn.user, `postgres.${REF}`);
  const masks = maskValues(conn);
  for (const v of [SECRET, REF, conn.host, PROD_URL])
    assert.ok(masks.includes(v), v);
  assert.ok(!masks.includes("postgres"));
  const leaked = `connect to ${PROD_URL} failed; host ${conn.host}; user postgres.${REF}; pw ${SECRET}`;
  const clean = redact(leaked, conn);
  for (const v of [SECRET, REF, conn.host]) assert.ok(!clean.includes(v), v);
  const env = pgEnv(conn, "production");
  assert.equal(env.PGSSLMODE, "require");
  assert.equal(env.PGPASSWORD, SECRET);
  for (const bad of [
    "",
    "not a url",
    "https://u:p@h/db",
    "postgresql://h/db",
    `postgresql://u@h/db`,
  ]) {
    assert.throws(
      () => parseDbUrl(bad),
      (e) =>
        e.category === "db-url-invalid" && !e.message.includes(bad || "\u0000"),
    );
  }
  assert.throws(
    () => pgEnv(parseDbUrl(`${PROD_URL}?sslmode=disable`), "production"),
    (e) => e.category === "db-url-insecure",
  );
  assert.equal(parseDbUrl("postgresql://u:p%40ss@h:6543/db").password, "p@ss");
});

// ── History and dry-run parsing ──────────────────────────────────────────────────────────────

test("history comparison reports only categories and counts", () => {
  const before = [{ version: "0001", name: "init" }];
  const after = [...before, { version: "0002", name: "harden" }];
  assert.equal(compareHistory(before, before).ok, true);
  const extra = compareHistory(
    [...before, { version: "0099", name: "manual_hotfix" }],
    before,
    { alreadyApplied: after },
  );
  assert.equal(extra.category, "unexpected-entries");
  assert.equal(extra.unexpected, 1);
  assert.ok(!JSON.stringify(extra).includes("manual_hotfix"));
  assert.equal(
    compareHistory(after, before, { alreadyApplied: after }).category,
    "already-applied",
  );
  assert.equal(compareHistory([], before).category, "missing-entries");
  assert.equal(
    compareHistory([{ version: "0001", name: "renamed" }], before).category,
    "unexpected-entries",
  );
});

test("dry-run output is parsed from text or JSON and never guessed", () => {
  assert.deepEqual(
    parseDryRun(
      "DRY RUN: migrations will *not* be pushed\nWould push these migrations:\n • 0014_server_rpc_privilege_hardening.sql\n",
    ),
    ["0014_server_rpc_privilege_hardening.sql"],
  );
  assert.deepEqual(
    parseDryRun('{"upToDate":true,"dryRun":true,"migrations":[]}'),
    [],
  );
  assert.deepEqual(
    parseDryRun(
      '{"dryRun":true,"migrations":["supabase/migrations/0014_a.sql",{"version":"0015","name":"b"}]}',
    ),
    ["0014_a.sql", "0015_b.sql"],
  );
  assert.deepEqual(parseDryRun("Remote database is up to date."), []);
});

// ── Orchestration against an in-memory database ──────────────────────────────────────────────

/** Minimal fake of psql + supabase CLI over a migration history. */
function fakeDb(
  p,
  {
    history,
    verify = () => "[]",
    dryRun,
    pushFails,
    onPush,
    beforeSecondRead,
    pushOutput,
    countsAfterPush,
    psqlFailure,
  } = {},
) {
  const state = {
    history: structuredClone(history ?? p.expectedHistoryBefore),
    calls: [],
    historyReads: 0,
    counts: { "public.profiles": 3 },
    pushed: false,
  };
  const exec = async (cmd, args, opts = {}) => {
    state.calls.push([cmd, args, opts]);
    if (cmd === "git" || cmd === "tar") return defaultExec(cmd, args, opts);
    if (cmd === "psql") {
      const file = args.at(-1);
      assert.ok(
        args.includes("set session characteristics as transaction read only"),
      );
      assert.ok(
        !args.join(" ").includes(SECRET),
        "secret must never be a psql argument",
      );
      if (psqlFailure && psqlFailure(file, state))
        return { code: 3, stdout: "", stderr: psqlFailure(file, state) };
      if (file.endsWith(".invariant.sql"))
        return {
          code: 0,
          stdout: `${JSON.stringify(state.counts)}\n`,
          stderr: "",
        };
      if (file.endsWith("migration-history.sql")) {
        state.historyReads++;
        if (state.historyReads === 2 && beforeSecondRead)
          beforeSecondRead(state);
        return {
          code: 0,
          stdout: `${JSON.stringify(state.history)}\n`,
          stderr: "",
        };
      }
      if (file.endsWith("catalog-facts.sql")) {
        const applied = state.history.length === p.expectedHistoryAfter.length;
        return {
          code: 0,
          stdout: JSON.stringify(
            applied ? ["grant A", "grant B"] : ["grant A", "grant anon"],
          ),
          stderr: "",
        };
      }
      return { code: 0, stdout: `${verify(state)}\n`, stderr: "" };
    }
    if (cmd === "supabase") {
      const pending = p.expectedHistoryAfter
        .slice(state.history.length)
        .map((h) => `${h.version}_${h.name}.sql`);
      if (args.includes("--dry-run")) {
        return {
          code: 0,
          stdout:
            dryRun ??
            `Would push these migrations:\n${pending.map((f) => ` • ${f}`).join("\n")}\n`,
          stderr: "",
        };
      }
      onPush?.(state);
      state.pushed = true;
      if (pushOutput) return pushOutput;
      if (pushFails)
        return {
          code: 1,
          stdout: "",
          stderr: `ERROR: self-check failed at ${PROD_URL}`,
        };
      state.history = structuredClone(p.expectedHistoryAfter);
      if (countsAfterPush) state.counts = countsAfterPush;
      return {
        code: 0,
        stdout:
          "Applying migration 0002_harden.sql...\nFinished supabase db push.",
        stderr: "",
      };
    }
    throw new Error(`unexpected command ${cmd}`);
  };
  return { state, exec };
}

async function deployFixture(t) {
  const { root, head } = await repo(t);
  const p = await plan(root, head);
  const dir = join(root, ".deploy");
  await prepareWorkdir({
    exec: defaultExec,
    cwd: root,
    plan: p,
    dir,
    stage: "full",
  });
  return { root, p, dir };
}

const pushes = (state) =>
  state.calls.filter(([c, a]) => c === "supabase" && !a.includes("--dry-run"));

test("deploy applies only after history and dry run match, then verifies read-only", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const db = fakeDb(p);
  const logs = [];
  const receipt = await runDeploy({
    exec: db.exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
    log: (l) => logs.push(l),
  });
  assert.equal(receipt.status, "verified", JSON.stringify(receipt));
  assert.equal(receipt.writeAttempted, true);
  assert.equal(pushes(db.state).length, 1);
  const order = db.state.calls
    .filter(([c]) => c !== "git" && c !== "tar")
    .map(([c, a]) =>
      c === "psql"
        ? a.at(-1).split("/").at(-1)
        : a.includes("--dry-run")
          ? "dry-run"
          : "push",
    );
  // Row counts bracket only the push: baseline last before it, second read first after it.
  assert.deepEqual(order, [
    "migration-history.sql",
    "0002_harden.sql",
    "dry-run",
    "migration-history.sql",
    "0002_harden.invariant.sql",
    "push",
    "0002_harden.invariant.sql",
    "migration-history.sql",
    "0002_harden.sql",
  ]);
  assert.ok(
    Number.isInteger(receipt.countWindowMs) && receipt.countWindowMs >= 0,
  );
  assert.deepEqual(receipt.migrations, [
    { file: "0002_harden.sql", sha256: p.migrations[0].sha256 },
  ]);
  assert.match(renderReceipt(receipt), new RegExp(p.migrations[0].sha256));
  for (const [cmd, args, opts] of db.state.calls) {
    if (cmd === "supabase")
      assert.equal(opts.env.PGOPTIONS, "-c lock_timeout=15s");
    if (cmd === "psql") {
      assert.ok(args.includes("set lock_timeout = '10s'"));
      assert.ok(args.includes("VERBOSITY=sqlstate"));
    }
  }
  const push = pushes(db.state)[0][1];
  assert.ok(push.join(" ").includes("sslmode=require"));
  assert.ok(
    !push.includes("--include-all") &&
      !push.includes("--include-seed") &&
      !push.includes("--include-roles"),
  );
  assert.ok(!logs.join("\n").includes(SECRET));
  assert.match(renderReceipt(receipt), /verified/);
});

test("unexpected or already-applied hosted history refuses before any write", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  for (const [history, category] of [
    [
      [...p.expectedHistoryBefore, { version: "0099", name: "manual" }],
      "history-unexpected-entries",
    ],
    [p.expectedHistoryAfter, "history-already-applied"],
    [[], "history-missing-entries"],
  ]) {
    const db = fakeDb(p, { history });
    const receipt = await runDeploy({
      exec: db.exec,
      plan: p,
      dir,
      conn: parseDbUrl(PROD_URL),
      target: "production",
      cwd: root,
    });
    assert.equal(receipt.status, "refused");
    assert.equal(receipt.writeAttempted, false);
    assert.deepEqual(receipt.issues, [category]);
    assert.equal(pushes(db.state).length, 0);
  }
});

test("a dry run listing anything else refuses before any write", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  for (const dryRun of [
    "Would push:\n • 0002_harden.sql\n • 0003_surprise.sql",
    "Remote database is up to date.",
  ]) {
    const db = fakeDb(p, { dryRun });
    const receipt = await runDeploy({
      exec: db.exec,
      plan: p,
      dir,
      conn: parseDbUrl(PROD_URL),
      target: "production",
      cwd: root,
    });
    assert.deepEqual(
      [receipt.status, receipt.issues],
      ["refused", ["dry-run-differs"]],
    );
    assert.equal(pushes(db.state).length, 0);
  }
});

test("history drift between dry run and apply refuses before any write", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const db = fakeDb(p, {
    beforeSecondRead: (s) =>
      s.history.push({ version: "0098", name: "concurrent" }),
  });
  const receipt = await runDeploy({
    exec: db.exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
  });
  assert.deepEqual(
    [receipt.status, receipt.issues],
    ["refused", ["history-unexpected-entries"]],
  );
  assert.equal(pushes(db.state).length, 0);
});

test("a tampered deploy directory refuses before touching the database", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  await writeFile(
    join(dir, "supabase/migrations/0002_harden.sql"),
    "grant all on a to anon;\n",
  );
  const db = fakeDb(p);
  const receipt = await runDeploy({
    exec: db.exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
  });
  assert.deepEqual(
    [receipt.status, receipt.issues],
    ["refused", ["hash-mismatch"]],
  );
  assert.equal(db.state.calls.length, 0);
});

test("a failed apply stops, reports the recorded subset and demands fix-forward (no rollback)", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const db = fakeDb(p, { pushFails: true });
  const logs = [];
  const receipt = await runDeploy({
    exec: db.exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
    log: (l) => logs.push(l),
  });
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.appliedListed, "0 of 1");
  assert.match(receipt.recovery, /fix-forward only/);
  assert.match(receipt.recovery, /do not restore removed grants/);
  assert.equal(pushes(db.state).length, 1, "never retried or reversed");
  assert.ok(!logs.join("\n").includes(SECRET));
  assert.ok(!logs.join("\n").includes(REF));
});

test("verification issues after apply fail loudly with their codes", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const db = fakeDb(p, {
    verify: () =>
      '["client_execute:anon:public.set_entitlement(uuid,boolean,text,text)"]',
  });
  const receipt = await runDeploy({
    exec: db.exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
  });
  assert.equal(receipt.status, "verification-failed");
  assert.deepEqual(receipt.issues, ["verification-issues:0002_harden.sql"]);
  const verifyStep = receipt.steps.find(
    (x) => x.name === "verify 0002_harden.sql",
  );
  // Production prints counts per issue class only, never object or role names.
  assert.equal(verifyStep.detail, "1 issue(s): client_execute×1");
  assert.ok(!JSON.stringify(receipt).includes("set_entitlement"));
  const local = await runDeploy({
    exec: fakeDb(p, {
      verify: () =>
        '["client_execute:anon:public.set_entitlement(uuid,boolean,text,text)"]',
    }).exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "local-replay",
    cwd: root,
  });
  assert.match(
    local.steps.find((x) => x.name === "verify 0002_harden.sql").detail,
    /client_execute:anon:public\.set_entitlement/,
  );
  for (const output of ["", "not json", '{"ok":true}', "ERROR"]) {
    const bad = fakeDb(p, { verify: (st) => (st.pushed ? output : "[]") });
    const r = await runDeploy({
      exec: bad.exec,
      plan: p,
      dir,
      conn: parseDbUrl(PROD_URL),
      target: "production",
      cwd: root,
    });
    assert.equal(r.status, "verification-failed", output);
  }
});

test("replay refuses a vacuous verification and non-local targets; shows the change otherwise", async (t) => {
  const { root, head } = await repo(t);
  const p = await plan(root, head);
  const local = parseDbUrl(
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  );
  const prepare = async () => {
    const dir = join(root, `.replay-${Math.random().toString(16).slice(2)}`);
    await prepareWorkdir({
      exec: defaultExec,
      cwd: root,
      plan: p,
      dir,
      stage: "prior",
    });
    return dir;
  };
  await assert.rejects(
    runReplay({
      exec: fakeDb(p).exec,
      plan: p,
      dir: await prepare(),
      conn: parseDbUrl(PROD_URL),
      cwd: root,
    }),
    (e) => e.category === "replay-not-local",
  );
  await assert.rejects(
    runReplay({
      exec: fakeDb(p).exec,
      plan: p,
      dir: await prepare(),
      conn: local,
      cwd: root,
    }),
    (e) => e.category === "verification-vacuous",
  );
  const db = fakeDb(p, {
    verify: (s) => (s.history.length === 2 ? "[]" : '["not_applied"]'),
  });
  const { receipt, diff } = await runReplay({
    exec: db.exec,
    plan: p,
    dir: await prepare(),
    conn: local,
    cwd: root,
  });
  assert.equal(receipt.status, "verified");
  assert.deepEqual(diff, { removed: ["grant anon"], added: ["grant B"] });
  assert.deepEqual(diffFacts(["a", "b"], ["b", "c"]), {
    removed: ["a"],
    added: ["c"],
  });
});

test("a malformed baseline verification refuses before any write", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const db = fakeDb(p, { verify: () => "not json" });
  const receipt = await runDeploy({
    exec: db.exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
  });
  assert.deepEqual(
    [receipt.status, receipt.issues, receipt.writeAttempted],
    ["refused", ["verification-output-invalid"], false],
  );
  assert.equal(pushes(db.state).length, 0);
});

test("the reviewed residual is reported, never fatal; anything else still fails", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const run = (verify) =>
    runDeploy({
      exec: fakeDb(p, { verify }).exec,
      plan: p,
      dir,
      conn: parseDbUrl(PROD_URL),
      target: "production",
      cwd: root,
    });
  const ok = await run(() => '["residual:supabase_admin_public_default:f"]');
  assert.equal(ok.status, "verified");
  assert.match(
    ok.steps.find((x) => x.name === "verify 0002_harden.sql").detail,
    /residual reported 1/,
  );
  const bad = await run((st) =>
    st.pushed
      ? '["default_reaches_client:supabase_admin:global:f","residual:supabase_admin_public_default:f"]'
      : "[]",
  );
  assert.equal(bad.status, "verification-failed");
  assert.equal(
    bad.steps.find((x) => x.name === "verify 0002_harden.sql").detail,
    "1 issue(s): default_reaches_client×1",
  );
  assert.equal(issueCounts(["a:x", "b:y", "a:z", "c"]), "a×2, b×1, c×1");
});

test("row counts moving after a successful, verified apply is a distinct non-failure outcome", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const db = fakeDb(p, { countsAfterPush: { "public.profiles": 98765 } });
  const logs = [];
  const receipt = await runDeploy({
    exec: db.exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
    log: (l) => logs.push(l),
  });
  assert.equal(receipt.status, "applied-verified-counts-changed");
  assert.deepEqual(receipt.issues, []);
  assert.deepEqual(receipt.warnings, ["row-count-changed:0002_harden.sql"]);
  assert.match(receipt.recovery, /^no forward migration needed/);
  assert.match(receipt.recovery, /likely live/);
  assert.match(
    receipt.recovery,
    /runs scripts\/backend\/deploy\/verify\/0002_harden\.invariant\.sql in the Supabase SQL editor/,
  );
  assert.match(receipt.recovery, /Never post the counts publicly/);
  assert.doesNotMatch(receipt.recovery, /write a new forward migration/);
  const rendered = renderReceipt(receipt);
  assert.match(
    rendered,
    /⚠️ Production deploy: applied-verified-counts-changed/,
  );
  const text = `${logs.join("\n")}${JSON.stringify(receipt)}${rendered}${renderFinal(receipt, {})}`;
  assert.ok(!text.includes("98765"));
  assert.ok(!text.includes('"public.profiles":3'));
  assert.match(
    receipt.steps.find((x) => x.name === "row counts 0002_harden.sql").detail,
    /changed during the \d+ ms window around the push \(counts not printed; likely live traffic during the run\)/,
  );

  // If verification also fails, it is a failed deploy; the count change stays a warning.
  const both = await runDeploy({
    exec: fakeDb(p, {
      countsAfterPush: { "public.profiles": 98765 },
      verify: (st) => (st.pushed ? '["client_execute:anon:x"]' : "[]"),
    }).exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
  });
  assert.equal(both.status, "verification-failed");
  assert.match(both.recovery, /write a new forward migration/);
  assert.deepEqual(both.warnings, ["row-count-changed:0002_harden.sql"]);

  // Unchanged counts: plain verified.
  const same = await runDeploy({
    exec: fakeDb(p).exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
  });
  assert.equal(same.status, "verified");
});

test("the apply command exits 0 with a warning when only the row counts moved", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const planFile = join(root, ".plan.json");
  await writeFile(planFile, JSON.stringify(p));
  const out = {
    text: "",
    write(x) {
      this.text += x;
    },
  };
  const code = await main(
    ["apply", "--plan", planFile, "--dir", dir],
    {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      EXPECTED_PLAN_DIGEST: p.digest,
      SUPABASE_DB_URL: PROD_URL,
    },
    {
      exec: fakeDb(p, { countsAfterPush: { "public.profiles": 98765 } }).exec,
      cwd: root,
      out,
      platform: "linux",
    },
  );
  assert.equal(code, 0);
  assert.match(
    out.text,
    /::warning title=Applied and verified; row-count check changed::/,
  );
  assert.doesNotMatch(out.text, /::error/);
  assert.ok(!out.text.includes("98765"));
});

const APPLY_ENV = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
};
const COUNT_READ_FAILED =
  /^The change was applied and the end-state checks passed, but the second row-count read failed, so the data-loss cross-check did not run\. Do not re-run the apply\. Check the counts privately in the Supabase SQL editor by running scripts\/backend\/deploy\/verify\/0002_harden\.invariant\.sql; never post the counts publicly\.$/;

test("an unreadable second row-count read fails the run: the data-loss cross-check did not run", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const cases = {
    "psql error": {
      psqlFailure: (file, st) =>
        st.pushed && file.endsWith(".invariant.sql")
          ? `psql:${file}:3: ERROR:  57P01\n`
          : null,
    },
    "invalid output": { countsAfterPush: "garbled" },
    "empty object": { countsAfterPush: {} },
  };
  for (const [name, options] of Object.entries(cases)) {
    const logs = [];
    const receipt = await runDeploy({
      exec: fakeDb(p, options).exec,
      plan: p,
      dir,
      conn: parseDbUrl(PROD_URL),
      target: "production",
      cwd: root,
      log: (l) => logs.push(l),
    });
    assert.equal(receipt.status, "verification-failed", name);
    assert.equal(receipt.applied, true, name);
    assert.deepEqual(receipt.issues, ["row-count-unreadable:0002_harden.sql"]);
    assert.deepEqual(receipt.warnings, [], name);
    assert.match(receipt.recovery, COUNT_READ_FAILED, name);
    assert.doesNotMatch(receipt.recovery, /likely live/, name);
    const row = receipt.steps.find(
      (x) => x.name === "row counts 0002_harden.sql",
    );
    assert.equal(row.outcome, "failed", name);
    assert.match(row.detail, /data-loss cross-check did not run/, name);
    assert.match(
      renderReceipt(receipt),
      /❌ Production deploy: verification-failed/,
    );
    const text = `${logs.join("\n")}${JSON.stringify(receipt)}${renderReceipt(receipt)}${renderFinal(receipt, {})}`;
    assert.ok(!text.includes('"public.profiles":3'), name);
  }

  // Another verification failure as well: still fix-forward, and the count gap is named.
  const both = await runDeploy({
    exec: fakeDb(p, {
      countsAfterPush: "garbled",
      verify: (st) => (st.pushed ? '["client_execute:anon:x"]' : "[]"),
    }).exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
  });
  assert.equal(both.status, "verification-failed");
  assert.match(both.recovery, /write a new forward migration/);
  assert.match(
    both.recovery,
    /second row-count read also failed, so the data-loss cross-check did not run\. Do not re-run the apply\./,
  );
});

test("the apply command exits 1 with an error, never a warning, when the second count read fails", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const planFile = join(root, ".plan.json");
  await writeFile(planFile, JSON.stringify(p));
  const out = {
    text: "",
    write(x) {
      this.text += x;
    },
  };
  const code = await main(
    ["apply", "--plan", planFile, "--dir", dir],
    { ...APPLY_ENV, EXPECTED_PLAN_DIGEST: p.digest, SUPABASE_DB_URL: PROD_URL },
    {
      exec: fakeDb(p, {
        psqlFailure: (file, st) =>
          st.pushed && file.endsWith(".invariant.sql")
            ? `psql:${file}:3: ERROR:  08006\n`
            : null,
      }).exec,
      cwd: root,
      out,
      platform: "linux",
    },
  );
  assert.equal(code, 1);
  assert.match(
    out.text,
    /::error title=Production deploy verification-failed::row-count-unreadable:0002_harden\.sql\. The change was applied and the end-state checks passed, but the second row-count read failed, so the data-loss cross-check did not run\. Do not re-run the apply\. Check the counts privately in the Supabase SQL editor/,
  );
  assert.doesNotMatch(out.text, /::warning/);
  assert.doesNotMatch(out.text, /likely live/);
  assert.ok(!out.text.includes('"public.profiles":3'));
});

test("an unreadable baseline row-count read refuses before any write", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const cases = {
    "psql error": {
      psqlFailure: (file) =>
        file.endsWith(".invariant.sql")
          ? `psql:${file}:3: ERROR:  57014\n`
          : null,
    },
    "invalid output": {},
  };
  for (const [name, options] of Object.entries(cases)) {
    const db = fakeDb(p, options);
    if (name === "invalid output") db.state.counts = ["not", "counts"];
    const receipt = await runDeploy({
      exec: db.exec,
      plan: p,
      dir,
      conn: parseDbUrl(PROD_URL),
      target: "production",
      cwd: root,
    });
    assert.equal(receipt.status, "refused", name);
    assert.equal(receipt.writeAttempted, false, name);
    assert.equal(pushes(db.state).length, 0, name);
    assert.deepEqual(
      receipt.issues,
      [name === "psql error" ? "sql-failed" : "row-count-output-invalid"],
      name,
    );
    assert.equal(receipt.recovery, "none needed: nothing was written");
  }
});

test("an interruption right after a successful push says applied, never result unknown", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const db = fakeDb(p);
  let persisted = null;
  let atSecondRead = null;
  // The receipt on disk when the first post-push read starts is what an interruption leaves.
  const exec = async (cmd, args, opts) => {
    if (cmd === "psql" && db.state.pushed && atSecondRead === null)
      atSecondRead = structuredClone(persisted);
    return db.exec(cmd, args, opts);
  };
  const receipt = await runDeploy({
    exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
    onProgress: async (r) => {
      persisted = structuredClone(r);
    },
  });
  assert.equal(receipt.status, "verified");
  assert.ok(atSecondRead, "a post-push read happened");
  assert.equal(atSecondRead.applied, true);
  assert.equal(atSecondRead.status, "in-progress");
  const text = renderFinal(atSecondRead, {
    applyOutcome: "cancelled",
    jobStatus: "cancelled",
  });
  assert.match(
    text,
    /applied; verification not completed \(interrupted: cancelled\)/,
  );
  assert.match(text, /Recovery: do not re-run the apply\./);
  assert.doesNotMatch(text, /result unknown/);
});

test("SQLSTATE is extracted from psql's script-prefixed and the CLI's formats, nothing else", () => {
  for (const [text, code] of [
    ["psql:/tmp/x/migration-history.sql:12: ERROR:  42501\n", "42501"],
    ["psql:/tmp/x/verify/0014_a.sql:3: FATAL:  57P01", "57P01"],
    ["ERROR:  23505\n", "23505"],
    [
      'ERROR: new row violates check constraint "x" (SQLSTATE 23514)\nAt statement 3: ...',
      "23514",
    ],
    [
      "failed to connect: FATAL: password authentication failed (SQLSTATE 28P01)",
      "28P01",
    ],
    ["SQLSTATE: 42P01", "42P01"],
    ["connection refused", "unknown"],
  ]) {
    assert.equal(failureFacts(text).sqlstate, code, text);
  }
});

test("production query failures after apply report the real SQLSTATE and nothing else", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const logs = [];
  const receipt = await runDeploy({
    exec: fakeDb(p, {
      psqlFailure: (file, st) =>
        st.pushed && file.endsWith("0002_harden.sql")
          ? `psql:${file}:41: ERROR:  42501\nDETAIL:  Key (user_id)=(${"5f1e0000-0000-4000-8000-00000000beef"}) already exists.\n`
          : null,
    }).exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
    log: (l) => logs.push(l),
  });
  assert.equal(receipt.status, "verification-failed");
  const detail = receipt.steps.find(
    (x) => x.name === "verify 0002_harden.sql",
  ).detail;
  assert.equal(detail, "sql-failed sqlstate=42501");
  const text = `${logs.join("\n")}${JSON.stringify(receipt)}${renderReceipt(receipt)}`;
  assert.ok(!text.includes("Key (user_id)"));
  assert.ok(!text.includes("5f1e0000"));
  assert.ok(!text.includes(":41:"));
});

// Negative control for public logs: a constraint failure quoting row values must never surface.
const ROW_SENTINEL = "5f1e0000-0000-4000-8000-00000000beef";
const LEAKY_PUSH = {
  code: 1,
  stdout: "Applying migration 0002_harden.sql...\n",
  stderr:
    `ERROR: new row for relation "entitlements" violates check constraint "x" (SQLSTATE 23514)\n` +
    `DETAIL: Failing row contains (${ROW_SENTINEL}, t, private-subscriber-sentinel).\n` +
    `Key (user_id)=(${ROW_SENTINEL}) already exists.\n` +
    `At statement 3: update public.entitlements set source = 'private-subscriber-sentinel'\n`,
};
const LEAKS = [
  ROW_SENTINEL,
  "Failing row contains",
  "Key (user_id)",
  "private-subscriber-sentinel",
  "violates check constraint",
];

test("production prints only category, SQLSTATE and planned file for tool failures", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const logs = [];
  const receipt = await runDeploy({
    exec: fakeDb(p, {
      pushOutput: LEAKY_PUSH,
      psqlFailure: (file, st) =>
        st.pushed && file.endsWith("migration-history.sql")
          ? `psql:${file}:7: ERROR:  23505\nDETAIL:  Key (user_id)=(${ROW_SENTINEL}) already exists.\n`
          : null,
    }).exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
    log: (l) => logs.push(l),
  });
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.appliedListed, "unknown");
  const text = `${logs.join("\n")}\n${JSON.stringify(receipt)}\n${renderReceipt(receipt)}\n${renderFinal(receipt, {})}`;
  for (const leak of LEAKS) assert.ok(!text.includes(leak), leak);
  assert.match(text, /apply-failed sqlstate=23514 migration=0002_harden\.sql/);
  assert.deepEqual(failureFacts("ERROR:  42501\n"), {
    sqlstate: "42501",
    migration: null,
  });
  // The same failure in the local rehearsal keeps full text for debugging.
  const localLogs = [];
  await runDeploy({
    exec: fakeDb(p, { pushOutput: LEAKY_PUSH }).exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "local-replay",
    cwd: root,
    log: (l) => localLogs.push(l),
  });
  assert.ok(localLogs.join("\n").includes("Failing row contains"));
});

test("the apply command's stdout and job summary carry no row values (end to end)", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const planFile = join(root, ".plan.json");
  const summary = join(root, ".summary.md");
  const receiptFile = join(root, ".receipt.json");
  await writeFile(planFile, JSON.stringify(p));
  const out = {
    text: "",
    write(x) {
      this.text += x;
    },
  };
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    EXPECTED_PLAN_DIGEST: p.digest,
    SUPABASE_DB_URL: PROD_URL,
    GITHUB_STEP_SUMMARY: summary,
  };
  const code = await main(
    ["apply", "--plan", planFile, "--dir", dir, "--receipt", receiptFile],
    env,
    {
      exec: fakeDb(p, { pushOutput: LEAKY_PUSH }).exec,
      cwd: root,
      out,
      platform: "linux",
    },
  );
  assert.equal(code, 1);
  const written = `${out.text}\n${await readFile(summary, "utf8")}\n${await readFile(receiptFile, "utf8")}`;
  for (const leak of LEAKS) assert.ok(!written.includes(leak), leak);
  // The only appearance of credential parts is the runner's own ::add-mask:: registration.
  const unmasked = out.text
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
  for (const v of [SECRET, REF]) assert.ok(!unmasked.includes(v), v);
  assert.equal(
    JSON.parse(await readFile(receiptFile, "utf8")).status,
    "stopped",
  );
});

test("closing record reports only what steps actually recorded when a run is interrupted", async (t) => {
  const { root, p, dir } = await deployFixture(t);
  const snapshots = [];
  await runDeploy({
    exec: fakeDb(p).exec,
    plan: p,
    dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: root,
    onProgress: async (r) => snapshots.push(structuredClone(r)),
  });
  const last = (name) => (r) => r.steps.length && r.steps.at(-1).name === name;
  const cancelled = { applyOutcome: "cancelled", jobStatus: "cancelled" };

  // Interrupted during the push: write started, result unknown.
  const duringPush = snapshots.find(
    (r) => r.writeAttempted && !r.applied && r.status === "in-progress",
  );
  assert.ok(duringPush, "a record exists before the push returns");
  const pushText = renderFinal(duringPush, cancelled);
  assert.match(
    pushText,
    /apply started; result unknown \(interrupted: cancelled\)/,
  );
  assert.match(pushText, /Migration history: UNKNOWN/);
  assert.match(pushText, /fix forward only/);
  assert.match(pushText, /do not re-run the apply until history is checked/);

  // Interrupted after the push but before history-after: applied, history still unknown.
  const afterApply = snapshots.find(last("apply"));
  const applyText = renderFinal(afterApply, cancelled);
  assert.match(
    applyText,
    /applied; verification not completed \(interrupted: cancelled\)/,
  );
  assert.match(applyText, /Migration history: UNKNOWN/);
  assert.match(applyText, /do not re-run the apply/);

  // Interrupted after history-after: history known from that step only.
  const afterHistory = snapshots.find(last("migration history after"));
  const historyText = renderFinal(afterHistory, {
    applyOutcome: "failure",
    jobStatus: "failure",
  });
  assert.match(
    historyText,
    /applied; verification not completed \(interrupted: stopped or timed out\)/,
  );
  assert.match(
    historyText,
    /Migration history: known: 1 of 1 planned recorded/,
  );
  assert.match(historyText, /Steps recorded before the end of the run:/);
  assert.match(historyText, /✅ migration history after/);

  for (const text of [pushText, applyText, historyText])
    assert.doesNotMatch(text, /see steps above/);

  // Interrupted before any write.
  const beforeWrite = snapshots.find(
    last("migration history unchanged before apply"),
  );
  assert.match(
    renderFinal(beforeWrite, cancelled),
    /interrupted before any write \(cancelled\)[\s\S]*Migration history: known: unchanged \(nothing was written\)/,
  );
  assert.match(
    renderFinal(null, { applyOutcome: "", jobStatus: "failure" }),
    /did not leave a record.*UNKNOWN.*do not re-run the apply until history is checked/s,
  );
  const done = snapshots.at(-1);
  assert.equal(done.status, "verified");
  assert.match(
    renderFinal(done, { applyOutcome: "success", jobStatus: "success" }),
    /Outcome: verified[\s\S]*Migration history: known: 1 of 1 planned recorded/,
  );
});

test("final-summary command works without any secret and tolerates a missing receipt", async (t) => {
  const { root } = await repo(t);
  const out = {
    text: "",
    write(x) {
      this.text += x;
    },
  };
  const code = await main(
    ["final-summary", "--receipt", join(root, "absent.json")],
    { APPLY_OUTCOME: "skipped", JOB_STATUS: "cancelled" },
    { out },
  );
  assert.equal(code, 0);
  assert.match(
    out.text,
    /did not leave a record \(step outcome: skipped, job: cancelled\)/,
  );
});

// ── Staleness while approval is pending (main moves) ─────────────────────────────────────────

test("freshness: unchanged tip or untouched planned files proceed", async (t) => {
  const { root, head } = await repo(t);
  const p = await plan(root, head);
  const g = makeGit(defaultExec, root);
  assert.equal(
    (await checkFreshness({ git: g, plan: p, tipRef: "main" })).mode,
    "tip-unchanged",
  );
  await put(root, "README.md", "unrelated\n");
  await put(root, "supabase/migrations/0003_later.sql", "select 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "unrelated and newer");
  const moved = await checkFreshness({ git: g, plan: p, tipRef: "main" });
  assert.equal(moved.mode, "files-identical");
  assert.notEqual(moved.tip, head);
});

test("freshness: main changing, reverting or re-pointing a planned file refuses", async (t) => {
  for (const mutate of [
    async (root) =>
      put(
        root,
        "supabase/migrations/0002_harden.sql",
        "revoke all on a from public;\n",
      ),
    async (root) => rm(join(root, "supabase/migrations/0002_harden.sql")),
    async (root) =>
      put(
        root,
        "scripts/backend/deploy/verify/0002_harden.sql",
        "select '[\"x\"]';\n",
      ),
    async (root) =>
      put(
        root,
        "scripts/backend/deploy/verify/0002_harden.invariant.sql",
        "select '{\"a\":1}';\n",
      ),
    async (root) => put(root, "supabase/config.toml", 'project_id = "other"\n'),
    async (root) =>
      put(
        root,
        "supabase/migrations/0001_init.sql",
        "create table b (id int);\n",
      ),
    async (root) =>
      put(root, "scripts/backend/deploy/deploy.mjs", "changed tooling\n"),
    async (root) =>
      put(
        root,
        ".github/workflows/supabase-production-deploy.yml",
        "changed\n",
      ),
    async (root) =>
      put(
        root,
        "scripts/backend/deploy/sql/migration-history.sql",
        "select '[]';\n",
      ),
    async (root) =>
      put(root, "supabase/migrations/0001_extra.sql", "select 1;\n"),
  ]) {
    const { root, head } = await repo(t);
    const p = await plan(root, head);
    await mutate(root);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "main moved");
    await refuses(
      checkFreshness({
        git: makeGit(defaultExec, root),
        plan: p,
        tipRef: "main",
      }),
      "main-moved",
    );
  }
  // Reverting the whole change (a revert commit) also refuses.
  const { root, head } = await repo(t);
  const p = await plan(root, head);
  git(root, "rm", "-q", "supabase/migrations/0002_harden.sql");
  git(root, "commit", "-q", "-m", "Revert 0002");
  await refuses(
    checkFreshness({
      git: makeGit(defaultExec, root),
      plan: p,
      tipRef: "main",
    }),
    "main-moved",
  );
  // A rewritten main that no longer contains the commit refuses.
  git(root, "checkout", "-q", "--orphan", "rewritten");
  git(root, "commit", "-q", "-m", "rewritten history");
  await refuses(
    checkFreshness({
      git: makeGit(defaultExec, root),
      plan: p,
      tipRef: "rewritten",
    }),
    "main-moved",
  );
});

// ── Merge-commit history (first parent) ──────────────────────────────────────────────────────

test("a commit reached through a merge's second parent needs main-identical checks", async (t) => {
  const { root, head } = await repo(t);
  git(root, "checkout", "-q", "-b", "feature");
  await put(root, "supabase/migrations/0003_feature.sql", "select 3;\n");
  await put(
    root,
    "scripts/backend/deploy/verify/0003_feature.sql",
    "select '[]';\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feature");
  const feature = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  await put(root, "README.md", "main work\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "main work");
  git(root, "merge", "-q", "--no-ff", "--no-edit", "feature");
  const merge = git(root, "rev-parse", "HEAD");

  const viaSecondParent = await plan(root, feature, "0003_feature.sql");
  assert.equal(viaSecondParent.onFirstParent, false);
  const warned = renderPlan(viaSecondParent);
  assert.match(
    warned,
    /⚠️ \*\*The commit is not on main's own line of history\*\*/,
  );
  assert.match(warned, /reject and check the commit you pasted/);
  const viaMerge = await plan(root, merge, "0003_feature.sql");
  assert.equal(viaMerge.onFirstParent, true);
  assert.equal((await plan(root, head)).onFirstParent, true);

  for (const [path, text] of [
    [
      "scripts/backend/deploy/verify/0003_feature.sql",
      "select '[\"stricter\"]';\n",
    ],
    ["supabase/config.toml", 'project_id = "changed"\n'],
  ]) {
    await put(root, path, text);
    git(root, "commit", "-q", "-am", `change ${path}`);
    await refuses(
      plan(root, feature, "0003_feature.sql"),
      "file-changed-on-main",
    );
    git(root, "reset", "-q", "--hard", merge);
  }
});

// ── GitHub protection ────────────────────────────────────────────────────────────────────────

function protectedEnvironment() {
  return {
    environment: {
      id: 9,
      name: "supabase-production",
      can_admins_bypass: false,
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { id: 257643931 } }],
        },
        { type: "branch_policy" },
      ],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    },
    branches: {
      total_count: 1,
      branch_policies: [{ name: "main", type: "branch" }],
    },
  };
}

test("environment protection must be owner-only reviewer, no admin bypass, main only", () => {
  assert.deepEqual(checkProtection(protectedEnvironment()), {
    ok: true,
    issues: [],
    warnings: [],
  });
  const cases = [
    [(f) => (f.environment = null), "environment-missing"],
    [
      (f) => (f.environment.protection_rules = []),
      "required-reviewer-not-exactly-owner",
    ],
    [
      (f) =>
        f.environment.protection_rules[0].reviewers.push({
          type: "User",
          reviewer: { id: 1 },
        }),
      "required-reviewer-not-exactly-owner",
    ],
    [
      (f) =>
        (f.environment.protection_rules[0].reviewers = [
          { type: "Team", reviewer: { id: 257643931 } },
        ]),
      "required-reviewer-not-exactly-owner",
    ],
    [
      (f) => (f.environment.can_admins_bypass = true),
      "admin-bypass-not-disabled",
    ],
    [
      (f) => delete f.environment.can_admins_bypass,
      "admin-bypass-not-disabled",
    ],
    [
      (f) => (f.environment.deployment_branch_policy = null),
      "deployment-branches-not-main-only",
    ],
    [
      (f) =>
        (f.environment.deployment_branch_policy = {
          protected_branches: true,
          custom_branch_policies: false,
        }),
      "deployment-branches-not-main-only",
    ],
    [
      (f) =>
        f.branches.branch_policies.push({ name: "release/*", type: "branch" }),
      "deployment-branches-not-main-only",
    ],
    [
      (f) => (f.branches.branch_policies[0] = { name: "main", type: "tag" }),
      "deployment-branches-not-main-only",
    ],
  ];
  for (const [mutate, issue] of cases) {
    const f = protectedEnvironment();
    mutate(f);
    const result = checkProtection(f);
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes(issue), `${issue}: ${result.issues}`);
  }
  const selfReview = protectedEnvironment();
  selfReview.environment.protection_rules[0].prevent_self_review = true;
  assert.equal(checkProtection(selfReview).ok, true);
  assert.equal(checkProtection(selfReview).warnings.length, 1);
});

test("apply phase also requires the owner's actual approval of this run", () => {
  const approved = {
    state: "approved",
    user: { id: 257643931 },
    environments: [{ id: 9 }],
  };
  assert.equal(
    checkProtection({ ...protectedEnvironment(), approvals: [approved] }).ok,
    true,
  );
  assert.equal(
    checkProtection({
      ...protectedEnvironment(),
      approvals: [approved, approved],
    }).ok,
    true,
  );
  for (const approvals of [
    [],
    [{ ...approved, user: { id: 5 } }],
    [{ ...approved, environments: [{ id: 10 }] }],
    [approved, { ...approved, state: "rejected" }],
    null,
  ]) {
    assert.deepEqual(
      checkProtection({ ...protectedEnvironment(), approvals }).issues,
      ["owner-approval-not-observed"],
    );
  }
});

test("protection readback is GET-only, fails closed on errors and treats 404 as missing", async () => {
  const f = protectedEnvironment();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push([url, options]);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.body, undefined);
    if (url.endsWith("/environments/supabase-production"))
      return { ok: true, status: 200, json: async () => f.environment };
    if (url.includes("deployment-branch-policies"))
      return { ok: true, status: 200, json: async () => f.branches };
    if (url.endsWith("/actions/runs/77/approvals"))
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            state: "approved",
            user: { id: 257643931 },
            environments: [{ id: 9 }],
          },
        ],
      };
    throw new Error(url);
  };
  const result = await readProtection({
    fetchImpl,
    repository: "ZackC-1/still-app",
    token: "t",
    runId: "77",
    includeApprovals: true,
  });
  assert.equal(result.ok, true);
  assert.equal(seen[0][1].headers.Authorization, "Bearer t");
  const missing = await readProtection({
    fetchImpl: async () => ({ ok: false, status: 404 }),
    repository: "o/r",
  });
  assert.deepEqual(missing.issues, ["environment-missing"]);
  await assert.rejects(
    readProtection({
      fetchImpl: async () => ({ ok: false, status: 500 }),
      repository: "o/r",
    }),
    (e) => e.category === "github-unavailable",
  );
  await assert.rejects(
    readProtection({ fetchImpl, repository: "o/r;x" }),
    (e) => e.category === "input-invalid",
  );
});

// ── Entry point ──────────────────────────────────────────────────────────────────────────────

test("apply and replay refuse off the GitHub runner before reading any secret", async () => {
  const out = {
    text: "",
    write(s) {
      this.text += s;
    },
  };
  const env = { SUPABASE_DB_URL: PROD_URL, GITHUB_ACTIONS: "false" };
  await assert.rejects(
    main(["apply", "--plan", "/nonexistent"], env, { out }),
    (e) => e.category === "runner-required",
  );
  await assert.rejects(
    main(["replay", "--plan", "/nonexistent"], env, { out }),
    (e) => e.category === "runner-required",
  );
  await assert.rejects(
    main(["deploy-everything"], env, { out }),
    (e) => e.category === "input-invalid",
  );
  assert.equal(out.text, "");
});

test("the CLI prints only a fixed refusal and never the secret", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("./deploy.mjs", import.meta.url).pathname,
      "apply",
      "--plan",
      "/nonexistent",
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SUPABASE_DB_URL: PROD_URL,
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(REF));
  assert.match(result.stderr, /Refused \((runner-required|context-invalid)\)/);
});

test("offline plan command works without secrets and prints the reviewable plan", async (t) => {
  const { root, head } = await repo(t);
  const out = {
    text: "",
    write(s) {
      this.text += s;
    },
  };
  const code = await main(
    ["plan", "--print"],
    {
      DEPLOY_SHA: head,
      DEPLOY_MIGRATIONS: "0002_harden.sql",
      DEPLOY_FUNCTIONS: "",
    },
    { cwd: root, out },
  );
  assert.equal(code, 0);
  assert.match(out.text, /Supabase production deploy plan/);
  assert.match(out.text, /0002_harden\.sql/);
});
