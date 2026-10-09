// Offline tests for the owner-approved operations (pause / resume settings sync). No database,
// network or secret: git runs against throwaway repositories and every psql call goes to an
// in-memory fake of the roles, connections and migration history it would touch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  OPERATION_KIND,
  Refusal,
  TOOLING_PATHS,
  assertSamePlan,
  checkFreshness,
  defaultExec,
  lintVerificationSql,
  main,
  makeGit,
  parseDbUrl,
  prepareWorkdir,
  sha256,
  stripComments,
} from "./deploy.mjs";
import {
  OPERATIONS,
  ROLE_FACTS_SQL,
  SETTLE_MS,
  FUNCTION_ROLES,
  POLICY_MODES,
  PROTECTED_OPERATOR_SUBJECT,
  PROVISIONAL,
  QA_SANDBOX_CUTOFF,
  QA_SANDBOX_SALES_BUILDS,
  QA_SANDBOX_SALES_TEMPLATES,
  QA_SANDBOX_WRITER_ROLE,
  SETTINGS_WRITER_ROLE,
  WORKFLOW_OPERATIONS,
  assertOperationDefinition,
  assertOperationScope,
  assertPlanPinned,
  canonicalSubjects,
  createOperationPlan,
  isKnownOperation,
  operationNamed,
  renderOperationFinal,
  renderOperationPlan,
  renderOperationReceipt,
  renderSalesBody,
  resolveOperation,
  runOperation,
  runOperationReplay,
  untouchedRoles,
} from "./operations.mjs";

const SECRET = "synthetic-password-sentinel-7d1e";
const REF = "zyxwvutsrqponmlkjihg";
const PROD_URL = `postgresql://postgres.${REF}:${SECRET}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REPO = new URL("../../../", import.meta.url);
const PAUSE = "pause-settings-sync";
const RESUME = "resume-settings-sync";
const QA_PAUSE = "pause-qa-sandbox";
const QA_RESUME = "resume-qa-sandbox";
const LOGIN_SWITCHES = [PAUSE, RESUME, QA_PAUSE, QA_RESUME];
const POLICY_OFF = "qa-sandbox-sales-policy-off";
const POLICY_ON = "qa-sandbox-sales-policy-on";
const SUBJECTS_ENABLE = "qa-sandbox-subjects-enable";
const SUBJECTS_DISABLE = "qa-sandbox-subjects-disable";
const TRANSACTIONAL = [
  POLICY_OFF,
  POLICY_ON,
  SUBJECTS_ENABLE,
  SUBJECTS_DISABLE,
];
/** A role name that must never reach public output (stands in for hosted catalog detail). */
const HIDDEN_ROLE = "hosted_internal_role_sentinel";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function put(root, path, text) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const real = (path) => readFile(new URL(path, REPO), "utf8");

/** A throwaway repository holding the real operation files and a minimal migration history. */
async function repo(t, { omit = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "still-operation-"));
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
    "supabase/migrations/0015_settings_sync_per_field.sql",
    "create role still_settings_writer nologin;\n",
  );
  await put(
    root,
    "supabase/migrations/0016_product_policy.sql",
    "create table private.product_policy_revisions (revision bigint);\n",
  );
  await put(
    root,
    "supabase/migrations/0021_qa_sandbox_access.sql",
    "create role still_qa_sandbox_writer nologin;\n",
  );
  for (const op of Object.values(OPERATIONS))
    for (const file of [op.sql, op.verification])
      if (!omit.includes(file.path))
        await put(root, file.path, await real(file.path));
  for (const path of TOOLING_PATHS) await put(root, path, `tooling ${path}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

const plan = (root, sha, operation = PAUSE, extra = {}) =>
  createOperationPlan({
    git: makeGit(defaultExec, root),
    sha,
    operation,
    ...extra,
  });

async function refuses(promise, category) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${error}`);
    assert.equal(error.category, category, error.message);
    return true;
  });
}

function throwsCategory(fn, category) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${error}`);
    assert.equal(error.category, category, error.message);
    return true;
  });
}

// ── The registry and its pinned SQL ──────────────────────────────────────────────────────────

test("exactly the login switches exist, and each meets the operation contract", () => {
  assert.deepEqual(Object.keys(OPERATIONS), [
    ...LOGIN_SWITCHES,
    ...TRANSACTIONAL,
  ]);
  for (const [name, op] of Object.entries(OPERATIONS))
    assertOperationDefinition(name, op);
  for (const [name, role, login, counterpart] of [
    [PAUSE, SETTINGS_WRITER_ROLE, false, RESUME],
    [RESUME, SETTINGS_WRITER_ROLE, true, PAUSE],
    [QA_PAUSE, QA_SANDBOX_WRITER_ROLE, false, QA_RESUME],
    [QA_RESUME, QA_SANDBOX_WRITER_ROLE, true, QA_PAUSE],
  ]) {
    const op = OPERATIONS[name];
    assert.deepEqual(
      [op.kind, op.role, op.login, op.closesConnections, op.counterpart],
      ["role-login", role, login, !login, counterpart],
    );
    // Every function role except the operation's own target stays untouched.
    assert.deepEqual(
      untouchedRoles(op),
      FUNCTION_ROLES.filter((r) => r !== role),
    );
    assert.ok(!untouchedRoles(op).includes(role));
  }
  assert.deepEqual([...FUNCTION_ROLES].sort(), [
    "still_entitlement_writer",
    "still_policy_admin",
    "still_policy_reader",
    "still_qa_sandbox_writer",
    "still_settings_writer",
  ]);
  // Negative controls: a definition without a verification step, touching another role, or a
  // pause that leaves connections open is not a valid operation.
  const { verification: _dropped, ...noVerification } = OPERATIONS[PAUSE];
  for (const broken of [
    noVerification,
    {
      ...OPERATIONS[PAUSE],
      verification: { ...OPERATIONS[PAUSE].verification, sha256: "" },
    },
    { ...OPERATIONS[PAUSE], role: "still_policy_reader" },
    { ...OPERATIONS[PAUSE], role: "still_entitlement_writer" },
    { ...OPERATIONS[PAUSE], closesConnections: false },
    { ...OPERATIONS[PAUSE], noChange: undefined },
    { ...OPERATIONS[PAUSE], noChange: "already-resumed" },
    { ...OPERATIONS[PAUSE], kind: "anything-goes" },
    { ...OPERATIONS[PAUSE], kind: undefined },
    { ...OPERATIONS[PAUSE], counterpart: "" },
  ])
    throwsCategory(
      () => assertOperationDefinition(PAUSE, broken),
      "operation-definition-invalid",
    );
  throwsCategory(
    () => operationNamed(PAUSE, { [PAUSE]: noVerification }),
    "operation-definition-invalid",
  );
});

test("the operation SQL and checks are pinned by hash and are exactly the reviewed statements", async () => {
  for (const name of LOGIN_SWITCHES) {
    const op = OPERATIONS[name];
    const sql = await real(op.sql.path);
    const check = await real(op.verification.path);
    assert.equal(sha256(sql), op.sql.sha256, `${name} SQL hash`);
    assert.equal(sha256(check), op.verification.sha256, `${name} check hash`);
    lintVerificationSql(check);
    assert.deepEqual(
      assertOperationScope(sql, op).map((s) =>
        s.split(" ").slice(0, 4).join(" "),
      ),
      op.login
        ? [`alter role ${op.role} login`]
        : [
            `alter role ${op.role} nologin`,
            "select pg_catalog.json_build_object('closed', pg_catalog.count(*) filter",
          ],
    );
    // Each operation's SQL and check name its own role and no other role.
    for (const text of [sql, check]) {
      const named = new Set(
        [...stripComments(text).matchAll(/still_[a-z_]+/g)].map((m) => m[0]),
      );
      assert.deepEqual([...named], [op.role], name);
    }
    // A single changed byte no longer matches the pin.
    assert.notEqual(sha256(`${sql} `), op.sql.sha256);
  }
  const pause = await real(OPERATIONS[PAUSE].sql.path);
  // NOLOGIN is committed before any connection is closed (two statements, no transaction).
  assert.ok(pause.indexOf("nologin;") < pause.indexOf("pg_terminate_backend"));
  assert.doesNotMatch(
    stripComments(pause),
    /\bbegin\b|\bcommit\b|password|grant|revoke/i,
  );
  assert.match(
    await real(OPERATIONS[RESUME].sql.path),
    /^alter role still_settings_writer login;$/m,
  );
  for (const op of Object.values(OPERATIONS))
    assert.doesNotMatch(
      await real(op.verification.path),
      /still_policy|still_entitlement/,
    );
  for (const op of Object.values(OPERATIONS)) {
    assert.equal(sha256(await real(op.sql.path)), op.sql.sha256);
    assert.equal(
      sha256(await real(op.verification.path)),
      op.verification.sha256,
    );
  }
  // The QA pair has the settings pair's exact shape, with only the role (and its prose) changed.
  for (const [settings, qa] of [
    [PAUSE, QA_PAUSE],
    [RESUME, QA_RESUME],
  ])
    for (const key of ["sql", "verification"]) {
      const statements = async (name) =>
        stripComments(await real(OPERATIONS[name][key].path))
          .replace(/\s+/g, " ")
          .trim();
      assert.equal(
        (await statements(qa)).replaceAll(
          QA_SANDBOX_WRITER_ROLE,
          SETTINGS_WRITER_ROLE,
        ),
        await statements(settings),
        `${qa} ${key}`,
      );
    }
});

test("scope: SQL that touches another role, a password, a grant or anything extra is refused", async () => {
  const pause = OPERATIONS[PAUSE];
  const resume = OPERATIONS[RESUME];
  const good = await real(pause.sql.path);
  for (const [sql, op] of [
    ["alter role still_policy_reader nologin;", resume],
    ["alter role still_entitlement_writer login;", resume],
    [
      "alter role still_settings_writer login;\nalter role still_policy_admin nologin;",
      resume,
    ],
    ["alter role still_settings_writer login password 'x';", resume],
    [
      "alter role still_settings_writer login;\ngrant still_policy_admin to still_settings_writer;",
      resume,
    ],
    ["alter role still_settings_writer nologin;", pause], // never closes connections
    [
      good.replace(
        "usename = 'still_settings_writer'",
        "usename = 'still_policy_admin'",
      ),
      pause,
    ],
    [
      good.replace(
        "usename = 'still_settings_writer'",
        "usename <> 'still_settings_writer'",
      ),
      pause,
    ],
    [`${good}\ndelete from public.profiles;`, pause],
    ["alter role still_settings_writer nologin;", resume], // wrong direction
    ["", resume],
    // A QA switch may name only the QA writer, and a settings switch only the settings writer.
    ["alter role still_settings_writer login;", OPERATIONS[QA_RESUME]],
    ["alter role still_qa_sandbox_writer login;", resume],
    [
      good.replaceAll("still_settings_writer", "still_qa_sandbox_writer"),
      pause,
    ],
  ])
    throwsCategory(() => assertOperationScope(sql, op), "operation-scope");
  throwsCategory(
    () => assertOperationScope(good, { ...pause, kind: "unknown" }),
    "operation-scope",
  );
});

// ── Planner ──────────────────────────────────────────────────────────────────────────────────

test("planner refuses unknown operations and any operation combined with migrations or functions", async (t) => {
  const { root, head } = await repo(t);
  for (const name of [
    "drop-everything",
    "migrations",
    "",
    "__proto__",
    "toString",
    "PAUSE-SETTINGS-SYNC",
  ])
    await refuses(plan(root, head, name), "operation-unknown");
  await refuses(
    plan(root, head, PAUSE, { migrations: "0015_settings_sync_per_field.sql" }),
    "operation-with-migrations",
  );
  await refuses(
    plan(root, head, RESUME, { functions: "sync-settings" }),
    "operation-with-migrations",
  );
  await refuses(plan(root, "main", PAUSE), "input-invalid");
  // Through the command, as the workflow calls it.
  const out = {
    text: "",
    write(s) {
      this.text += s;
    },
  };
  await assert.rejects(
    main(
      ["plan"],
      {
        DEPLOY_SHA: head,
        DEPLOY_OPERATION: "pause-everything",
        DEPLOY_MIGRATIONS: "",
      },
      { cwd: root, out },
    ),
    (e) => e.category === "operation-unknown",
  );
  await assert.rejects(
    main(
      ["plan"],
      {
        DEPLOY_SHA: head,
        DEPLOY_OPERATION: PAUSE,
        DEPLOY_MIGRATIONS: "0015_settings_sync_per_field.sql",
      },
      { cwd: root, out },
    ),
    (e) => e.category === "operation-with-migrations",
  );
  assert.equal(out.text, "");
});

