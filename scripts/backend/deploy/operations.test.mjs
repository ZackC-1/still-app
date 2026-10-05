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
  SETTINGS_WRITER_ROLE,
  UNTOUCHED_FUNCTION_ROLES,
  assertOperationDefinition,
  assertOperationScope,
  assertPlanPinned,
  createOperationPlan,
  operationNamed,
  renderOperationFinal,
  renderOperationPlan,
  renderOperationReceipt,
  runOperation,
  runOperationReplay,
} from "./operations.mjs";

const SECRET = "synthetic-password-sentinel-7d1e";
const REF = "zyxwvutsrqponmlkjihg";
const PROD_URL = `postgresql://postgres.${REF}:${SECRET}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REPO = new URL("../../../", import.meta.url);
const PAUSE = "pause-settings-sync";
const RESUME = "resume-settings-sync";
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

test("exactly two operations exist, and each meets the operation contract", () => {
  assert.deepEqual(Object.keys(OPERATIONS), [PAUSE, RESUME]);
  for (const [name, op] of Object.entries(OPERATIONS))
    assertOperationDefinition(name, op);
  assert.equal(OPERATIONS[PAUSE].login, false);
  assert.equal(OPERATIONS[PAUSE].closesConnections, true);
  assert.equal(OPERATIONS[RESUME].login, true);
  assert.equal(OPERATIONS[RESUME].closesConnections, false);
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
    { ...OPERATIONS[PAUSE], closesConnections: false },
    { ...OPERATIONS[PAUSE], noChange: undefined },
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
  for (const [name, op] of Object.entries(OPERATIONS)) {
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
        ? ["alter role still_settings_writer login"]
        : [
            "alter role still_settings_writer nologin",
            "select pg_catalog.json_build_object('closed', pg_catalog.count(*) filter",
          ],
    );
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
  ])
    throwsCategory(() => assertOperationScope(sql, op), "operation-scope");
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
  assert.deepEqual(p.untouchedRoles, [...UNTOUCHED_FUNCTION_ROLES]);
  assert.deepEqual(
    p.rehearsalMigrations.map((m) => m.file),
    ["0001_init.sql", "0015_settings_sync_per_field.sql"],
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
      ...(writerMissing
        ? {}
        : { [SETTINGS_WRITER_ROLE]: { login: writerLogin } }),
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
  const writer = () => state.roles[SETTINGS_WRITER_ROLE];
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
      if (
        file.endsWith(OPERATIONS[PAUSE].sql.path) ||
        file.endsWith(OPERATIONS[RESUME].sql.path)
      ) {
        assert.ok(!readOnly, "the operation itself is not a read-only session");
        assert.ok(args.includes("set lock_timeout = '10s'"));
        assert.ok(
          !args.includes("-1") && !args.includes("--single-transaction"),
          "statements must autocommit in order",
        );
        if (sqlFailure) return { code: 3, stdout: "", stderr: sqlFailure };
        let out = "";
        if (file.endsWith(OPERATIONS[PAUSE].sql.path)) {
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
      if (file.endsWith(OPERATIONS[PAUSE].verification.path)) {
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
      if (file.endsWith(OPERATIONS[RESUME].verification.path)) {
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
    assert.equal(opts.env.PGUSER, SETTINGS_WRITER_ROLE);
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
      /-settings-sync\.sql$/.test(a.at(-1)) &&
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
  for (const role of UNTOUCHED_FUNCTION_ROLES)
    assert.equal(db.state.roles[role].login, true);
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
