// Offline tests for the protected deploy logic. No database, no network, no secrets: git runs
// against throwaway repositories and every database/CLI call goes to an in-memory fake.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
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
  renderReceipt,
  runDeploy,
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
  assert.match(renderPlan(p), /0002_harden\.sql/);
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

test("the 0014 verification covers every promise of the migration's self-check", async () => {
  const real = await readFile(
    new URL(
      "./verify/0014_server_rpc_privilege_hardening.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const code of [
    "writer_missing:",
    "service_role_execute:",
    "client_execute:",
    "write_profile_settings_beyond_authenticated",
    "free_sync_missing",
    "rule_read_missing",
    "unpinned_search_path:",
    "guard_missing:",
    "rls_disabled:",
    "writer_table_privilege:",
    "client_write:",
    "client_read:",
    "client_schema_create",
    "postgres_global_function_default",
    "postgres_public_schema_default",
    "postgres_global_relation_default",
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
  ]) {
    assert.ok(real.includes(`'${sig}'`), sig);
  }
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
  } = {},
) {
  const state = {
    history: structuredClone(history ?? p.expectedHistoryBefore),
    calls: [],
    historyReads: 0,
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
      if (pushFails)
        return {
          code: 1,
          stdout: "",
          stderr: `ERROR: self-check failed at ${PROD_URL}`,
        };
      state.history = structuredClone(p.expectedHistoryAfter);
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
  assert.deepEqual(order, [
    "migration-history.sql",
    "dry-run",
    "migration-history.sql",
    "push",
    "migration-history.sql",
    "0002_harden.sql",
  ]);
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
  assert.match(receipt.steps.at(-1).detail, /client_execute:anon/);
  for (const output of ["", "not json", '{"ok":true}', "ERROR"]) {
    const bad = fakeDb(p, { verify: () => output });
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