test("planner binds commit, pinned SQL, check, tooling and rehearsal migrations into one digest", async (t) => {
  const { root, head } = await repo(t);
  const p = await plan(root, head);
  assert.equal(p.kind, OPERATION_KIND);
  assert.equal(p.operation, PAUSE);
  assert.equal(p.role, SETTINGS_WRITER_ROLE);
  assert.equal(p.login, false);
  assert.equal(p.revision, head);
  assert.equal(p.environment, "supabase-production");
  assert.deepEqual(p.sql, OPERATIONS[PAUSE].sql);
  assert.deepEqual(p.verification, OPERATIONS[PAUSE].verification);
  assert.equal(p.sqlText, await real(OPERATIONS[PAUSE].sql.path));
  assert.deepEqual(p.migrations, []);
  assert.deepEqual(p.functions, []);
  assert.equal(p.operationKind, "role-login");
  assert.deepEqual(p.untouchedRoles, [
    "still_entitlement_writer",
    "still_policy_reader",
    "still_policy_admin",
    "still_qa_sandbox_writer",
  ]);
  assert.deepEqual(
    p.rehearsalMigrations.map((m) => m.file),
    [
      "0001_init.sql",
      "0015_settings_sync_per_field.sql",
      "0016_product_policy.sql",
      "0021_qa_sandbox_access.sql",
    ],
  );
  assert.equal(p.tooling.length, TOOLING_PATHS.length);
  assert.equal((await plan(root, head)).digest, p.digest, "deterministic");
  assert.notEqual((await plan(root, head, RESUME)).digest, p.digest);
  const shown = renderOperationPlan(p);
  for (const needle of [
    p.sql.sha256,
    p.verification.sha256,
    "alter role still_settings_writer nologin;",
    "not a migration",
    "still_policy_reader",
    "still_entitlement_writer",
    "Safe to repeat",
  ])
    assert.ok(shown.includes(needle), needle);
  assert.doesNotMatch(shown, /⚠️/);
  // The command prints the reviewable plan and writes the digest output.
  const out = {
    text: "",
    write(s) {
      this.text += s;
    },
  };
  const output = join(root, ".gh-output");
  assert.equal(
    await main(
      ["plan", "--print"],
      {
        DEPLOY_SHA: head,
        DEPLOY_OPERATION: RESUME,
        DEPLOY_MIGRATIONS: "",
        DEPLOY_FUNCTIONS: "",
        GITHUB_OUTPUT: output,
      },
      { cwd: root, out },
    ),
    0,
  );
  assert.match(out.text, /operation plan: `resume-settings-sync`/);
  assert.match(await readFile(output, "utf8"), /^plan-digest=[0-9a-f]{64}$/m);
});

test("planner refuses unpinned SQL, a missing check, a missing writer role and drift from main", async (t) => {
  {
    const { root, head } = await repo(t);
    // Changed SQL at the commit (and on main): not the reviewed bytes.
    await put(
      root,
      OPERATIONS[PAUSE].sql.path,
      `${await real(OPERATIONS[PAUSE].sql.path)}-- edited\n`,
    );
    git(root, "commit", "-q", "-am", "edit sql");
    await refuses(
      plan(root, git(root, "rev-parse", "HEAD")),
      "operation-sql-unpinned",
    );
    await refuses(
      plan(root, head, PAUSE, { mainRef: "main" }),
      "file-changed-on-main",
    );
  }
  {
    const { root, head } = await repo(t, {
      omit: [OPERATIONS[RESUME].verification.path],
    });
    await refuses(plan(root, head, RESUME), "verification-missing");
  }
  {
    const { root } = await repo(t);
    await put(root, OPERATIONS[RESUME].verification.path, "select '[]';\n");
    git(root, "commit", "-q", "-am", "weaken check");
    await refuses(
      plan(root, git(root, "rev-parse", "HEAD"), RESUME),
      "operation-verification-unpinned",
    );
  }
  {
    const { root } = await repo(t);
    git(
      root,
      "rm",
      "-q",
      "supabase/migrations/0015_settings_sync_per_field.sql",
    );
    git(root, "commit", "-q", "-m", "no writer");
    await refuses(
      plan(root, git(root, "rev-parse", "HEAD")),
      "operation-precondition",
    );
  }
  {
    const { root } = await repo(t);
    git(root, "checkout", "-q", "-b", "feature");
    await put(root, "notes.txt", "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "unmerged");
    await refuses(
      plan(root, git(root, "rev-parse", "HEAD"), PAUSE, { mainRef: "main" }),
      "not-on-main",
    );
  }
  {
    // Even a pinned hash cannot make SQL that touches another role acceptable.
    const { root } = await repo(t);
    const bad = "alter role still_policy_reader login;\n";
    await put(root, OPERATIONS[RESUME].sql.path, bad);
    git(root, "commit", "-q", "-am", "touch another role");
    const registry = {
      [RESUME]: {
        ...OPERATIONS[RESUME],
        sql: { ...OPERATIONS[RESUME].sql, sha256: sha256(bad) },
      },
    };
    await refuses(
      plan(root, git(root, "rev-parse", "HEAD"), RESUME, { registry }),
      "operation-scope",
    );
  }
});

// ── Running an operation against an in-memory database ───────────────────────────────────────

/** Fake psql over roles, open connections and migration history. */
function fakeDb({
  writerRole = SETTINGS_WRITER_ROLE,
  writerLogin = true,
  connections = 2,
  roles = {},
  writerMissing = false,
  onOperation,
  onSleep,
  sqlFailure,
  serverVersion = "170006",
  history = [
    { version: "0001", name: "init" },
    { version: "0015", name: "settings_sync_per_field" },
  ],
} = {}) {
  const state = {
    roles: {
      // The other login-switch role is just another untouched function role here.
      ...(writerRole === SETTINGS_WRITER_ROLE
        ? {}
        : { [SETTINGS_WRITER_ROLE]: { login: true } }),
      ...(writerMissing ? {} : { [writerRole]: { login: writerLogin } }),
      still_entitlement_writer: { login: true },
      still_policy_reader: { login: true },
      still_policy_admin: { login: true },
      postgres: { login: true },
      [HIDDEN_ROLE]: { login: false },
      ...roles,
    },
    connections: writerMissing ? 0 : connections,
    history: structuredClone(history),
    calls: [],
    held: [],
    data: ["public.profiles | 3 rows, md5 abc"],
  };
  const facts = () =>
    Object.entries(state.roles)
      .flatMap(([name, r]) => [
        `role ${name} | login ${r.login}`,
        `role ${name} | superuser false`,
      ])
      .sort();
  const writer = () => state.roles[writerRole];
  const named = (file, key) =>
    LOGIN_SWITCHES.find((name) => file.endsWith(OPERATIONS[name][key].path));
  const closeAll = () => {
    const closed = state.connections;
    state.connections = 0;
    for (const h of state.held.splice(0))
      h.resolve({
        code: 2,
        stdout: "",
        stderr: "FATAL:  terminating connection due to administrator command\n",
      });
    return closed;
  };
  const ok = (stdout) => ({ code: 0, stdout: `${stdout}\n`, stderr: "" });
  const exec = async (cmd, args, opts = {}) => {
    state.calls.push([cmd, args, opts]);
    if (cmd === "git" || cmd === "tar") return defaultExec(cmd, args, opts);
    assert.equal(cmd, "psql");
    assert.ok(
      !args.join(" ").includes(SECRET),
      "secret must never be a psql argument",
    );
    const fileIndex = args.indexOf("-f");
    if (fileIndex >= 0) {
      const file = args[fileIndex + 1];
      const readOnly = args.includes(
        "set session characteristics as transaction read only",
      );
      const operation = named(file, "sql");
      if (operation) {
        assert.equal(OPERATIONS[operation].role, writerRole);
        assert.ok(!readOnly, "the operation itself is not a read-only session");
        assert.ok(args.includes("set lock_timeout = '10s'"));
        assert.ok(
          !args.includes("-1") && !args.includes("--single-transaction"),
          "statements must autocommit in order",
        );
        if (sqlFailure) return { code: 3, stdout: "", stderr: sqlFailure };
        let out = "";
        if (!OPERATIONS[operation].login) {
          writer().login = false;
          out = JSON.stringify({ closed: closeAll(), remaining: 0 });
        } else writer().login = true;
        onOperation?.(state);
        return ok(out);
      }
      assert.ok(readOnly, `${file} must run read-only`);
      if (file.endsWith("server-version.sql")) return ok(serverVersion);
      if (file.endsWith("migration-history.sql"))
        return ok(JSON.stringify(state.history));
      if (file.endsWith("role-facts.sql")) return ok(JSON.stringify(facts()));
      if (file.endsWith("catalog-facts.sql"))
        return ok(JSON.stringify(["grant A", "function f"]));
      if (file.endsWith("rehearsal-data-fingerprint.sql"))
        return ok(JSON.stringify(state.data));
      const checked = named(file, "verification");
      if (checked) assert.equal(OPERATIONS[checked].role, writerRole);
      if (checked && !OPERATIONS[checked].login) {
        if (!writer()) return ok('["writer_role_missing"]');
        return ok(
          JSON.stringify(
            [
              ...(state.connections > 0 ? ["writer_connections_open"] : []),
              ...(writer().login ? ["writer_can_login"] : []),
            ].sort(),
          ),
        );
      }
      if (checked) {
        if (!writer()) return ok('["writer_role_missing"]');
        return ok(writer().login ? "[]" : '["writer_cannot_login"]');
      }
      throw new Error(`unexpected file ${file}`);
    }
    // Rehearsal-only commands (-c).
    const text = args.at(-1);
    if (text === "select current_user") {
      const role = opts.env.PGUSER;
      if (
        state.roles[role]?.login &&
        state.roles[role].password === opts.env.PGPASSWORD
      )
        return ok(role);
      return {
        code: 2,
        stdout: "",
        stderr: `psql: error: connection to server failed: FATAL:  role "${role}" is not permitted to log in\n`,
      };
    }
    if (text.startsWith("select coalesce(pg_catalog.json_agg(rolname")) {
      const wanted = [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      return ok(JSON.stringify(wanted.filter((r) => state.roles[r]).sort()));
    }
    let m = /^alter role ([a-z_]+) login password '([0-9a-f]+)'$/.exec(text);
    if (m) {
      Object.assign(state.roles[m[1]], { login: true, password: m[2] });
      return ok("");
    }
    m = /^alter role ([a-z_]+) nologin$/.exec(text);
    if (m) {
      state.roles[m[1]].login = false;
      return ok("");
    }
    if (
      text.startsWith(
        "select pg_catalog.count(*) from pg_catalog.pg_stat_activity",
      )
    )
      return ok(String(state.connections));
    throw new Error(`unexpected psql command ${text}`);
  };
  const spawnHeld = (cmd, args, opts) => {
    assert.equal(opts.env.PGUSER, writerRole);
    // The held session lifts the role's statement timeout so only the operation can end it.
    assert.deepEqual(args.slice(-4), [
      "-c",
      "set statement_timeout = 0",
      "-c",
      "select pg_catalog.pg_sleep(600)",
    ]);
    let resolve;
    const done = new Promise((r) => {
      resolve = r;
    });
    if (writer()?.login && writer().password === opts.env.PGPASSWORD) {
      state.connections++;
      state.held.push({ resolve });
    } else
      resolve({
        code: 2,
        stdout: "",
        stderr: "FATAL: not permitted to log in",
      });
    return {
      done,
      kill: () => resolve({ code: 137, stdout: "", stderr: "killed" }),
    };
  };
  const sleep = async (ms) => {
    state.calls.push(["sleep", [ms], {}]);
    onSleep?.(state);
  };
  return { state, exec, spawnHeld, sleep };
}

async function opFixture(t, operation = PAUSE) {
  const { root, head } = await repo(t);
  const p = await plan(root, head, operation);
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

const run = (fx, db, extra = {}) =>
  runOperation({
    exec: db.exec,
    plan: fx.p,
    dir: fx.dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: fx.root,
    sleep: db.sleep,
    ...extra,
  });

const sequence = (state) =>
  state.calls
    .filter(([c]) => c === "psql" || c === "sleep")
    .map(([c, a]) =>
      c === "sleep" ? `sleep ${a[0]}` : a.at(-1).split("/").at(-1),
    );

const operationWrites = (state) =>
  state.calls.filter(
    ([c, a]) =>
      c === "psql" &&
      /-(settings-sync|qa-sandbox)\.sql$/.test(a.at(-1)) &&
      !a.at(-1).endsWith(".verify.sql"),
  );

test("pause: login off, open connections closed, verified twice, nothing else changed", async (t) => {
  const fx = await opFixture(t);
  const db = fakeDb();
  const logs = [];
  const receipt = await run(fx, db, { log: (l) => logs.push(l) });
  assert.equal(receipt.status, "verified", JSON.stringify(receipt, null, 2));
  assert.equal(receipt.kind, "operation");
  assert.equal(db.state.roles[SETTINGS_WRITER_ROLE].login, false);
  assert.equal(db.state.connections, 0);
  assert.deepEqual(receipt.connections, { closed: 2, remaining: 0 });
  // Read state, write once, verify immediately, wait the production settle time, verify again,
  // then prove every other role and the migration history unchanged.
  assert.deepEqual(sequence(db.state), [
    "server-version.sql",
    "migration-history.sql",
    "role-facts.sql",
    "pause-settings-sync.verify.sql",
    "pause-settings-sync.sql",
    "pause-settings-sync.verify.sql",
    `sleep ${SETTLE_MS}`,
    "pause-settings-sync.verify.sql",
    "role-facts.sql",
    "migration-history.sql",
  ]);
  assert.equal(SETTLE_MS, 30_000);
  assert.deepEqual(
    receipt.steps.map((s) => [s.name, s.outcome]),
    [
      ["operation files match the pinned plan hashes", "ok"],
      ["PostgreSQL version", "ok"],
      ["migration history read", "ok"],
      ["every role's attributes recorded", "ok"],
      ["state before", "ok"],
      [PAUSE, "ok"],
      ["verify immediately", "ok"],
      ["verify after 30 s (no connection came back)", "ok"],
      [
        "only the writer's login changed (every other role and setting untouched)",
        "ok",
      ],
      ["migration history unchanged", "ok"],
    ],
  );
  const pushed = operationWrites(db.state)[0];
  assert.ok(pushed[1].includes("VERBOSITY=sqlstate"));
  assert.equal(pushed[2].env.PGSSLMODE, "require");
  const text = `${logs.join("\n")}\n${renderOperationReceipt(receipt)}\n${JSON.stringify(receipt)}`;
  for (const leak of [SECRET, REF, HIDDEN_ROLE])
    assert.ok(!text.includes(leak), leak);
  assert.match(
    renderOperationReceipt(receipt),
    /✅ Production operation `pause-settings-sync`: verified/,
  );
});

test("resume: login on, verified, no connection wait, nothing else changed", async (t) => {
  const fx = await opFixture(t, RESUME);
  const db = fakeDb({ writerLogin: false, connections: 0 });
  const receipt = await run(fx, db);
  assert.equal(receipt.status, "verified", JSON.stringify(receipt, null, 2));
  assert.equal(db.state.roles[SETTINGS_WRITER_ROLE].login, true);
  assert.deepEqual(sequence(db.state), [
    "server-version.sql",
    "migration-history.sql",
    "role-facts.sql",
    "resume-settings-sync.verify.sql",
    "resume-settings-sync.sql",
    "resume-settings-sync.verify.sql",
    "role-facts.sql",
    "migration-history.sql",
  ]);
  for (const role of untouchedRoles(OPERATIONS[RESUME]))
    if (db.state.roles[role]) assert.equal(db.state.roles[role].login, true);
});

test("repeating an operation whose end state holds reports it and writes nothing", async (t) => {
  for (const [operation, options, outcome] of [
    [PAUSE, { writerLogin: false, connections: 0 }, "already-paused"],
    [RESUME, { writerLogin: true, connections: 3 }, "already-resumed"],
  ]) {
    const fx = await opFixture(t, operation);
    const db = fakeDb(options);
    const receipt = await run(fx, db);
    assert.deepEqual(
      [receipt.status, receipt.outcome, receipt.writeAttempted],
      ["no-change", outcome, false],
    );
    assert.equal(operationWrites(db.state).length, 0);
    assert.match(
      receipt.steps.at(-1).detail,
      /already (paused|resumed): nothing to do, nothing was changed/,
    );
    assert.match(
      renderOperationReceipt(receipt),
      new RegExp(`${outcome} \\(no change\\)`),
    );
  }
});

test("a pause whose login is already off but whose connections remain closes them and verifies", async (t) => {
  const fx = await opFixture(t);
  const db = fakeDb({ writerLogin: false, connections: 1 });
  const receipt = await run(fx, db, { settleMs: 0 });
  assert.equal(receipt.status, "verified", JSON.stringify(receipt, null, 2));
  assert.equal(operationWrites(db.state).length, 1);
  assert.deepEqual(receipt.connections, { closed: 1, remaining: 0 });
});

test("refuses before any write: missing writer role, tampered files, unpinned plan", async (t) => {
  {
    const fx = await opFixture(t);
    const db = fakeDb({ writerMissing: true });
    const receipt = await run(fx, db);
    assert.deepEqual(
      [receipt.status, receipt.issues, receipt.writeAttempted],
      ["refused", ["writer-role-missing"], false],
    );
    assert.equal(operationWrites(db.state).length, 0);
  }
  {
    const fx = await opFixture(t);
    await writeFile(
      join(fx.dir, OPERATIONS[PAUSE].sql.path),
      "alter role still_policy_admin nologin;\n",
    );
    const db = fakeDb();
    const receipt = await run(fx, db);
    assert.deepEqual(
      [receipt.status, receipt.issues],
      ["refused", ["hash-mismatch"]],
    );
    assert.equal(db.state.calls.length, 0);
  }
  {
    const fx = await opFixture(t);
    const db = fakeDb();
    const forged = {
      ...fx.p,
      sql: {
        ...fx.p.sql,
        sha256: sha256("alter role still_policy_admin nologin;\n"),
      },
    };
    throwsCategory(() => assertPlanPinned(forged), "operation-sql-unpinned");
    const receipt = await run({ ...fx, p: forged }, db);
    assert.deepEqual(
      [receipt.status, receipt.issues],
      ["refused", ["operation-sql-unpinned"]],
    );
    assert.equal(db.state.calls.length, 0);
  }
});

test("an operation that changes any other role fails verification without naming roles publicly", async (t) => {
  const fx = await opFixture(t);
  const db = fakeDb({
    onOperation: (s) => {
      s.roles.still_policy_reader.login = false;
      s.roles[HIDDEN_ROLE].login = true;
    },
  });
  const receipt = await run(fx, db, { settleMs: 0 });
  assert.equal(receipt.status, "verification-failed");
  assert.deepEqual(receipt.issues, ["other-roles-changed"]);
  // The end state was reached; only the side check failed, and the recovery says exactly that.
  assert.equal(receipt.endState, "reached");
  assert.match(
    receipt.recovery,
    /^End state verified: sync IS paused \(still_settings_writer cannot sign in/,
  );
  assert.match(
    receipt.recovery,
    /a separate check failed \(other-roles-changed\)/,
  );
  assert.match(
    receipt.recovery,
    /Do not run pause-settings-sync again to fix that, and do not undo the pause because of it/,
  );
  assert.doesNotMatch(
    receipt.recovery,
    /NOT reached|do not assume sync is paused/i,
  );
  assert.match(
    renderOperationReceipt(receipt),
    /- End state: reached \(verified\)/,
  );
  const step = receipt.steps.find((s) =>
    s.name.startsWith("only the writer's login changed"),
  );
  assert.equal(step.outcome, "failed");
  assert.match(
    step.detail,
    /3 fact\(s\) removed, 3 added; expected 1 and 1 \(facts not printed\)/,
  );
  for (const name of ["still_policy_reader", HIDDEN_ROLE])
    assert.ok(!JSON.stringify(receipt).includes(name), name);
});

test("a connection that survives the pause or comes back during the settle wait fails verification", async (t) => {
  {
    const fx = await opFixture(t);
    const db = fakeDb({ onOperation: (s) => (s.connections = 1) });
    const receipt = await run(fx, db, { settleMs: 0 });
    assert.equal(receipt.status, "verification-failed");
    assert.deepEqual(receipt.issues, [
      "verification-issues:immediately",
      "verification-issues:after 0 s (no connection came back)",
    ]);
    assert.match(
      receipt.steps.find((s) => s.name === "verify immediately").detail,
      /writer_connections_open/,
    );
  }
  {
    const fx = await opFixture(t);
    const db = fakeDb({ onSleep: (s) => (s.connections = 1) });
    const receipt = await run(fx, db);
    assert.equal(receipt.status, "verification-failed");
    assert.deepEqual(receipt.issues, [
      "verification-issues:after 30 s (no connection came back)",
    ]);
    assert.equal(receipt.endState, "not-reached");
    assert.match(
      receipt.recovery,
      /^End state NOT reached: do not assume sync is paused\. Run pause-settings-sync again \(safe to repeat\)/,
    );
    assert.doesNotMatch(receipt.recovery, /Separately|sync IS paused/);
    assert.match(renderOperationReceipt(receipt), /- End state: NOT reached/);
  }
  {
    const fx = await opFixture(t);
    const db = fakeDb({
      onOperation: (s) => s.history.push({ version: "0099", name: "x" }),
    });
    const receipt = await run(fx, db, { settleMs: 0 });
    assert.deepEqual(
      [receipt.status, receipt.issues],
      ["verification-failed", ["migration-history-changed"]],
    );
  }
});

test("a failed operation stops, prints only the SQLSTATE and reads the state back", async (t) => {
  const fx = await opFixture(t);
  const db = fakeDb({
    sqlFailure: `psql:/x/pause-settings-sync.sql:10: ERROR:  42501\nDETAIL: at ${PROD_URL}\n`,
  });
  const logs = [];
  const receipt = await run(fx, db, { log: (l) => logs.push(l) });
  assert.equal(receipt.status, "stopped");
  assert.deepEqual(receipt.issues, ["operation-failed"]);
  assert.equal(
    receipt.steps.find((s) => s.name === PAUSE).detail,
    "sqlstate=42501",
  );
  assert.match(
    receipt.steps.at(-1).detail,
    /open items: writer_can_login, writer_connections_open/,
  );
  assert.match(receipt.recovery, /safe to repeat/);
  const text = `${logs.join("\n")}${JSON.stringify(receipt)}`;
  for (const leak of [SECRET, REF, "DETAIL"])
    assert.ok(!text.includes(leak), leak);
});

test("records that stop early still carry an End state line: stopped, refused, interrupted", async (t) => {
  const isWrite = (args) =>
    /-settings-sync\.sql$/.test(args.at(-1)) &&
    !args.at(-1).endsWith(".verify.sql");
  const failed = {
    applyOutcome: "failure",
    jobStatus: "failure",
  };
  // Stopped, and the read-back still shows open items: the end state was NOT reached.
  {
    const fx = await opFixture(t);
    const db = fakeDb({ sqlFailure: "ERROR:  42501\n" });
    const receipt = await run(fx, db);
    assert.deepEqual(
      [receipt.status, receipt.endState],
      ["stopped", "not-reached"],
    );
    assert.match(renderOperationReceipt(receipt), /- End state: NOT reached/);
    assert.match(
      renderOperationFinal(receipt, failed),
      /- End state: NOT reached/,
    );
  }
  // Stopped, but the read-back is clean or unreadable: never claimed either way.
  for (const readBack of ["clean", "unreadable"]) {
    const fx = await opFixture(t);
    const db = fakeDb({ sqlFailure: "ERROR:  57014\n" });
    let wrote = false;
    const exec = async (cmd, args, opts) => {
      if (cmd === "psql" && isWrite(args)) wrote = true;
      else if (wrote && cmd === "psql") {
        if (readBack === "unreadable")
          return { code: 2, stdout: "", stderr: "connection lost" };
        db.state.roles[SETTINGS_WRITER_ROLE].login = false;
        db.state.connections = 0;
      }
      return db.exec(cmd, args, opts);
    };
    const receipt = await run(fx, { ...db, exec });
    assert.deepEqual(
      [receipt.status, receipt.endState],
      ["stopped", "unknown"],
      readBack,
    );
    assert.match(renderOperationReceipt(receipt), /- End state: UNKNOWN/);
    assert.match(renderOperationFinal(receipt, failed), /- End state: UNKNOWN/);
  }
  // Refused before any write: NOT reached.
  {
    const fx = await opFixture(t);
    const receipt = await run(fx, fakeDb({ writerMissing: true }));
    assert.deepEqual(
      [receipt.status, receipt.endState, receipt.writeAttempted],
      ["refused", "not-reached", false],
    );
    assert.match(renderOperationReceipt(receipt), /- End state: NOT reached/);
    assert.match(
      renderOperationFinal(receipt, failed),
      /- End state: NOT reached/,
    );
  }
  // Interrupted at any point: UNKNOWN. A completed run keeps its verified end state.
  {
    const fx = await opFixture(t);
    const snapshots = [];
    await run(fx, fakeDb(), {
      settleMs: 0,
      onProgress: async (r) => snapshots.push(structuredClone(r)),
    });
    const interrupted = snapshots.filter((r) => r.status === "in-progress");
    assert.ok(interrupted.some((r) => !r.writeAttempted));
    assert.ok(interrupted.some((r) => r.applied));
    for (const r of interrupted)
      assert.match(
        renderOperationFinal(r, {
          applyOutcome: "cancelled",
          jobStatus: "cancelled",
        }),
        /- End state: UNKNOWN/,
      );
    const done = snapshots.at(-1);
    assert.deepEqual([done.status, done.endState], ["verified", "reached"]);
    assert.match(
      renderOperationFinal(done, {
        applyOutcome: "success",
        jobStatus: "success",
      }),
      /- End state: reached \(verified\)/,
    );
  }
});

// ── Rehearsal on the runner's throwaway database ─────────────────────────────────────────────

const replay = (fx, db, extra = {}) =>
  runOperationReplay({
    exec: db.exec,
    spawnHeld: db.spawnHeld,
    plan: fx.p,
    dir: fx.dir,
    conn: parseDbUrl(LOCAL_URL),
    cwd: fx.root,
    sleep: db.sleep,
    settleMs: 0,
    ...extra,
  });

test("pause rehearsal proves the login is refused, the open connection closed, and nothing else changed", async (t) => {
  const fx = await opFixture(t);
  // Starting state as after 0015: the writer exists without a login.
  const db = fakeDb({ writerLogin: false, connections: 0 });
  const result = await replay(fx, db);
  assert.equal(
    result.status,
    "verified",
    JSON.stringify(result.proofs, null, 2),
  );
  assert.deepEqual(
    result.proofs.map((p) => p.name),
    [
      "before: the writer holds an open connection",
      "before: the writer's sign-in is allowed",
      "before: still_entitlement_writer signs in",
      "before: still_policy_reader signs in",
      "before: still_policy_admin signs in",
      "the exact production code path verified the operation",
      "after: the writer's open connection was closed by the operation",
      "after: the writer's sign-in is refused (role is not permitted to log in)",
      "after: the writer holds no connection",
      "after: still_entitlement_writer still signs in (untouched)",
      "after: still_policy_reader still signs in (untouched)",
      "after: still_policy_admin still signs in (untouched)",
      "among every role, only the writer's login changed",
      "grants, functions, policies and migration history unchanged",
      "every row in public, private and migration history unchanged",
      "nothing added to migration history",
      "repeating the operation reports already-paused and writes nothing",
      "the repeat changed nothing at all",
    ],
  );
  assert.deepEqual(result.roleDiff, {
    removed: ["role still_settings_writer | login true"],
    added: ["role still_settings_writer | login false"],
  });
  assert.equal(result.repeat.status, "no-change");
  // The throwaway password never appears in any output.
  const password = db.state.roles[SETTINGS_WRITER_ROLE].password;
  assert.match(password, /^[0-9a-f]{36}$/);
  assert.ok(!JSON.stringify(result).includes(password));
});

test("resume rehearsal proves the login is allowed again and nothing else changed", async (t) => {
  const fx = await opFixture(t, RESUME);
  const db = fakeDb({ writerLogin: false, connections: 0 });
  const result = await replay(fx, db);
  assert.equal(
    result.status,
    "verified",
    JSON.stringify(result.proofs, null, 2),
  );
  assert.ok(
    result.proofs.some(
      (p) => p.name === "before: the writer's sign-in is refused" && p.ok,
    ),
  );
  assert.ok(
    result.proofs.some(
      (p) => p.name === "after: the writer's sign-in is allowed" && p.ok,
    ),
  );
  assert.ok(!result.proofs.some((p) => /open connection/.test(p.name)));
  assert.deepEqual(result.roleDiff, {
    removed: ["role still_settings_writer | login false"],
    added: ["role still_settings_writer | login true"],
  });
});

test("rehearsal negative controls: an ineffective pause, a surviving connection, a touched role or row all fail", async (t) => {
  const failing = async (operation, options, proof) => {
    const fx = await opFixture(t, operation);
    const db = fakeDb({ writerLogin: false, connections: 0, ...options });
    const result = await replay(fx, db);
    assert.equal(result.status, "rehearsal-failed");
    const missed = result.proofs.filter((p) => !p.ok).map((p) => p.name);
    assert.ok(
      missed.includes(proof),
      `${proof} not among ${missed.join(" | ")}`,
    );
  };
  // The SQL "ran" but login still works (e.g. an operation that silently does nothing).
  await failing(
    PAUSE,
    { onOperation: (s) => (s.roles[SETTINGS_WRITER_ROLE].login = true) },
    "after: the writer's sign-in is refused (role is not permitted to log in)",
  );
  // The held connection is never closed.
  await failing(
    PAUSE,
    {
      onOperation: (s) => {
        s.connections = 1;
      },
    },
    "after: the writer holds no connection",
  );
  await failing(
    RESUME,
    { onOperation: (s) => (s.roles.still_policy_admin.login = false) },
    "after: still_policy_admin still signs in (untouched)",
  );
  await failing(
    RESUME,
    { onOperation: (s) => (s.roles.still_policy_admin.login = false) },
    "among every role, only the writer's login changed",
  );
  await failing(
    RESUME,
    { onOperation: (s) => s.data.push("public.profiles | 2 rows") },
    "every row in public, private and migration history unchanged",
  );
  {
    const fx = await opFixture(t);
    const db = fakeDb();
    await assert.rejects(
      runOperationReplay({
        exec: db.exec,
        spawnHeld: db.spawnHeld,
        plan: fx.p,
        dir: fx.dir,
        conn: parseDbUrl(PROD_URL),
        cwd: fx.root,
      }),
      (e) => e.category === "replay-not-local",
    );
    assert.equal(db.state.calls.length, 0);
  }
});

// ── The paid QA lane's emergency stop (same contract, other role) ───────────────────────────

test("pause-qa-sandbox: the QA writer's login off and connections closed; settings sync untouched", async (t) => {
  const fx = await opFixture(t, QA_PAUSE);
  assert.equal(fx.p.role, QA_SANDBOX_WRITER_ROLE);
  assert.deepEqual(fx.p.untouchedRoles, [
    "still_entitlement_writer",
    "still_policy_reader",
    "still_policy_admin",
    "still_settings_writer",
  ]);
  assert.equal(fx.p.recovery, "safe to repeat; to undo, run resume-qa-sandbox");
  const shown = renderOperationPlan(fx.p);
  assert.ok(shown.includes("alter role still_qa_sandbox_writer nologin;"));
  assert.ok(shown.includes("still_settings_writer"));
  const db = fakeDb({ writerRole: QA_SANDBOX_WRITER_ROLE });
  const receipt = await run(fx, db, { settleMs: 0 });
  assert.equal(receipt.status, "verified", JSON.stringify(receipt, null, 2));
  assert.equal(db.state.roles[QA_SANDBOX_WRITER_ROLE].login, false);
  assert.equal(db.state.roles[SETTINGS_WRITER_ROLE].login, true);
  assert.equal(db.state.connections, 0);
  assert.equal(receipt.recovery, "none needed; to undo, run resume-qa-sandbox");
  assert.deepEqual(sequence(db.state).slice(3, 5), [
    "pause-qa-sandbox.verify.sql",
    "pause-qa-sandbox.sql",
  ]);
  // Repeating it is a no-change; resuming it switches the login back on.
  const again = await run(fx, db, { settleMs: 0 });
  assert.deepEqual(
    [again.status, again.outcome, again.writeAttempted],
    ["no-change", "already-paused", false],
  );
  const resumeFx = await opFixture(t, QA_RESUME);
  const resumed = await run(resumeFx, db);
  assert.equal(resumed.status, "verified");
  assert.equal(db.state.roles[QA_SANDBOX_WRITER_ROLE].login, true);
  assert.equal(
    resumed.recovery,
    "none needed; to stop the paid QA lane again, run pause-qa-sandbox",
  );
});

test("a QA pause that also touches the settings writer fails, and recovery names the QA operation", async (t) => {
  const fx = await opFixture(t, QA_PAUSE);
  const db = fakeDb({
    writerRole: QA_SANDBOX_WRITER_ROLE,
    onOperation: (s) => (s.roles[SETTINGS_WRITER_ROLE].login = false),
  });
  const receipt = await run(fx, db, { settleMs: 0 });
  assert.equal(receipt.status, "verification-failed");
  assert.deepEqual(receipt.issues, ["other-roles-changed"]);
  assert.match(
    receipt.recovery,
    /^End state verified: the paid QA lane IS paused \(still_qa_sandbox_writer cannot sign in/,
  );
  assert.match(receipt.recovery, /Do not run pause-qa-sandbox again/);
  assert.doesNotMatch(receipt.recovery, /settings-sync|\bsync\b/);
  // The run that never reached its end state names the QA lane, not sync.
  const missed = await run(
    fx,
    fakeDb({
      writerRole: QA_SANDBOX_WRITER_ROLE,
      onOperation: (s) => (s.roles[QA_SANDBOX_WRITER_ROLE].login = true),
    }),
    { settleMs: 0 },
  );
  assert.match(
    missed.recovery,
    /^End state NOT reached: do not assume the paid QA lane is paused\. Run pause-qa-sandbox again/,
  );
  const closing = renderOperationFinal(
    { ...missed, status: "in-progress", applied: false },
    { applyOutcome: "failure", jobStatus: "cancelled" },
  );
  assert.match(closing, /run pause-qa-sandbox again \(safe to repeat\)/);
  assert.doesNotMatch(closing, /settings-sync/);
});

test("an unexpected starting state is refused before any write", async (t) => {
  const fx = await opFixture(t, QA_RESUME);
  const db = fakeDb({ writerRole: QA_SANDBOX_WRITER_ROLE, writerLogin: false });
  const exec = async (cmd, args, opts) =>
    args.at(-1)?.endsWith("resume-qa-sandbox.verify.sql")
      ? {
          code: 0,
          stdout: '["writer_cannot_login","writer_surprise"]\n',
          stderr: "",
        }
      : db.exec(cmd, args, opts);
  const receipt = await run(fx, { ...db, exec });
  assert.deepEqual(
    [receipt.status, receipt.issues, receipt.writeAttempted, receipt.endState],
    ["refused", ["operation-precondition"], false, "not-reached"],
  );
  assert.match(
    receipt.steps.at(-1).detail,
    /unexpected starting state: writer_surprise/,
  );
  assert.equal(operationWrites(db.state).length, 0);
});

test("QA pause and resume rehearsals prove the effect and leave every other function role signing in", async (t) => {
  for (const [operation, notes] of [
    [
      QA_PAUSE,
      [
        "before: the writer holds an open connection",
        "after: the writer holds no connection",
      ],
    ],
    [QA_RESUME, ["after: the writer's sign-in is allowed"]],
  ]) {
    const fx = await opFixture(t, operation);
    const db = fakeDb({
      writerRole: QA_SANDBOX_WRITER_ROLE,
      writerLogin: false,
      connections: 0,
    });
    const result = await replay(fx, db);
    assert.equal(
      result.status,
      "verified",
      JSON.stringify(result.proofs, null, 2),
    );
    const names = result.proofs.map((p) => p.name);
    for (const note of notes) assert.ok(names.includes(note), note);
    assert.ok(
      names.includes("after: still_settings_writer still signs in (untouched)"),
    );
    assert.deepEqual(result.roleDiff.removed, [
      `role still_qa_sandbox_writer | login ${operation === QA_RESUME ? "false" : "true"}`,
    ]);
  }
});

// ── Commands, closing record and staleness ───────────────────────────────────────────────────

const sink = () => ({
  text: "",
  write(s) {
    this.text += s;
  },
});

test("the apply command runs an operation end to end and prints no secret", async (t) => {
  for (const [options, code, status] of [
    [{}, 0, "verified"],
    [{ writerLogin: false, connections: 0 }, 0, "no-change"],
    [
      { onOperation: (s) => (s.roles.still_policy_reader.login = false) },
      1,
      "verification-failed",
    ],
  ]) {
    const fx = await opFixture(t);
    const planFile = join(fx.root, ".plan.json");
    const summary = join(fx.root, ".summary.md");
    const receiptFile = join(fx.root, ".receipt.json");
    await writeFile(planFile, JSON.stringify(fx.p));
    const out = sink();
    const db = fakeDb(options);
    const result = await main(
      ["apply", "--plan", planFile, "--dir", fx.dir, "--receipt", receiptFile],
      {
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        EXPECTED_PLAN_DIGEST: fx.p.digest,
        SUPABASE_DB_URL: PROD_URL,
        GITHUB_STEP_SUMMARY: summary,
      },
      { exec: db.exec, cwd: fx.root, out, platform: "linux", settleMs: 0 },
    );
    assert.equal(result, code, status);
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    assert.equal(receipt.status, status);
    if (code === 1)
      assert.match(
        out.text,
        /::error title=Production operation verification-failed::/,
      );
    const unmasked = out.text
      .split("\n")
      .filter((l) => !l.startsWith("::add-mask::"))
      .join("\n");
    const written = `${unmasked}\n${await readFile(summary, "utf8")}\n${JSON.stringify(receipt)}`;
    for (const leak of [SECRET, REF, HIDDEN_ROLE])
      assert.ok(!written.includes(leak), leak);
  }
  {
    // A digest that is not the approved one refuses before any database contact.
    const fx = await opFixture(t);
    const planFile = join(fx.root, ".plan.json");
    await writeFile(planFile, JSON.stringify(fx.p));
    const db = fakeDb();
    await assert.rejects(
      main(
        ["apply", "--plan", planFile, "--dir", fx.dir],
        {
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: "refs/heads/main",
          EXPECTED_PLAN_DIGEST: "f".repeat(64),
          SUPABASE_DB_URL: PROD_URL,
        },
        { exec: db.exec, cwd: fx.root, out: sink(), platform: "linux" },
      ),
      (e) => e.category === "plan-differs",
    );
    assert.equal(db.state.calls.length, 0);
  }
});

test("the replay command rehearses an operation plan and fails the job when a proof fails", async (t) => {
  for (const [options, code] of [
    [{}, 0],
    [{ onOperation: (s) => (s.roles[SETTINGS_WRITER_ROLE].login = true) }, 1],
  ]) {
    const fx = await opFixture(t);
    const planFile = join(fx.root, ".plan.json");
    const summary = join(fx.root, ".summary.md");
    await writeFile(planFile, JSON.stringify(fx.p));
    const db = fakeDb({ writerLogin: false, connections: 0, ...options });
    const result = await main(
      ["replay", "--plan", planFile, "--dir", fx.dir],
      {
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        SUPABASE_DB_URL: LOCAL_URL,
        GITHUB_STEP_SUMMARY: summary,
      },
      {
        exec: db.exec,
        spawnHeld: db.spawnHeld,
        cwd: fx.root,
        out: sink(),
        platform: "linux",
        settleMs: 0,
      },
    );
    assert.equal(result, code);
    const shown = await readFile(summary, "utf8");
    assert.match(shown, /What the rehearsal proved/);
    assert.match(
      shown,
      code
        ? /❌ after: the writer's sign-in is refused/
        : /✅ among every role, only the writer's login changed/,
    );
  }
});

test("operation closing record covers every interruption point and holds no secret", async (t) => {
  const fx = await opFixture(t);
  const snapshots = [];
  await run(fx, fakeDb(), {
    settleMs: 0,
    onProgress: async (r) => snapshots.push(structuredClone(r)),
  });
  const cancelled = { applyOutcome: "cancelled", jobStatus: "cancelled" };
  const beforeWrite = snapshots.find(
    (r) => r.steps.at(-1)?.name === "state before",
  );
  assert.match(
    renderOperationFinal(beforeWrite, cancelled),
    /interrupted before any write \(cancelled\)[\s\S]*nothing was written/,
  );
  const during = snapshots.find((r) => r.writeAttempted && !r.applied);
  assert.match(
    renderOperationFinal(during, cancelled),
    /operation started; result unknown \(interrupted: cancelled\)[\s\S]*run pause-settings-sync again \(safe to repeat\)/,
  );
  const ran = snapshots.find((r) => r.steps.at(-1)?.name === PAUSE);
  assert.match(
    renderOperationFinal(ran, {
      applyOutcome: "failure",
      jobStatus: "failure",
    }),
    /operation ran; verification not completed \(interrupted: stopped or timed out\)/,
  );
  const done = snapshots.at(-1);
  assert.equal(done.status, "verified");
  assert.match(
    renderOperationFinal(done, {
      applyOutcome: "success",
      jobStatus: "success",
    }),
    /Outcome: verified/,
  );
  // The always-run command dispatches on the receipt kind and needs no secret.
  const receiptFile = join(fx.root, ".receipt.json");
  await writeFile(receiptFile, JSON.stringify(during));
  const out = sink();
  assert.equal(
    await main(
      ["final-summary", "--receipt", receiptFile],
      { APPLY_OUTCOME: "cancelled", JOB_STATUS: "cancelled" },
      { out },
    ),
    0,
  );
  assert.match(
    out.text,
    /## Operation closing record[\s\S]*Operation: `pause-settings-sync`/,
  );
  for (const leak of [SECRET, REF]) assert.ok(!out.text.includes(leak));
});

test("freshness for an operation: newer migrations on main are fine; a changed operation file refuses", async (t) => {
  {
    const { root, head } = await repo(t);
    const p = await plan(root, head);
    await put(root, "supabase/migrations/0017_later.sql", "select 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "later migration");
    assert.equal(
      (
        await checkFreshness({
          git: makeGit(defaultExec, root),
          plan: p,
          tipRef: "HEAD",
        })
      ).mode,
      "files-identical",
    );
  }
  {
    const { root, head } = await repo(t);
    const p = await plan(root, head);
    await put(root, OPERATIONS[PAUSE].verification.path, "select '[]';\n");
    git(root, "commit", "-q", "-am", "weaken check");
    await refuses(
      checkFreshness({
        git: makeGit(defaultExec, root),
        plan: p,
        tipRef: "HEAD",
      }),
      "main-moved",
    );
  }
  {
    // The rehearsal directory holds every migration at the commit and the exact operation files.
    const { root, head } = await repo(t);
    const p = await plan(root, head);
    const dir = join(root, ".replay");
    await prepareWorkdir({
      exec: defaultExec,
      cwd: root,
      plan: p,
      dir,
      stage: "prior",
    });
    assert.equal(
      await readFile(join(dir, OPERATIONS[PAUSE].sql.path), "utf8"),
      p.sqlText,
    );
    assert.equal(
      await readFile(join(dir, ROLE_FACTS_SQL)).catch(() => null),
      null,
      "tooling SQL is read from the checkout",
    );
    await writeFile(
      join(dir, OPERATIONS[PAUSE].verification.path),
      "select '[]';\n",
    );
    const { verifyWorkdir } = await import("./deploy.mjs");
    await refuses(
      verifyWorkdir({ plan: p, dir, stage: "full" }),
      "hash-mismatch",
    );
  }
});

test("recovery when the end state is missed and another role also changed names both, end state first", async (t) => {
  const fx = await opFixture(t, RESUME);
  const db = fakeDb({
    writerLogin: false,
    connections: 0,
    onOperation: (s) => {
      s.roles[SETTINGS_WRITER_ROLE].login = false;
      s.roles.still_policy_admin.login = false;
    },
  });
  const receipt = await run(fx, db);
  assert.equal(receipt.status, "verification-failed");
  assert.equal(receipt.endState, "not-reached");
  assert.deepEqual(receipt.issues, [
    "verification-issues:immediately",
    "other-roles-changed",
  ]);
  assert.match(
    receipt.recovery,
    /^End state NOT reached: do not assume sync is resumed\. Run resume-settings-sync again[\s\S]* Separately, a side check failed \(other-roles-changed\)/,
  );
  // End state reached on resume, history moved: "sync IS resumed" and do not undo it.
  const fx2 = await opFixture(t, RESUME);
  const moved = await run(
    fx2,
    fakeDb({
      writerLogin: false,
      connections: 0,
      onOperation: (s) => s.history.push({ version: "0099", name: "x" }),
    }),
  );
  assert.equal(moved.endState, "reached");
  assert.match(
    moved.recovery,
    /^End state verified: sync IS resumed[\s\S]*do not undo the resume because of it/,
  );
});

test("an operation refuses before any write on PostgreSQL older than 16 or an unreadable version", async (t) => {
  for (const serverVersion of ["150008", "not-a-number", ""]) {
    const fx = await opFixture(t);
    const db = fakeDb({ serverVersion });
    const receipt = await run(fx, db);
    assert.deepEqual(
      [receipt.status, receipt.issues, receipt.writeAttempted],
      ["refused", ["postgres-version-unsupported"], false],
      serverVersion,
    );
    // The version is the first database read; nothing else ran.
    assert.deepEqual(sequence(db.state), ["server-version.sql"]);
    assert.equal(receipt.steps.at(-1).name, "PostgreSQL version");
    assert.equal(receipt.steps.at(-1).outcome, "refused");
  }
  const fx = await opFixture(t);
  const ok = await run(fx, fakeDb({ serverVersion: "160000" }), {
    settleMs: 0,
  });
  assert.equal(ok.status, "verified");
});

// ── The real command line, as a subprocess (regression: import cycle + top-level await) ───────

const DEPLOY_CLI = new URL("./deploy.mjs", import.meta.url).pathname;
const cli = (args, env, cwd) =>
  spawnSync(process.execPath, [DEPLOY_CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, ...env },
  });

test("the deploy CLI plans both operations as a subprocess: exit 0 and the digest printed", async (t) => {
  const { root, head } = await repo(t);
  for (const operation of [PAUSE, RESUME]) {
    const result = cli(
      ["plan"],
      {
        DEPLOY_SHA: head,
        DEPLOY_OPERATION: operation,
        DEPLOY_MIGRATIONS: "",
        DEPLOY_FUNCTIONS: "",
      },
      root,
    );
    // Exit 13 here means Node found an unsettled top-level await (the import-cycle deadlock).
    assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    const digest = result.stdout.trim();
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, (await plan(root, head, operation)).digest);
  }
  const refused = cli(
    ["plan"],
    { DEPLOY_SHA: head, DEPLOY_OPERATION: "pause-everything" },
    root,
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^Refused \(operation-unknown\): /);
  const mixed = cli(
    ["plan"],
    {
      DEPLOY_SHA: head,
      DEPLOY_OPERATION: PAUSE,
      DEPLOY_MIGRATIONS: "0015_settings_sync_per_field.sql",
    },
    root,
  );
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /^Refused \(operation-with-migrations\): /);
});

test("the deploy CLI writes an operation closing record as a subprocess without any secret", async (t) => {
  const fx = await opFixture(t);
  const snapshots = [];
  await run(fx, fakeDb(), {
    settleMs: 0,
    onProgress: async (r) => snapshots.push(structuredClone(r)),
  });
  const receiptFile = join(fx.root, ".receipt.json");
  const summary = join(fx.root, ".summary.md");
  await writeFile(receiptFile, JSON.stringify(snapshots.at(-1)));
  const result = cli(
    ["final-summary", "--receipt", receiptFile],
    {
      APPLY_OUTCOME: "success",
      JOB_STATUS: "success",
      GITHUB_STEP_SUMMARY: summary,
    },
    fx.root,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /## Operation closing record[\s\S]*Operation: `pause-settings-sync`[\s\S]*Outcome: verified/,
  );
  assert.match(await readFile(summary, "utf8"), /## Operation closing record/);
  for (const leak of [SECRET, REF]) assert.ok(!result.stdout.includes(leak));
});

test("the deploy CLI writes an operation closing record as a subprocess when the operation left no receipt", async (t) => {
  const fx = await opFixture(t);
  const absent = join(fx.root, "absent-receipt.json");
  const context = { APPLY_OUTCOME: "failure", JOB_STATUS: "failure" };
  // An operation run that failed before its first receipt (e.g. a malformed database URL).
  for (const operation of [PAUSE, RESUME]) {
    const summary = join(fx.root, `.summary-${operation}.md`);
    const result = cli(
      ["final-summary", "--receipt", absent],
      {
        ...context,
        DEPLOY_OPERATION: operation,
        GITHUB_STEP_SUMMARY: summary,
      },
      fx.root,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(
        `## Operation closing record[\\s\\S]*Operation: \`${operation}\``,
      ),
    );
    assert.match(result.stdout, /- Write attempted: no/);
    assert.match(result.stdout, /- End state: NOT reached/);
    assert.match(
      result.stdout,
      /no database write was recorded; it is safe to plan and approve again/,
    );
    assert.doesNotMatch(
      result.stdout,
      /migration history|Deploy closing record/i,
    );
    assert.equal(await readFile(summary, "utf8"), result.stdout);
  }
  // No operation (or the migrations mode, or an unknown name): the migration fallback, unchanged.
  const migrationFallback =
    "## Deploy closing record\n\n" +
    "- The apply step did not leave a record (step outcome: failure, job: failure).\n" +
    "- Nothing reached the database unless the step started; treat migration history as UNKNOWN and do not re-run the apply until history is checked privately.\n";
  for (const operation of [undefined, "", "migrations", "pause-everything"]) {
    const result = cli(
      ["final-summary", "--receipt", absent],
      {
        ...context,
        ...(operation === undefined ? {} : { DEPLOY_OPERATION: operation }),
      },
      fx.root,
    );
    assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
    assert.ok(
      result.stdout.startsWith(migrationFallback),
      `${operation}: ${result.stdout}`,
    );
  }
});

test("the deploy CLI shows the End state of a stopped operation in its closing record as a subprocess", async (t) => {
  const fx = await opFixture(t);
  const receipt = await run(fx, fakeDb({ sqlFailure: "ERROR:  42501\n" }));
  const receiptFile = join(fx.root, ".receipt.json");
  await writeFile(receiptFile, JSON.stringify(receipt));
  const result = cli(
    ["final-summary", "--receipt", receiptFile],
    {
      APPLY_OUTCOME: "failure",
      JOB_STATUS: "failure",
      DEPLOY_OPERATION: PAUSE,
    },
    fx.root,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /## Operation closing record[\s\S]*Outcome: stopped[\s\S]*- End state: NOT reached/,
  );
});

// ── The QA sandbox sales switch and test-account operations (one transaction each) ───────────

const ZERO = "0".repeat(64);
const SALT = "5a17".repeat(8);
const secretOf = (emails, salt = SALT) => JSON.stringify({ salt, emails });
const REGISTRY_DIR = new URL(
  "../../../packages/shared-types/",
  import.meta.url,
);

test("workflow choices resolve to exactly the registry, and any other mode or input is refused", () => {
  assert.deepEqual(
    Object.values(WORKFLOW_OPERATIONS)
      .flatMap((modes) => Object.values(modes))
      .sort(),
    Object.keys(OPERATIONS).sort(),
  );
  assert.deepEqual(
    [
      ...new Set(Object.values(WORKFLOW_OPERATIONS).flatMap(Object.keys)),
    ].sort(),
    [...POLICY_MODES].sort(),
  );
  for (const [operation, mode, name] of [
    [PAUSE, "", PAUSE],
    [PAUSE, "none", PAUSE],
    [QA_RESUME, undefined, QA_RESUME],
    ["qa-sandbox-sales-policy", "off", POLICY_OFF],
    ["qa-sandbox-sales-policy", "on", POLICY_ON],
    ["qa-sandbox-subjects", "enable", SUBJECTS_ENABLE],
    ["qa-sandbox-subjects", "disable", SUBJECTS_DISABLE],
  ])
    assert.equal(resolveOperation(operation, mode), name);
  for (const [operation, mode] of [
    ["qa-sandbox-sales-policy", "none"],
    ["qa-sandbox-sales-policy", ""],
    ["qa-sandbox-sales-policy", "enable"],
    ["qa-sandbox-subjects", "off"],
    [PAUSE, "on"],
    [QA_PAUSE, "disable"],
  ])
    throwsCategory(
      () => resolveOperation(operation, mode),
      "operation-input-invalid",
    );
  for (const operation of [
    "qa-sandbox-functions",
    "migrations",
    POLICY_OFF,
    "__proto__",
  ])
    throwsCategory(
      () => resolveOperation(operation, "none"),
      "operation-unknown",
    );
  for (const name of Object.keys(WORKFLOW_OPERATIONS))
    assert.ok(isKnownOperation(name), name);
  for (const name of ["migrations", "qa-sandbox-functions", POLICY_ON, ""])
    assert.ok(!isKnownOperation(name), name);
});

test("the sales bodies, cutoff and builds are pinned identically in JS and SQL, for the sandbox only", async () => {
  for (const [mode, name] of [
    ["off", POLICY_OFF],
    ["on", POLICY_ON],
  ]) {
    const op = OPERATIONS[name];
    const sql = await real(op.sql.path);
    const template = JSON.parse(
      /v_template constant jsonb := '([^']+)';/.exec(sql)[1],
    );
    assert.deepEqual(
      template,
      JSON.parse(JSON.stringify(QA_SANDBOX_SALES_TEMPLATES[mode])),
    );
    assert.equal(template.environment, "sandbox");
    assert.equal(template.salesEnabled, mode === "on");
    assert.deepEqual(template.builds, [...QA_SANDBOX_SALES_BUILDS]);
    assert.ok(
      QA_SANDBOX_SALES_BUILDS.every((b) => b.build === "qa-provisional"),
    );
    assert.ok(op.provisional.includes(PROVISIONAL.builds));
    assert.equal(op.provisional.includes(PROVISIONAL.cutoff), mode === "on");
    // The production environment is never named by the SQL that runs.
    assert.doesNotMatch(stripComments(sql), /production/);
    assert.ok(sql.includes(`'${PROTECTED_OPERATOR_SUBJECT}'`));
    assert.match(
      sql,
      /pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\('still-product-policy:sales:sandbox', 0\)\)/,
    );
    assert.equal(/paid_cutoff/.test(stripComments(sql)), mode === "on");
  }
  // The shared grammar's own vector renders byte-for-byte as private.product_policy_render would.
  const vectors = JSON.parse(
    await readFile(
      new URL("fixtures/product-policy-vectors.json", REGISTRY_DIR),
      "utf8",
    ),
  );
  const body = vectors.cases.find((c) => c.namespace === "sales").response.body;
  const { revision, ...rest } = JSON.parse(body);
  assert.equal(renderSalesBody(rest, revision), body);
  // Decision D2 (owner sign-off pending): one pinned cutoff, the same in JS, SQL and its check.
  const on = await real(OPERATIONS[POLICY_ON].sql.path);
  const check = await real(OPERATIONS[POLICY_ON].verification.path);
  const literal = `array[${QA_SANDBOX_CUTOFF.benefits.map((b) => `'${b}'`).join(", ")}]`;
  for (const text of [on, check]) {
    assert.ok(text.includes(`'${QA_SANDBOX_CUTOFF.product}'`));
    assert.ok(text.includes(literal));
  }
  assert.match(
    stripComments(on),
    /if not exists \(select 1 from private\.paid_cutoff c where c\.environment = 'sandbox'\) then\s+insert into private\.paid_cutoff/,
  );
  assert.notEqual(QA_SANDBOX_CUTOFF.product, "still-pro-v3");
  assert.match(QA_SANDBOX_CUTOFF.product, /^[a-z0-9][a-z0-9._-]{0,95}$/);
  const registry = JSON.parse(
    await readFile(new URL("src/feature-registry.json", REGISTRY_DIR), "utf8"),
  );
  assert.deepEqual(
    [...QA_SANDBOX_CUTOFF.benefits],
    [
      ...registry.features.filter((f) => f.tier === "free").map((f) => f.id),
      registry.tiktokAlias.id,
    ].sort(),
  );
});

test("scope: a one-transaction operation writes only its own tables, sandbox only, with no other command", async () => {
  const off = OPERATIONS[POLICY_OFF];
  const enable = OPERATIONS[SUBJECTS_ENABLE];
  const disable = OPERATIONS[SUBJECTS_DISABLE];
  const policy = await real(off.sql.path);
  const subjects = await real(enable.sql.path);
  const disabling = await real(disable.sql.path);
  for (const name of TRANSACTIONAL)
    assertOperationScope(
      await real(OPERATIONS[name].sql.path),
      OPERATIONS[name],
    );
  const inBody = (sql, statement) =>
    sql.replace(
      "  perform pg_catalog.set_config('still_operation.outcome',",
      `  ${statement}\n  perform pg_catalog.set_config('still_operation.outcome',`,
    );
  for (const [sql, op] of [
    [inBody(policy, "delete from private.product_policy_revisions;"), off],
    [
      inBody(
        policy,
        "update private.product_policy_revisions set body = body;",
      ),
      off,
    ],
    [
      inBody(
        policy,
        "insert into private.paid_cutoff (environment) values ('sandbox');",
      ),
      off,
    ],
    [inBody(policy, "insert into public.profiles (id) values (null);"), off],
    [inBody(policy, "perform 1 from private.access_rights r;"), off],
    [inBody(policy, "execute 'select 1';"), off],
    [inBody(policy, "set role postgres;"), off],
    [inBody(policy, "alter role still_policy_admin login;"), off],
    [inBody(policy, "perform 'still_policy_admin';"), off],
    [inBody(policy, "perform $q$x$q$;"), off],
    [
      policy.replace(
        "values ('sales', 'sandbox', v_expected + 1",
        "values ('sales', 'production', v_expected + 1",
      ),
      off,
    ],
    [
      policy.replace(
        "\\getenv still_operation_policy_body",
        "\\! echo still_operation_policy_body",
      ),
      off,
    ],
    [`\\getenv x HOME\n${policy}`, off],
    [policy.replace("begin;\n", ""), off],
    [`${policy}select 1;\n`, off],
    [policy, enable],
    [inBody(subjects, "delete from private.qa_sandbox_subjects;"), enable],
    [inBody(subjects, "update auth.users set email = email;"), enable],
    [
      inBody(
        subjects,
        "insert into private.access_rights (right_id) values (null);",
      ),
      enable,
    ],
    [disabling.replace("begin;\n", "\\getenv x HOME\nbegin;\n"), disable],
    [
      disabling.replace(
        "for update;",
        "for update; perform 1 from auth.users u;",
      ),
      disable,
    ],
  ])
    throwsCategory(() => assertOperationScope(sql, op), "operation-scope");
});

test("canonicalSubjects: one salted canonical hash bound to the count, per-email hashes only, refusals that never echo input", () => {
  const a = canonicalSubjects(secretOf([" B@Example.org ", "a@example.org"]));
  const b = canonicalSubjects(
    JSON.stringify({ emails: ["a@example.org", "b@example.org"], salt: SALT }),
  );
  assert.equal(a.sha256, b.sha256);
  assert.equal(
    a.sha256,
    sha256(
      JSON.stringify({
        salt: SALT,
        emails: ["a@example.org", "b@example.org"],
      }),
    ),
  );
  // The salt is what keeps the public value from being checked by guessing emails.
  assert.notEqual(
    a.sha256,
    canonicalSubjects(
      JSON.stringify({
        salt: "f".repeat(32),
        emails: ["a@example.org", "b@example.org"],
      }),
    ).sha256,
  );
  assert.equal(a.count, 2);
  assert.equal(a.binding, `2:${a.sha256}`);
  assert.deepEqual(
    a.hashes,
    [sha256("a@example.org"), sha256("b@example.org")].sort(),
  );
  assert.ok(!JSON.stringify(a).includes("example.org"));
  const secret = "secret-person@example.org";
  for (const text of [
    "",
    "not json",
    "{}",
    "[]",
    JSON.stringify([secret]), // the old, unsalted format
    JSON.stringify({ emails: [secret] }), // missing salt
    JSON.stringify({ salt: "ab".repeat(15), emails: [secret] }), // short salt
    JSON.stringify({ salt: "Z".repeat(32), emails: [secret] }), // not lower-case hex
    JSON.stringify({ salt: SALT, emails: [secret], note: "x" }),
    secretOf([]),
    secretOf(Array.from({ length: 51 }, (_, i) => `u${i}@example.org`)),
    secretOf([secret, secret.toUpperCase()]),
    secretOf([secret, 7]),
    secretOf([secret, "no-at-sign"]),
    secretOf([`${secret}\n`, "x@@example.org"]),
  ])
    assert.throws(
      () => canonicalSubjects(text),
      (error) =>
        error instanceof Refusal &&
        error.category === "subjects-list-invalid" &&
        !error.message.includes("secret-person"),
    );
});

test("planner: the sales switch binds the expected revision, the exact body and the cutoff; bad inputs and provisional apply are refused", async (t) => {
  const { root, head } = await repo(t);
  const policy = (extra) => plan(root, head, "qa-sandbox-sales-policy", extra);
  const p = await policy({ policyMode: "on", expectedRevision: "1" });
  assert.equal(p.operation, POLICY_ON);
  assert.equal(p.operationKind, "qa-sales-policy");
  assert.equal(p.workflowOperation, "qa-sandbox-sales-policy");
  assert.deepEqual([p.expectedRevision, p.policyRevision], [1, 2]);
  assert.equal(p.body, renderSalesBody(QA_SANDBOX_SALES_TEMPLATES.on, 2));
  assert.equal(p.bodySha256, sha256(p.body));
  assert.deepEqual(p.cutoff, {
    product: QA_SANDBOX_CUTOFF.product,
    benefits: [...QA_SANDBOX_CUTOFF.benefits],
  });
  assert.deepEqual(p.provisional, [PROVISIONAL.builds, PROVISIONAL.cutoff]);
  assert.ok(!("role" in p) && !("login" in p));
  assert.deepEqual(p.untouchedRoles, [...FUNCTION_ROLES]);
  // The digest survives the JSON round trip the workflow makes, and binds the revision.
  assertSamePlan(JSON.parse(JSON.stringify(p)), p.digest);
  assert.notEqual(
    (await policy({ policyMode: "on", expectedRevision: "2" })).digest,
    p.digest,
  );
  const off = await policy({ policyMode: "off", expectedRevision: "0" });
  assert.equal(off.operation, POLICY_OFF);
  assert.ok(!("cutoff" in off));
  assert.equal(off.body, renderSalesBody(QA_SANDBOX_SALES_TEMPLATES.off, 1));
  for (const expectedRevision of [
    "",
    "-1",
    "01",
    "1.5",
    "x",
    "9007199254740991",
  ])
    await refuses(
      policy({ policyMode: "off", expectedRevision }),
      "operation-input-invalid",
    );
  await refuses(
    policy({ policyMode: "off", expectedRevision: "0", subjectsSha256: ZERO }),
    "operation-input-invalid",
  );
  await refuses(
    policy({ policyMode: "none", expectedRevision: "0" }),
    "operation-input-invalid",
  );
  await refuses(
    policy({ policyMode: "on", expectedRevision: "1", mode: "apply" }),
    "operation-provisional",
  );
  await refuses(
    policy({ policyMode: "off", expectedRevision: "0", mode: "apply" }),
    "operation-provisional",
  );
  for (const extra of [
    { policyMode: "on" },
    { expectedRevision: "0" },
    { subjectsSha256: ZERO },
  ])
    await refuses(plan(root, head, PAUSE, extra), "operation-input-invalid");
  const shown = renderOperationPlan(p);
  for (const needle of [
    p.body,
    p.bodySha256,
    "Provisional content: plan-only",
    PROVISIONAL.cutoff,
    "compare-and-set from `1` to `2`",
    "still-free-v2",
    "one transaction",
  ])
    assert.ok(shown.includes(needle), needle);
});

test("planner: test accounts bind the approved list hash; disable takes no list", async (t) => {
  const { root, head } = await repo(t);
  const subjects = (extra) => plan(root, head, "qa-sandbox-subjects", extra);
  const list = canonicalSubjects(secretOf(["a@example.org"]));
  const p = await subjects({
    policyMode: "enable",
    subjectsSha256: list.binding,
    mode: "apply",
  });
  assert.equal(p.operation, SUBJECTS_ENABLE);
  assert.equal(p.subjectsSha256, list.sha256);
  assert.equal(p.subjectCount, 1);
  assert.deepEqual(p.provisional, undefined);
  assertSamePlan(JSON.parse(JSON.stringify(p)), p.digest);
  const shown = renderOperationPlan(p);
  assert.ok(shown.includes(list.sha256));
  assert.ok(shown.includes("**1 account(s)**"));
  assert.match(shown, /designated QA accounts file/);
  assert.ok(!shown.includes("example.org"));
  for (const subjectsSha256 of [
    "",
    "abc",
    ZERO, // the count is required
    `0:${ZERO}`,
    `51:${ZERO}`,
    `1:${"A".repeat(64)}`,
    `1:${ZERO}0`,
  ])
    await refuses(
      subjects({ policyMode: "enable", subjectsSha256 }),
      "operation-input-invalid",
    );
  await refuses(
    subjects({
      policyMode: "enable",
      subjectsSha256: `1:${ZERO}`,
      expectedRevision: "0",
    }),
    "operation-input-invalid",
  );
  await refuses(
    subjects({ policyMode: "disable", subjectsSha256: `1:${ZERO}` }),
    "operation-input-invalid",
  );
  const d = await subjects({ policyMode: "disable" });
  assert.equal(d.operation, SUBJECTS_DISABLE);
  assert.ok(!("subjectsSha256" in d));
  assert.match(renderOperationPlan(d), /no row is deleted/);
});

/** Fake psql for the one-transaction kinds: the end-state check reads `state`, the SQL changes it. */
function fakeTxDb({ issues, apply, sqlFailure, onOperation } = {}) {
  const state = {
    applied: false,
    calls: [],
    roles: { postgres: { login: true }, still_policy_reader: { login: false } },
  };
  const ok = (stdout) => ({ code: 0, stdout: `${stdout}\n`, stderr: "" });
  const exec = async (cmd, args, opts = {}) => {
    state.calls.push([cmd, args, opts]);
    if (cmd === "git" || cmd === "tar") return defaultExec(cmd, args, opts);
    assert.equal(cmd, "psql");
    const file = args[args.indexOf("-f") + 1];
    const name = TRANSACTIONAL.find((n) =>
      file.endsWith(OPERATIONS[n].sql.path),
    );
    if (name) {
      assert.ok(
        !args.includes("set session characteristics as transaction read only"),
      );
      if (sqlFailure) return { code: 3, stdout: "", stderr: sqlFailure };
      state.applied = true;
      onOperation?.(state, opts.env);
      return ok(`t\n${JSON.stringify(apply(opts.env))}`);
    }
    if (file.endsWith("server-version.sql")) return ok("170006");
    if (file.endsWith("migration-history.sql"))
      return ok(
        JSON.stringify([{ version: "0021", name: "qa_sandbox_access" }]),
      );
    if (file.endsWith("role-facts.sql"))
      return ok(
        JSON.stringify(
          Object.entries(state.roles)
            .map(([r, v]) => `role ${r} | login ${v.login}`)
            .sort(),
        ),
      );
    if (
      TRANSACTIONAL.some((n) => file.endsWith(OPERATIONS[n].verification.path))
    )
      return ok(JSON.stringify(issues(state, opts.env, args)));
    throw new Error(`unexpected file ${file}`);
  };
  return { state, exec, sleep: async () => {} };
}

/** A registry whose sales-policy rows are not provisional (only to exercise the production path). */
const SETTLED = Object.freeze({
  ...OPERATIONS,
  [POLICY_OFF]: { ...OPERATIONS[POLICY_OFF], provisional: [] },
  [POLICY_ON]: { ...OPERATIONS[POLICY_ON], provisional: [] },
});

async function txFixture(t, workflowOperation, extra, registry = OPERATIONS) {
  const { root, head } = await repo(t);
  const p = await plan(root, head, workflowOperation, { ...extra, registry });
  const dir = join(root, ".deploy");
  await prepareWorkdir({
    exec: defaultExec,
    cwd: root,
    plan: p,
    dir,
    stage: "full",
  });
  return { root, p, dir, registry };
}

const runTx = (fx, db, extra = {}) =>
  runOperation({
    exec: db.exec,
    plan: fx.p,
    dir: fx.dir,
    conn: parseDbUrl(PROD_URL),
    target: "production",
    cwd: fx.root,
    sleep: db.sleep,
    registry: fx.registry,
    ...extra,
  });

const policyIssues = (state) =>
  state.applied ? [] : ["sandbox_sales_policy_missing"];

test("sales switch: refused against production while its content is provisional, before any database call", async (t) => {
  const fx = await txFixture(t, "qa-sandbox-sales-policy", {
    policyMode: "off",
    expectedRevision: "0",
  });
  const db = fakeTxDb({ issues: policyIssues, apply: () => ({}) });
  const receipt = await runTx(fx, db);
  assert.deepEqual(
    [receipt.status, receipt.issues, receipt.writeAttempted],
    ["refused", ["operation-provisional"], false],
  );
  assert.equal(db.state.calls.length, 0);
});

test("sales switch: body and revision reach psql only through its environment; verified, then no change", async (t) => {
  const fx = await txFixture(
    t,
    "qa-sandbox-sales-policy",
    { policyMode: "off", expectedRevision: "0" },
    SETTLED,
  );
  const db = fakeTxDb({
    issues: (state, env, args) => {
      assert.equal(env.STILL_OPERATION_POLICY_BODY, fx.p.body);
      assert.ok(
        args.includes(
          "\\getenv still_operation_policy_body STILL_OPERATION_POLICY_BODY",
        ),
      );
      return policyIssues(state);
    },
    apply: (env) => {
      assert.equal(env.STILL_OPERATION_EXPECTED_REVISION, "0");
      assert.equal(env.STILL_OPERATION_POLICY_BODY, fx.p.body);
      return { revision: 1, cutoff: "unchanged" };
    },
  });
  const receipt = await runTx(fx, db);
  assert.equal(receipt.status, "verified", JSON.stringify(receipt, null, 2));
  assert.deepEqual(receipt.result, { revision: 1, cutoff: "unchanged" });
  assert.equal(
    receipt.recovery,
    "none needed; to undo, run qa-sandbox-sales-policy with policy_mode on",
  );
  assert.ok(
    receipt.steps.some(
      (s) =>
        s.detail ===
        "published sandbox sales revision 1; sandbox paid cutoff unchanged",
    ),
  );
  assert.ok(
    receipt.steps.some(
      (s) =>
        s.name === "no role changed (every role and setting untouched)" &&
        s.outcome === "ok",
    ),
  );
  for (const [cmd, args] of db.state.calls)
    if (cmd === "psql")
      assert.ok(!args.join(" ").includes(fx.p.body), "body in argv");
  const again = await runTx(fx, db);
  assert.deepEqual(
    [again.status, again.outcome, again.writeAttempted],
    ["no-change", "already-off", false],
  );
});

test("sales switch: a refusal inside the transaction writes nothing and says why; an unexpected state is refused first", async (t) => {
  const fx = await txFixture(
    t,
    "qa-sandbox-sales-policy",
    { policyMode: "on", expectedRevision: "1" },
    SETTLED,
  );
  for (const [target, stderr] of [
    [
      "production",
      "psql:/x/qa-sandbox-sales-policy-on.sql:70: ERROR:  QP001\n",
    ],
    [
      "local-replay",
      "psql:<stdin>:70: ERROR:  QP001 sandbox sales revision is not the approved expected revision\n",
    ],
  ]) {
    const db = fakeTxDb({
      issues: () => ["sandbox_sales_policy_differs"],
      apply: () => ({}),
      sqlFailure: stderr,
    });
    const receipt = await runTx(fx, db, { target });
    assert.equal(receipt.status, "stopped");
    assert.deepEqual(receipt.issues, [
      "operation-failed",
      "operation-refused:stale-expected-revision",
    ]);
    assert.match(
      receipt.recovery,
      /^Nothing was written: the database refused the change inside its transaction \(stale-expected-revision\)/,
    );
  }
  const db = fakeTxDb({
    issues: () => ["production_cutoff_present", "sandbox_sales_policy_differs"],
    apply: () => ({}),
  });
  const receipt = await runTx(fx, db);
  assert.deepEqual(
    [receipt.status, receipt.issues, receipt.writeAttempted],
    ["refused", ["operation-precondition"], false],
  );
  assert.match(
    receipt.steps.at(-1).detail,
    /unexpected starting state: production_cutoff_present/,
  );
});

test("test accounts: the approved list stays in memory, only per-email hashes reach psql, and a mismatch is refused first", async (t) => {
  const emails = ["qa-one@example.org", "qa-two@example.org"];
  const list = canonicalSubjects(secretOf(emails));
  const fx = await txFixture(t, "qa-sandbox-subjects", {
    policyMode: "enable",
    subjectsSha256: list.binding,
  });
  for (const [subjectEmails, issue] of [
    [secretOf(["qa-one@example.org"]), "subjects-list-mismatch"],
    [secretOf(emails, "c".repeat(32)), "subjects-list-mismatch"], // other salt
    [JSON.stringify(emails), "subjects-list-invalid"], // unsalted
    [undefined, "subjects-list-invalid"],
    ["", "subjects-list-invalid"],
  ]) {
    const db = fakeTxDb({
      issues: () => ["subject_not_enabled"],
      apply: () => ({}),
    });
    const receipt = await runTx(fx, db, { subjectEmails });
    assert.deepEqual([receipt.status, receipt.issues], ["refused", [issue]]);
    assert.equal(db.state.calls.length, 0);
  }
  const logs = [];
  const db = fakeTxDb({
    issues: (state, env) => {
      assert.equal(
        env.STILL_OPERATION_SUBJECT_HASHES,
        JSON.stringify(list.hashes),
      );
      return state.applied ? [] : ["subject_not_enabled"];
    },
    apply: (env) => {
      assert.equal(
        env.STILL_OPERATION_SUBJECT_HASHES,
        JSON.stringify(list.hashes),
      );
      return { listed: 2, admitted: 2, changed: 1, removed: 1 };
    },
  });
  const receipt = await runTx(fx, db, {
    subjectEmails: secretOf([...emails].reverse()),
    log: (l) => logs.push(l),
  });
  assert.equal(receipt.status, "verified", JSON.stringify(receipt, null, 2));
  assert.deepEqual(receipt.result, {
    listed: 2,
    admitted: 2,
    changed: 1,
    removed: 1,
  });
  assert.ok(
    receipt.steps.some((s) =>
      s.detail?.endsWith(
        "1 unlisted membership(s) switched off (none deleted)",
      ),
    ),
  );
  const everything = `${JSON.stringify(db.state.calls.map(([c, a]) => [c, a]))}\n${logs.join("\n")}\n${JSON.stringify(receipt)}\n${renderOperationReceipt(receipt)}`;
  for (const leak of [...emails, ...list.hashes, "example.org", SALT])
    assert.ok(!everything.includes(leak), leak);
  assert.match(
    receipt.recovery,
    /^none needed; to undo, run qa-sandbox-subjects with policy_mode disable\. Switching a membership off stops new paid grants for that account; sandbox rights it was already granted are kept/,
  );
});

test("test accounts: an enabled account dropped from the list is an open item enable closes; a bad list names the fix", async (t) => {
  const list = canonicalSubjects(secretOf(["qa-one@example.org"]));
  const fx = await txFixture(t, "qa-sandbox-subjects", {
    policyMode: "enable",
    subjectsSha256: list.binding,
  });
  // [A, B] admitted earlier, now [B]: the check reports A as unlisted-but-enabled until enable runs.
  const db = fakeTxDb({
    issues: (state) => (state.applied ? [] : ["subjects_unlisted_enabled"]),
    apply: () => ({ listed: 1, admitted: 1, changed: 0, removed: 1 }),
  });
  const receipt = await runTx(fx, db, {
    subjectEmails: secretOf(["qa-one@example.org"]),
  });
  assert.equal(receipt.status, "verified", JSON.stringify(receipt, null, 2));
  assert.equal(receipt.result.removed, 1);
  const refused = await runTx(
    fx,
    fakeTxDb({ issues: () => ["subject_unresolved"], apply: () => ({}) }),
    { subjectEmails: secretOf(["qa-one@example.org"]) },
  );
  assert.deepEqual(refused.issues, ["operation-precondition"]);
  assert.match(refused.recovery, /designated QA accounts file/);
});

test("sales switch: once production has a paid cutoff the switch refuses and points to pause-qa-sandbox", async (t) => {
  const fx = await txFixture(
    t,
    "qa-sandbox-sales-policy",
    { policyMode: "off", expectedRevision: "0" },
    SETTLED,
  );
  const receipt = await runTx(
    fx,
    fakeTxDb({
      issues: () => ["production_cutoff_present"],
      apply: () => ({}),
    }),
  );
  assert.deepEqual(receipt.issues, ["operation-precondition"]);
  assert.match(
    receipt.recovery,
    /production_cutoff_present: once production has a paid cutoff, both sandbox sales switches \(off and on\) refuse by design; to stop QA purchases use pause-qa-sandbox/,
  );
});

test("test accounts: disable needs no list; a role change during the run fails the side check", async (t) => {
  const fx = await txFixture(t, "qa-sandbox-subjects", {
    policyMode: "disable",
  });
  const done = fakeTxDb({
    issues: (state, env) => {
      assert.equal(env.STILL_OPERATION_SUBJECT_HASHES, undefined);
      return state.applied ? [] : ["subjects_enabled"];
    },
    apply: () => ({ disabled: 2, members: 3 }),
  });
  const receipt = await runTx(fx, done);
  assert.equal(receipt.status, "verified");
  assert.ok(
    receipt.steps.some(
      (s) => s.detail === "2 membership(s) switched off; 3 kept (none deleted)",
    ),
  );
  const touched = fakeTxDb({
    issues: (state) => (state.applied ? [] : ["subjects_enabled"]),
    apply: () => ({ disabled: 1, members: 1 }),
    onOperation: (state) => (state.roles.still_policy_reader.login = true),
  });
  const failed = await runTx(fx, touched);
  assert.equal(failed.status, "verification-failed");
  assert.deepEqual(failed.issues, ["other-roles-changed"]);
  assert.match(
    failed.recovery,
    /^End state verified: no QA sandbox membership is enabled \(every row kept\)\. But a separate check failed \(other-roles-changed\)/,
  );
  assert.match(
    renderOperationFinal(
      { ...failed, status: "in-progress", applied: true },
      { applyOutcome: "failure", jobStatus: "cancelled" },
    ),
    /run qa-sandbox-subjects with policy_mode disable again/,
  );
});

test("the deploy CLI plans the QA operations from workflow inputs and keeps their inputs to those operations", async (t) => {
  const { root, head } = await repo(t);
  const base = {
    DEPLOY_SHA: head,
    DEPLOY_MIGRATIONS: "",
    DEPLOY_FUNCTIONS: "",
  };
  const out = sink();
  const planFile = join(root, ".plan.json");
  assert.equal(
    await main(
      ["plan", "--out", planFile],
      {
        ...base,
        DEPLOY_OPERATION: "qa-sandbox-sales-policy",
        DEPLOY_POLICY_MODE: "off",
        DEPLOY_POLICY_EXPECTED_REVISION: "0",
      },
      { cwd: root, out },
    ),
    0,
  );
  assert.equal(
    JSON.parse(await readFile(planFile, "utf8")).operation,
    POLICY_OFF,
  );
  for (const [env, category] of [
    [
      {
        DEPLOY_OPERATION: "qa-sandbox-sales-policy",
        DEPLOY_POLICY_MODE: "on",
        DEPLOY_POLICY_EXPECTED_REVISION: "1",
        DEPLOY_MODE: "apply",
      },
      "operation-provisional",
    ],
    [
      { DEPLOY_OPERATION: "migrations", DEPLOY_POLICY_MODE: "off" },
      "operation-input-invalid",
    ],
    [
      {
        DEPLOY_OPERATION: "qa-sandbox-functions",
        DEPLOY_SUBJECTS_SHA256: ZERO,
      },
      "operation-input-invalid",
    ],
    [
      { DEPLOY_OPERATION: "", DEPLOY_POLICY_EXPECTED_REVISION: "0" },
      "operation-input-invalid",
    ],
    [
      { DEPLOY_OPERATION: "qa-sandbox-subjects", DEPLOY_POLICY_MODE: "enable" },
      "operation-input-invalid",
    ],
  ])
    await assert.rejects(
      main(["plan"], { ...base, ...env }, { cwd: root, out: sink() }),
      (e) => e.category === category,
    );
  // A closing record with no receipt is still an operation record for the QA operations.
  const closing = sink();
  await main(
    ["final-summary", "--receipt", join(root, "missing.json")],
    {
      DEPLOY_OPERATION: "qa-sandbox-subjects",
      APPLY_OUTCOME: "failure",
      JOB_STATUS: "failure",
    },
    { cwd: root, out: closing },
  );
  assert.match(
    closing.text,
    /## Operation closing record[\s\S]*Operation: `qa-sandbox-subjects`/,
  );
});

test("the subjects-digest helper prints only the approved hash and count", async () => {
  const out = sink();
  const emails = ["qa-one@example.org", "QA-Two@example.org"];
  assert.equal(
    await main(
      ["subjects-digest"],
      {},
      {
        out,
        stdin: [Buffer.from(secretOf(emails))],
      },
    ),
    0,
  );
  assert.equal(
    out.text,
    `subjects_sha256=${canonicalSubjects(secretOf(emails)).binding} accounts=2\n`,
  );
  assert.ok(!out.text.includes("example.org") && !out.text.includes(SALT));
  for (const input of ["[]", JSON.stringify(emails)])
    await assert.rejects(
      main(
        ["subjects-digest"],
        {},
        { out: sink(), stdin: [Buffer.from(input)] },
      ),
      (e) => e.category === "subjects-list-invalid",
    );
});

test("the apply command hands the list secret only to the run and prints none of it", async (t) => {
  const emails = ["qa-one@example.org"];
  const list = canonicalSubjects(secretOf(emails));
  const fx = await txFixture(t, "qa-sandbox-subjects", {
    policyMode: "enable",
    subjectsSha256: list.binding,
  });
  const planFile = join(fx.root, ".plan.json");
  await writeFile(planFile, JSON.stringify(fx.p));
  const db = fakeTxDb({
    issues: (state) => (state.applied ? [] : ["subject_not_enabled"]),
    apply: () => ({ listed: 1, admitted: 1, changed: 1, removed: 0 }),
  });
  const out = sink();
  const code = await main(
    ["apply", "--plan", planFile, "--dir", fx.dir],
    {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      EXPECTED_PLAN_DIGEST: fx.p.digest,
      SUPABASE_DB_URL: PROD_URL,
      QA_SANDBOX_SUBJECT_EMAILS_JSON: secretOf(emails),
    },
    { exec: db.exec, cwd: fx.root, out, platform: "linux" },
  );
  assert.equal(code, 0, out.text);
  const unmasked = out.text
    .split("\n")
    .filter((l) => !l.startsWith("::add-mask::"))
    .join("\n");
  for (const leak of [...emails, ...list.hashes, SECRET, SALT])
    assert.ok(!unmasked.includes(leak), leak);
});
