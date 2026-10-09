// Owner-approved operations for the protected production deploy (alongside numbered migrations).
//
// pause-settings-sync  switches still_settings_writer to NOLOGIN, then closes that role's open
//                      connections. The sync-settings function reaches the database only as that
//                      role, so new sync stops; apps keep settings on the device and retry.
// resume-settings-sync switches still_settings_writer back to LOGIN (password untouched).
// pause-qa-sandbox     the same emergency stop for still_qa_sandbox_writer: every paid qa-sandbox-*
//                      function answers "unavailable" at once. Free sync and live customers are
//                      untouched.
// resume-qa-sandbox    switches still_qa_sandbox_writer back to LOGIN (password untouched).
//
// Each runs through the same protected workflow as a migration: manual dispatch from main, a plan
// (no secrets) that binds the exact SQL by hash and rehearses it on a throwaway database, owner
// approval in the `supabase-production` environment, re-derivation of the same plan digest, then
// the SQL, read-only verification and an always-run closing record with no secrets.
//
// Every operation has a `kind` (see KINDS below) that fixes its allowed statement shapes, its
// definition contract, the end state its check proves and its recovery text. A new kind (for
// example the credentials operation planned for the QA secrets) plugs in by adding one KINDS entry
// and its registry rows; the planner, runner, rehearsal and closing record dispatch on the kind.
//
// Guarantees enforced here (each has a test and a negative control in operations.test.mjs):
// - only the operations in OPERATIONS exist; an operation never runs together with migrations;
// - the SQL bytes must equal the hash pinned below, and every statement must be one of the exact
//   allowed shapes of the operation's kind (a login switch names only its own target role);
// - a post-apply read-only check proves the end state (login off and no connections, or login
//   on), and a before/after comparison of every role's attributes proves that nothing but the
//   operation's own change happened (every other function role keeps its own login);
// - repeating an operation whose end state already holds reports that ("already paused", ...)
//   and writes nothing.
//
// Not a migration: nothing is added to migration history, and the history must be unchanged.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  CLI_TARBALL_SHA256,
  CLI_VERSION,
  CONFIG_PATH,
  ENVIRONMENT_NAME,
  MIGRATIONS_DIR,
  OPERATIONS_DIR,
  OPERATION_KIND,
  Refusal,
  TOOLING_PATHS,
  canonical,
  diffFacts,
  failureFacts,
  isLoopback,
  lintVerificationSql,
  migrationsAt,
  parseHistory,
  parseJsonArray,
  pgEnv,
  publicError,
  redact,
  runReadOnlySql,
  sha256,
  showsRawOutput,
  stripComments,
  verifyWorkdir,
} from "./deploy.mjs";

export const SETTINGS_WRITER_ROLE = "still_settings_writer";
export const QA_SANDBOX_WRITER_ROLE = "still_qa_sandbox_writer";
/** Every role an Edge Function signs in as. An operation leaves all of them untouched except its own target. */
export const FUNCTION_ROLES = Object.freeze([
  "still_entitlement_writer", // purchase webhook
  "still_policy_reader", // sales and rating switches (read)
  "still_policy_admin", // sales and rating switches (owner admin)
  SETTINGS_WRITER_ROLE, // free settings sync
  QA_SANDBOX_WRITER_ROLE, // fixed sandbox QA functions
]);
/** The only roles a login switch may target (each has a pause and a resume operation). */
export const LOGIN_SWITCH_ROLES = Object.freeze([
  SETTINGS_WRITER_ROLE,
  QA_SANDBOX_WRITER_ROLE,
]);
/** The function roles an operation must leave untouched: all of them except its own target. */
export const untouchedRoles = (op) =>
  FUNCTION_ROLES.filter((role) => role !== op.role);
export const ROLE_FACTS_SQL = "scripts/backend/deploy/sql/role-facts.sql";
export const DATA_FINGERPRINT_SQL =
  "scripts/backend/deploy/sql/rehearsal-data-fingerprint.sql";
const HISTORY_SQL = "scripts/backend/deploy/sql/migration-history.sql";
export const SERVER_VERSION_SQL =
  "scripts/backend/deploy/sql/server-version.sql";
/** PostgreSQL 16: the first version whose pg_auth_members has inherit_option and set_option. */
export const MIN_SERVER_VERSION_NUM = 160000;
const FACTS_SQL = "scripts/backend/deploy/sql/catalog-facts.sql";
/** Production waits this long after a pause before checking again that no connection came back. */
export const SETTLE_MS = 30_000;

/** The one statement shape that closes the writer's open connections (normalized form). */
export const terminateStatement = (role) =>
  "select pg_catalog.json_build_object('closed', pg_catalog.count(*) filter (where t.closed), " +
  "'remaining', pg_catalog.count(*) filter (where not t.closed))::text from (select " +
  "pg_catalog.pg_terminate_backend(a.pid, 5000) as closed from pg_catalog.pg_stat_activity a " +
  `where a.usename = '${role}' and a.pid <> pg_catalog.pg_backend_pid()) t`;

/** Kind of an operation that switches one function role's login off (closing its connections) or on. */
export const ROLE_LOGIN = "role-login";

const loginSwitch = ({
  role,
  login,
  requiresMigration,
  sql,
  verification,
  lane,
  counterpart,
  lastResort,
}) =>
  Object.freeze({
    kind: ROLE_LOGIN,
    role,
    login,
    closesConnections: !login,
    requiresMigration,
    sql: Object.freeze(sql),
    verification: Object.freeze(verification),
    noChange: login ? "already-resumed" : "already-paused",
    effect: login
      ? `${role} can sign in again (rolcanlogin true) with its existing password`
      : `${role} cannot sign in (rolcanlogin false) and holds no database connection`,
    lane,
    counterpart,
    lastResort,
  });

/**
 * The complete list of operations. Changing an operation's SQL or check means changing its pinned
 * hash here too, in the same reviewed commit; the planner refuses any other bytes.
 */
export const OPERATIONS = Object.freeze({
  "pause-settings-sync": loginSwitch({
    role: SETTINGS_WRITER_ROLE,
    login: false,
    requiresMigration: "0015_settings_sync_per_field.sql",
    sql: {
      path: `${OPERATIONS_DIR}/pause-settings-sync.sql`,
      sha256:
        "eaa46c0fa7155a783c4c7858e00a68a1f8fdd4c6c1a4125c7c82874f63e59726",
    },
    verification: {
      path: `${OPERATIONS_DIR}/pause-settings-sync.verify.sql`,
      sha256:
        "6a5017a37c6b9579f818eed913aba6fd739ed59931334b1f12354996cd75dc82",
    },
    lane: "sync",
    counterpart: "resume-settings-sync",
    lastResort: "the dashboard SQL in the pause runbook",
  }),
  "resume-settings-sync": loginSwitch({
    role: SETTINGS_WRITER_ROLE,
    login: true,
    requiresMigration: "0015_settings_sync_per_field.sql",
    sql: {
      path: `${OPERATIONS_DIR}/resume-settings-sync.sql`,
      sha256:
        "41f106901fc6e6756ae8f6e180f23b18510ba95ebf4a981f6a434751aa0c9b32",
    },
    verification: {
      path: `${OPERATIONS_DIR}/resume-settings-sync.verify.sql`,
      sha256:
        "e08beb82225105f952108d313ce1b1e0ca5def8257472c29ec061d6a1a350471",
    },
    lane: "sync",
    counterpart: "pause-settings-sync",
    lastResort: "the dashboard SQL in the pause runbook",
  }),
  "pause-qa-sandbox": loginSwitch({
    role: QA_SANDBOX_WRITER_ROLE,
    login: false,
    requiresMigration: "0021_qa_sandbox_access.sql",
    sql: {
      path: `${OPERATIONS_DIR}/pause-qa-sandbox.sql`,
      sha256:
        "7cfd2f4a34cc61091863d5c5ad2e0b2a3f64df045607b5e0c36048b003ea2d0c",
    },
    verification: {
      path: `${OPERATIONS_DIR}/pause-qa-sandbox.verify.sql`,
      sha256:
        "eb1c3af164e7761a6031edfc7d235b9bacf057ed430d6e75e1b1f84a2bf70634",
    },
    lane: "the paid QA lane",
    counterpart: "resume-qa-sandbox",
    lastResort:
      "delete the STILL_QA_SANDBOX_ENTITLEMENT_WRITER_DB_URL function secret in the Supabase dashboard",
  }),
  "resume-qa-sandbox": loginSwitch({
    role: QA_SANDBOX_WRITER_ROLE,
    login: true,
    requiresMigration: "0021_qa_sandbox_access.sql",
    sql: {
      path: `${OPERATIONS_DIR}/resume-qa-sandbox.sql`,
      sha256:
        "53a00df77e687651a8a4ff14e8573454e59915254d616d6fa7bfc845bcc5985e",
    },
    verification: {
      path: `${OPERATIONS_DIR}/resume-qa-sandbox.verify.sql`,
      sha256:
        "dfc0b0eb412dcf46e0e01706755b7fbadccfe44b0557a41439f103dd5958cdfc",
    },
    lane: "the paid QA lane",
    counterpart: "pause-qa-sandbox",
    lastResort:
      "alter role still_qa_sandbox_writer login in the Supabase SQL editor",
  }),
});

/** Workflow value for an ordinary numbered-migration deploy. */
export const MIGRATIONS_MODE = "migrations";

/**
 * Per-kind contracts. `definition` checks the registry row; `scope` checks the SQL text against the
 * kind's allowed statement shapes; `closes` lists the end-state check's issue codes the operation
 * may close (any other code before the write is a refusal); `expectedRoleDiff` is the only change
 * to role facts the operation may cause.
 */
export const KINDS = Object.freeze({
  [ROLE_LOGIN]: Object.freeze({
    definition(op, bad) {
      if (!LOGIN_SWITCH_ROLES.includes(op.role))
        bad("a login switch may only touch the settings or QA sandbox writer");
      if (typeof op.login !== "boolean") bad("missing end-state login value");
      if (op.closesConnections !== !op.login)
        bad("a pause must close connections and a resume must not");
      if (op.noChange !== (op.login ? "already-resumed" : "already-paused"))
        bad("missing no-change outcome");
    },
    scope: (sql, op) => assertLoginScope(sql, op),
    closes: (op) =>
      op.login
        ? ["writer_cannot_login"]
        : ["writer_can_login", "writer_connections_open"],
    expectedRoleDiff(op, factsBefore) {
      const from = `role ${op.role} | login ${!op.login}`;
      const to = `role ${op.role} | login ${op.login}`;
      return factsBefore.includes(from)
        ? { removed: [from], added: [to] }
        : { removed: [], added: [] };
    },
  }),
});

/** Structural contract every operation definition must meet (tested against OPERATIONS). */
export function assertOperationDefinition(name, op) {
  const hex = /^[0-9a-f]{64}$/;
  const bad = (why) => {
    throw new Refusal("operation-definition-invalid", `${name}: ${why}`);
  };
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(name) || name === MIGRATIONS_MODE)
    bad("bad operation name");
  if (!op || typeof op !== "object") bad("missing definition");
  if (typeof op.kind !== "string" || !Object.hasOwn(KINDS, op.kind))
    bad("unknown operation kind");
  for (const key of ["sql", "verification"]) {
    if (!op[key] || !hex.test(op[key].sha256 ?? ""))
      bad(`missing pinned ${key} hash`);
    if (
      op[key].path !==
      `${OPERATIONS_DIR}/${name}${key === "sql" ? "" : ".verify"}.sql`
    )
      bad(`unexpected ${key} path`);
  }
  if (!/^[0-9]{4,14}_[a-z0-9_]+\.sql$/.test(op.requiresMigration ?? ""))
    bad("missing required migration");
  for (const key of ["effect", "lane", "counterpart", "lastResort"])
    if (typeof op[key] !== "string" || op[key] === "")
      bad(`missing ${key} text`);
  KINDS[op.kind].definition(op, bad);
  return true;
}

export function operationNamed(name, registry = OPERATIONS) {
  if (typeof name !== "string" || !Object.hasOwn(registry, name)) {
    throw new Refusal(
      "operation-unknown",
      `Unknown operation; use one of: ${Object.keys(registry).join(", ")}`,
    );
  }
  const op = registry[name];
  assertOperationDefinition(name, op);
  return op;
}

/** The SQL must be one of its kind's allowed shapes. Defense in depth: the pinned hash is the primary guard. */
export function assertOperationScope(sql, op) {
  if (!op || !Object.hasOwn(KINDS, op.kind ?? ""))
    throw new Refusal("operation-scope", "Unknown operation kind");
  return KINDS[op.kind].scope(sql, op);
}

/**
 * Login switch: every statement must be one of the exact allowed shapes, name only the
 * operation's role, and appear in the operation's exact order.
 */
function assertLoginScope(sql, op) {
  const statements = stripComments(sql)
    .split(";")
    .map((s) =>
      s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim(),
    )
    .filter(Boolean);
  for (const statement of statements) {
    const alter = /^alter role ([a-z_][a-z0-9_]*) (nologin|login)$/.exec(
      statement,
    );
    if (alter && alter[1] !== op.role)
      throw new Refusal(
        "operation-scope",
        `The operation touches role ${alter[1]}; only ${op.role} may change`,
      );
    for (const literal of statement.matchAll(/'([^']*)'/g)) {
      if (literal[1].startsWith("still_") && literal[1] !== op.role)
        throw new Refusal(
          "operation-scope",
          `The operation names role ${literal[1]}; only ${op.role} may change`,
        );
    }
  }
  const expected = [
    `alter role ${op.role} ${op.login ? "login" : "nologin"}`,
    ...(op.closesConnections ? [terminateStatement(op.role)] : []),
  ];
  if (canonical(statements) !== canonical(expected)) {
    throw new Refusal(
      "operation-scope",
      "The operation SQL is not exactly the reviewed statements (no other role, grant, password, data or setting may change)",
    );
  }
  return statements;
}

// ── Plan ───────────────────────────────────────────────────────────────────────────────────────

const isBlank = (text) => String(text ?? "").trim() === "";

export async function createOperationPlan({
  git,
  sha,
  operation,
  migrations = "",
  functions = "",
  mainRef = "HEAD",
  registry = OPERATIONS,
}) {
  const op = operationNamed(operation, registry);
  if (!isBlank(migrations) || !isBlank(functions)) {
    throw new Refusal(
      "operation-with-migrations",
      "An operation runs alone: leave the migration and function lists empty, and deploy migrations in their own run",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(String(sha ?? ""))) {
    throw new Refusal(
      "input-invalid",
      "Commit must be a full 40-character lowercase SHA",
    );
  }
  const mainCommit = await git.commit(mainRef);
  if ((await git.commit(sha)) !== sha)
    throw new Refusal("commit-unknown", "Commit not found");
  if (!(await git.isAncestor(sha, mainCommit))) {
    throw new Refusal(
      "not-on-main",
      "The commit is not on main; only merged, reviewed commits can run an operation",
    );
  }
  const bound = async (path, category) => {
    const bytes = await git.blob(sha, path);
    const onMain = await git.blob(mainCommit, path);
    if (!bytes) throw new Refusal(category, `${path} missing at that commit`);
    if (!onMain || sha256(bytes) !== sha256(onMain)) {
      throw new Refusal(
        "file-changed-on-main",
        `${path} differs between the commit and main`,
      );
    }
    return { path, sha256: sha256(bytes), text: bytes.toString("utf8") };
  };
  const sql = await bound(op.sql.path, "operation-sql-missing");
  if (sql.sha256 !== op.sql.sha256)
    throw new Refusal(
      "operation-sql-unpinned",
      `${op.sql.path} is not the reviewed SQL (its hash differs from the one pinned in operations.mjs)`,
    );
  assertOperationScope(sql.text, op);
  const verification = await bound(
    op.verification.path,
    "verification-missing",
  );
  if (verification.sha256 !== op.verification.sha256)
    throw new Refusal(
      "operation-verification-unpinned",
      `${op.verification.path} is not the reviewed check (its hash differs from the one pinned in operations.mjs)`,
    );
  lintVerificationSql(verification.text);
  const config = await bound(CONFIG_PATH, "config-missing");

  // The rehearsal database is built from every migration at the commit; the role must exist there.
  const atSha = await migrationsAt(git, sha);
  if (!atSha.some((m) => m.file === op.requiresMigration)) {
    throw new Refusal(
      "operation-precondition",
      `${op.requiresMigration} (which creates ${op.role}) is not at that commit`,
    );
  }
  const rehearsalMigrations = [];
  for (const m of atSha) {
    const bytes = await git.blob(sha, `${MIGRATIONS_DIR}/${m.file}`);
    rehearsalMigrations.push({ ...m, sha256: sha256(bytes) });
  }

  const tooling = [];
  for (const path of TOOLING_PATHS) {
    const bytes = await git.blob(mainCommit, path);
    if (!bytes) throw new Refusal("tooling-missing", `${path} missing on main`);
    tooling.push({ path, sha256: sha256(bytes) });
  }

  const manifest = {
    protocol: 1,
    kind: OPERATION_KIND,
    operation,
    operationKind: op.kind,
    role: op.role,
    login: op.login,
    closesConnections: op.closesConnections,
    environment: ENVIRONMENT_NAME,
    revision: sha,
    workflowRevision: mainCommit,
    onFirstParent: await git.onFirstParent(sha, mainCommit),
    cli: { version: CLI_VERSION, tarballSha256: CLI_TARBALL_SHA256 },
    config: { path: config.path, sha256: config.sha256 },
    sql: { path: sql.path, sha256: sql.sha256 },
    sqlText: sql.text,
    verification: { path: verification.path, sha256: verification.sha256 },
    untouchedRoles: untouchedRoles(op),
    rehearsalMigrations,
    functions: [],
    migrations: [],
    tooling,
    effect: op.effect,
    recovery: op.login
      ? `safe to repeat; to stop ${op.lane} again, run ${op.counterpart}`
      : `safe to repeat; to undo, run ${op.counterpart}`,
  };
  return { ...manifest, digest: sha256(canonical(manifest)) };
}

/** The plan's SQL and check must still be the bytes pinned in this file (re-checked at apply). */
export function assertPlanPinned(plan, registry = OPERATIONS) {
  const op = operationNamed(plan.operation, registry);
  if (
    plan.kind !== OPERATION_KIND ||
    plan.operationKind !== op.kind ||
    plan.role !== op.role ||
    plan.login !== op.login ||
    plan.sql?.path !== op.sql.path ||
    plan.sql?.sha256 !== op.sql.sha256 ||
    plan.verification?.path !== op.verification.path ||
    plan.verification?.sha256 !== op.verification.sha256
  ) {
    throw new Refusal(
      "operation-sql-unpinned",
      "The plan's operation SQL or check differs from the reviewed, pinned version",
    );
  }
  return op;
}

// ── Running an operation ───────────────────────────────────────────────────────────────────────

/** Runs the operation SQL: statements autocommit one by one (ALTER commits before the close). */
async function runOperationSql({ exec, conn, target, file, cwd }) {
  const raw = showsRawOutput(target);
  const result = await exec(
    "psql",
    [
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `VERBOSITY=${raw ? "default" : "sqlstate"}`,
      "-c",
      "set lock_timeout = '10s'",
      "-c",
      "set statement_timeout = '120s'",
      "-f",
      file,
    ],
    { cwd, env: pgEnv(conn, target) },
  );
  const lines = String(result.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    code: result.code,
    last: lines.at(-1) ?? "",
    error:
      result.code === 0
        ? null
        : raw
          ? redact(result.stderr, conn).slice(0, 2000)
          : `sqlstate=${failureFacts(result.stderr).sqlstate}`,
  };
}

/** Parses the close-connections counts; anything else is reported as unreadable, never printed. */
export function parseClosedCounts(line) {
  try {
    const value = JSON.parse(line);
    if (
      value &&
      Object.keys(value).sort().join(",") === "closed,remaining" &&
      Number.isInteger(value.closed) &&
      Number.isInteger(value.remaining) &&
      value.closed >= 0 &&
      value.remaining >= 0
    )
      return value;
  } catch {
    // fall through
  }
  return null;
}

const issueList = (line) => {
  const list = parseJsonArray(line, "verification-output-invalid");
  if (list.some((i) => typeof i !== "string"))
    throw new Refusal(
      "verification-output-invalid",
      "Issue codes must be strings",
    );
  return list;
};

const factList = (line) => {
  const list = parseJsonArray(line, "role-facts-unreadable");
  if (list.some((i) => typeof i !== "string"))
    throw new Refusal("role-facts-unreadable", "Role facts must be strings");
  return list;
};

/** The only role-fact difference an operation may cause, given the facts before it. */
export const expectedRoleDiff = (op, factsBefore) =>
  KINDS[op.kind].expectedRoleDiff(op, factsBefore);

/** Owner-facing recovery text for an operation, by situation (one place for every kind). */
export function recoveryText(op, name, situation, sideFailed = []) {
  const state = op.login ? "resumed" : "paused";
  switch (situation) {
    case "write-attempted":
      return op.login
        ? `The resume may not have finished. Run ${name} again (safe to repeat). Last resort: ${op.lastResort}.`
        : `The pause may be only partly done. Run ${name} again (safe to repeat). Last resort: ${op.lastResort}.`;
    case "end-state-missed": {
      let text =
        `End state NOT reached: do not assume ${op.lane} is ${state}. Run ${name} again (safe to repeat); ` +
        "if the checks still fail, run the runbook's read-only checks privately.";
      if (sideFailed.length)
        text += ` Separately, a side check failed (${sideFailed.join(", ")}): inspect role settings and migration history privately (Supabase SQL editor).`;
      return text;
    }
    case "side-check-failed":
      return (
        `End state verified: ${op.lane} IS ${state} (${op.effect}). But a separate check failed (${sideFailed.join(", ")}): ` +
        "something other than the writer's login changed during the run (another role's settings, or migration history), possibly unrelated activity. " +
        `Do not run ${name} again to fix that, and do not undo the ${op.login ? "resume" : "pause"} because of it; inspect role settings and migration history privately (Supabase SQL editor) and decide.`
      );
    case "verified":
      return op.login
        ? `none needed; to stop ${op.lane} again, run ${op.counterpart}`
        : `none needed; to undo, run ${op.counterpart}`;
    default:
      throw new Error(`unknown recovery situation ${situation}`);
  }
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one operation against `conn`. Never throws: always returns a receipt.
 * status: verified | no-change (end state already held; nothing written) | refused (nothing
 * written) | stopped (the SQL failed; state read back where possible) | verification-failed.
 */
export async function runOperation({
  exec,
  plan,
  dir,
  conn,
  target,
  cwd,
  log = () => {},
  onProgress = async () => {},
  settleMs = SETTLE_MS,
  sleep = sleepFor,
  registry = OPERATIONS,
}) {
  const raw = showsRawOutput(target);
  const receipt = {
    kind: "operation",
    operation: plan.operation,
    status: "in-progress",
    target,
    digest: plan.digest,
    revision: plan.revision,
    sql: plan.sql ? { path: plan.sql.path, sha256: plan.sql.sha256 } : null,
    writeAttempted: false,
    applied: false,
    stateKnown: false,
    steps: [],
    issues: [],
    warnings: [],
    recovery: "none needed: nothing was written",
  };
  const step = async (name, outcome, detail) => {
    receipt.steps.push(detail ? { name, outcome, detail } : { name, outcome });
    log(
      `${outcome === "ok" ? "PASS" : outcome === "warning" ? "WARN" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`,
    );
    await onProgress(receipt);
  };
  const read = (file) => runReadOnlySql({ exec, conn, target, cwd, file });
  const check = async () =>
    issueList(await read(join(dir, plan.verification.path)));
  const roleFacts = async () => factList(await read(join(cwd, ROLE_FACTS_SQL)));
  const history = async () => parseHistory(await read(join(cwd, HISTORY_SQL)));
  const issuesText = (list) => (list.length ? list.join(", ") : "none");

  let op;
  let factsBefore;
  let historyBefore;
  try {
    op = assertPlanPinned(plan, registry);
    await verifyWorkdir({ plan, dir, stage: "full" });
    await step("operation files match the pinned plan hashes", "ok");

    // Role facts need pg_auth_members' per-edge options (PostgreSQL 16+). Refuse cleanly before
    // anything else rather than failing a query part-way through the checks.
    const version = Number(await read(join(cwd, SERVER_VERSION_SQL)));
    if (!Number.isInteger(version) || version < MIN_SERVER_VERSION_NUM) {
      await step(
        "PostgreSQL version",
        "refused",
        Number.isInteger(version)
          ? `server_version_num ${version} is below ${MIN_SERVER_VERSION_NUM}`
          : "server version unreadable",
      );
      throw new Refusal("postgres-version-unsupported");
    }
    await step("PostgreSQL version", "ok", `server_version_num ${version}`);
    historyBefore = await history();
    await step(
      "migration history read",
      "ok",
      `${historyBefore.length} entries (not printed)`,
    );
    factsBefore = await roleFacts();
    await step(
      "every role's attributes recorded",
      "ok",
      `${factsBefore.length} facts (not printed)`,
    );

    const before = await check();
    receipt.stateKnown = true;
    if (before.includes("writer_role_missing")) {
      await step(
        "state before",
        "refused",
        `the ${op.role} role does not exist`,
      );
      throw new Refusal("writer-role-missing");
    }
    // Anything the operation does not itself close means an unexpected starting state: refuse
    // before writing (issue codes are fixed strings, never data, so they are safe to print).
    const closable = KINDS[op.kind].closes(op);
    const unexpected = before.filter((code) => !closable.includes(code));
    if (unexpected.length) {
      await step(
        "state before",
        "refused",
        `unexpected starting state: ${unexpected.join(", ")}`,
      );
      throw new Refusal("operation-precondition");
    }
    if (before.length === 0) {
      receipt.status = "no-change";
      receipt.outcome = op.noChange;
      await step(
        "state before",
        "ok",
        `${op.noChange.replace("-", " ")}: nothing to do, nothing was changed`,
      );
      return receipt;
    }
    await step(
      "state before",
      "ok",
      `open items the operation will close: ${issuesText(before)}`,
    );
  } catch (error) {
    receipt.status = "refused";
    // Every refusal happens before the write, so this run did not establish the end state.
    receipt.endState = "not-reached";
    receipt.issues.push(
      error instanceof Refusal ? error.category : "unexpected-error",
    );
    if (error instanceof Refusal && error.message !== error.category)
      log(error.message);
    await onProgress(receipt);
    return receipt;
  }

  receipt.writeAttempted = true;
  receipt.recovery = recoveryText(op, plan.operation, "write-attempted");
  await onProgress(receipt);
  const ran = await runOperationSql({
    exec,
    conn,
    target,
    cwd,
    file: join(dir, plan.sql.path),
  });
  if (ran.code !== 0) {
    receipt.status = "stopped";
    receipt.issues.push("operation-failed");
    // The SQL failed part-way, so the end state is claimed as missed only when the read-back
    // shows open items; a clean or unreadable read-back after a failed write stays unknown.
    receipt.endState = "unknown";
    await step(plan.operation, "failed", ran.error);
    try {
      const now = await check();
      if (now.length) receipt.endState = "not-reached";
      await step(
        "state after failure",
        now.length ? "failed" : "ok",
        `open items: ${issuesText(now)}`,
      );
    } catch (error) {
      await step(
        "state after failure",
        "failed",
        `unknown (${publicError(error)})`,
      );
    }
    await onProgress(receipt);
    return receipt;
  }
  receipt.applied = true;
  if (op.closesConnections) {
    const counts = parseClosedCounts(ran.last);
    if (counts) {
      receipt.connections = counts;
      await step(
        plan.operation,
        "ok",
        `login switched off; closed ${counts.closed} open connection(s)${counts.remaining ? `; ${counts.remaining} did not end within 5 seconds` : ""}`,
      );
    } else {
      receipt.warnings.push("close-counts-unreadable");
      await step(
        plan.operation,
        "warning",
        "login switched off; connection counts unreadable",
      );
    }
  } else await step(plan.operation, "ok", "login switched on");

  const verifyOnce = async (label) => {
    try {
      const issues = await check();
      if (issues.length) receipt.issues.push(`verification-issues:${label}`);
      await step(
        `verify ${label}`,
        issues.length ? "failed" : "ok",
        issues.length ? `issues: ${issues.join(", ")}` : op.effect,
      );
    } catch (error) {
      receipt.issues.push(`verification-error:${label}`);
      await step(`verify ${label}`, "failed", publicError(error));
    }
  };
  await verifyOnce("immediately");
  if (op.closesConnections) {
    await sleep(settleMs);
    await verifyOnce(
      `after ${Math.round(settleMs / 1000)} s (no connection came back)`,
    );
  }

  try {
    const factsAfter = await roleFacts();
    const diff = diffFacts(factsBefore, factsAfter);
    const expected = expectedRoleDiff(op, factsBefore);
    if (canonical(diff) !== canonical(expected)) {
      receipt.issues.push("other-roles-changed");
      await step(
        "only the writer's login changed (every other role and setting untouched)",
        "failed",
        raw
          ? `removed ${diff.removed.join("; ")} | added ${diff.added.join("; ")}`
          : `${diff.removed.length} fact(s) removed, ${diff.added.length} added; expected ${expected.removed.length} and ${expected.added.length} (facts not printed)`,
      );
    } else
      await step(
        "only the writer's login changed (every other role and setting untouched)",
        "ok",
        `${factsAfter.length} role facts compared`,
      );
  } catch (error) {
    receipt.issues.push("role-facts-error");
    await step(
      "only the writer's login changed (every other role and setting untouched)",
      "failed",
      publicError(error),
    );
  }
  try {
    const historyAfter = await history();
    if (canonical(historyAfter) !== canonical(historyBefore)) {
      receipt.issues.push("migration-history-changed");
      await step(
        "migration history unchanged",
        "failed",
        "it changed during the run",
      );
    } else await step("migration history unchanged", "ok");
  } catch (error) {
    receipt.issues.push("history-error");
    await step("migration history unchanged", "failed", publicError(error));
  }

  // The end state (login off and no connection, or login on) is judged only by the operation's own
  // checks; the role comparison and history checks are separate side checks.
  const endStateReached = !receipt.issues.some((i) =>
    /^verification-(issues|error):/.test(i),
  );
  receipt.endState = endStateReached ? "reached" : "not-reached";
  const sideFailed = receipt.issues.filter(
    (i) => !/^verification-(issues|error):/.test(i),
  );
  if (receipt.issues.length) {
    receipt.status = "verification-failed";
    receipt.recovery = recoveryText(
      op,
      plan.operation,
      endStateReached ? "side-check-failed" : "end-state-missed",
      sideFailed,
    );
  } else {
    receipt.status = "verified";
    receipt.recovery = recoveryText(op, plan.operation, "verified");
  }
  await onProgress(receipt);
  return receipt;
}

// ── Rehearsal on the runner's throwaway database ───────────────────────────────────────────────

/** Spawns a long-running client (a held connection) with a minimal environment. */
export function defaultSpawnHeld(cmd, args, { cwd, env = {} } = {}) {
  const base = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "RUNNER_TEMP"]) {
    if (process.env[key] !== undefined) base[key] = process.env[key];
  }
  const child = spawn(cmd, args, {
    cwd,
    env: { ...base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  const err = [];
  child.stdout.on("data", (b) => out.push(b));
  child.stderr.on("data", (b) => err.push(b));
  const done = new Promise((resolve) => {
    child.on("error", () =>
      resolve({ code: 127, stdout: "", stderr: `${cmd} unavailable` }),
    );
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
  return { done, kill: () => child.kill("SIGKILL") };
}

const within = (promise, ms) =>
  Promise.race([promise, sleepFor(ms).then(() => null)]);

/**
 * Plan-job rehearsal: sets up the expected starting state on the runner's own database (the writer
 * and the other function roles get a throwaway password; for a pause the writer holds an open
 * connection), runs the exact production code path, and proves the effect and its limits:
 * the writer's sign-in is refused (pause) or allowed (resume), its open connection was closed,
 * the purchase, sales and rating roles still sign in, only the writer's login fact changed among
 * all roles, catalog/grants/data/migration history are identical, and repeating the operation
 * reports no change.
 */
export async function runOperationReplay({
  exec,
  spawnHeld = defaultSpawnHeld,
  plan,
  dir,
  conn,
  cwd,
  log = () => {},
  settleMs = 3_000,
  sleep = sleepFor,
  pollMs = 500,
  registry = OPERATIONS,
}) {
  if (!isLoopback(conn))
    throw new Refusal(
      "replay-not-local",
      "Replay only runs against the runner's own database",
    );
  const op = assertPlanPinned(plan, registry);
  const target = "local-replay";
  const password = randomBytes(18).toString("hex");
  const proofs = [];
  const prove = (name, ok, detail) => {
    proofs.push(detail ? { name, ok, detail } : { name, ok });
    log(
      `${ok ? "PROVED" : "NOT PROVED"} ${name}${detail ? `: ${detail}` : ""}`,
    );
  };
  const env = pgEnv(conn, target);
  const sql = async (text, { readOnly = false } = {}) => {
    const result = await exec(
      "psql",
      [
        "-X",
        "-q",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        ...(readOnly
          ? ["-c", "set session characteristics as transaction read only"]
          : []),
        "-c",
        text,
      ],
      { cwd, env },
    );
    if (result.code !== 0)
      throw new Refusal(
        "rehearsal-setup-failed",
        `Rehearsal setup query failed: ${redact(result.stderr, conn).replaceAll(password, "***").slice(0, 1000)}`,
      );
    return String(result.stdout).trim().split("\n").at(-1) ?? "";
  };
  const loginEnv = (role) => ({
    ...env,
    PGUSER: role,
    PGPASSWORD: password,
    PGAPPNAME: "still-operation-rehearsal",
  });
  const probe = async (role) => {
    const result = await exec(
      "psql",
      ["-X", "-q", "-A", "-t", "-c", "select current_user"],
      { cwd, env: loginEnv(role) },
    );
    if (result.code === 0 && String(result.stdout).trim() === role)
      return "signed-in";
    if (/is not permitted to log in/.test(result.stderr))
      return "login-refused";
    return "error";
  };
  const writerConnections = async () =>
    Number(
      await sql(
        `select pg_catalog.count(*) from pg_catalog.pg_stat_activity where usename = '${op.role}'`,
        { readOnly: true },
      ),
    );
  const read = (file) => runReadOnlySql({ exec, conn, target, cwd, file });
  const snapshot = async () => ({
    roles: factList(await read(join(cwd, ROLE_FACTS_SQL))),
    catalog: parseJsonArray(
      await read(join(cwd, FACTS_SQL)),
      "facts-unreadable",
    ),
    data: parseJsonArray(
      await read(join(cwd, DATA_FINGERPRINT_SQL)),
      "data-unreadable",
    ),
    history: parseHistory(await read(join(cwd, HISTORY_SQL))),
  });

  // Starting state, rehearsal only: the roles that exist get LOGIN and a throwaway password.
  const roles = JSON.parse(
    await sql(
      `select coalesce(pg_catalog.json_agg(rolname::text order by rolname), '[]') from pg_catalog.pg_roles where rolname in (${[op.role, ...untouchedRoles(op)].map((r) => `'${r}'`).join(", ")})`,
      { readOnly: true },
    ),
  );
  if (!roles.includes(op.role))
    throw new Refusal(
      "writer-role-missing",
      `The rehearsal database has no ${op.role} role`,
    );
  const others = untouchedRoles(op).filter((r) => roles.includes(r));
  for (const role of roles)
    await sql(`alter role ${role} login password '${password}'`);
  if (op.login) await sql(`alter role ${op.role} nologin`);

  let held = null;
  try {
    if (op.closesConnections) {
      held = spawnHeld(
        "psql",
        // The writer roles carry a 2 s statement_timeout; the held connection lifts it for its own
        // session so only the operation, never the timeout, can end it.
        [
          "-X",
          "-q",
          "-A",
          "-t",
          "-c",
          "set statement_timeout = 0",
          "-c",
          "select pg_catalog.pg_sleep(600)",
        ],
        { cwd, env: loginEnv(op.role) },
      );
      let open = 0;
      for (let i = 0; i < 60 && open < 1; i++) {
        open = await writerConnections();
        if (open < 1) await sleep(pollMs);
      }
      prove(
        "before: the writer holds an open connection",
        open >= 1,
        `${open} open`,
      );
    }
    const writerBefore = await probe(op.role);
    prove(
      `before: the writer's sign-in is ${op.login ? "refused" : "allowed"}`,
      writerBefore === (op.login ? "login-refused" : "signed-in"),
      writerBefore,
    );
    for (const role of others) {
      const result = await probe(role);
      prove(`before: ${role} signs in`, result === "signed-in", result);
    }

    const before = await snapshot();
    const receipt = await runOperation({
      exec,
      plan,
      dir,
      conn,
      target,
      cwd,
      log,
      settleMs,
      sleep,
      registry,
    });
    prove(
      "the exact production code path verified the operation",
      receipt.status === "verified",
      receipt.status,
    );

    if (held) {
      const ended = await within(held.done, 15_000);
      prove(
        "after: the writer's open connection was closed by the operation",
        Boolean(ended) &&
          ended.code !== 0 &&
          /terminating connection due to administrator command/i.test(
            ended.stderr,
          ),
        ended ? `client exit ${ended.code}` : "still open after 15 s",
      );
    }
    const writerAfter = await probe(op.role);
    prove(
      `after: the writer's sign-in is ${op.login ? "allowed" : "refused (role is not permitted to log in)"}`,
      writerAfter === (op.login ? "signed-in" : "login-refused"),
      writerAfter,
    );
    if (!op.login) {
      const open = await writerConnections();
      prove(
        "after: the writer holds no connection",
        open === 0,
        `${open} open`,
      );
    }
    for (const role of others) {
      const result = await probe(role);
      prove(
        `after: ${role} still signs in (untouched)`,
        result === "signed-in",
        result,
      );
    }

    const after = await snapshot();
    const roleDiff = diffFacts(before.roles, after.roles);
    const expected = expectedRoleDiff(op, before.roles);
    prove(
      "among every role, only the writer's login changed",
      canonical(roleDiff) === canonical(expected) &&
        expected.removed.length === 1,
      `removed: ${roleDiff.removed.join("; ") || "none"} | added: ${roleDiff.added.join("; ") || "none"}`,
    );
    const catalogDiff = diffFacts(before.catalog, after.catalog);
    prove(
      "grants, functions, policies and migration history unchanged",
      catalogDiff.removed.length === 0 && catalogDiff.added.length === 0,
      `${catalogDiff.removed.length} removed, ${catalogDiff.added.length} added`,
    );
    prove(
      "every row in public, private and migration history unchanged",
      canonical(before.data) === canonical(after.data),
      `${after.data.length} tables compared`,
    );
    prove(
      "nothing added to migration history",
      canonical(before.history) === canonical(after.history),
      `${after.history.length} entries`,
    );

    const repeat = await runOperation({
      exec,
      plan,
      dir,
      conn,
      target,
      cwd,
      log,
      settleMs,
      sleep,
      registry,
    });
    prove(
      `repeating the operation reports ${op.noChange} and writes nothing`,
      repeat.status === "no-change" &&
        repeat.outcome === op.noChange &&
        !repeat.writeAttempted,
      repeat.status,
    );
    const again = await snapshot();
    prove(
      "the repeat changed nothing at all",
      canonical(again) === canonical(after),
    );
    return {
      kind: "operation",
      status: proofs.every((p) => p.ok) ? "verified" : "rehearsal-failed",
      receipt,
      repeat,
      proofs,
      roleDiff,
    };
  } finally {
    held?.kill();
  }
}

// ── Rendering (public, privacy-safe) ───────────────────────────────────────────────────────────

const STEP_ICON = { ok: "✅", warning: "⚠️" };
const renderSteps = (steps) =>
  steps.map(
    (s) =>
      `- ${STEP_ICON[s.outcome] ?? "❌"} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`,
  );
const fence = (text) => text.replace(/```/g, "``​`");

export function renderOperationPlan(plan) {
  return [
    `## Supabase production operation plan: \`${plan.operation}\``,
    "",
    `- Commit: \`${plan.revision}\` (on main; workflow from \`${plan.workflowRevision}\`)`,
    `- Plan digest: \`${plan.digest}\``,
    `- Approval environment: \`${plan.environment}\` (owner approval required before any secret is available)`,
    "- This is an operation, not a migration: nothing is added to migration history, and no migration or function runs with it.",
    `- End state the job verifies: ${plan.effect}.`,
    `- Untouched, and checked: every other role, including the other function roles ${plan.untouchedRoles.join(", ")}.`,
    "- Safe to repeat: if the end state already holds, the job reports it and writes nothing.",
    plan.onFirstParent
      ? "- The commit is on main's own line of history (first parent)."
      : "- ⚠️ **The commit is not on main's own line of history**: it reached main through a merged branch. Allowed only because the operation files are byte-identical on main.",
    "",
    "| File | Role | SHA-256 |",
    "|---|---|---|",
    `| \`${plan.sql.path}\` | exact SQL that runs (pinned in operations.mjs) | \`${plan.sql.sha256}\` |`,
    `| \`${plan.verification.path}\` | read-only end-state check (before and after) | \`${plan.verification.sha256}\` |`,
    "",
    "<details><summary>Exact SQL</summary>",
    "",
    "```sql",
    fence(plan.sqlText),
    "```",
    "</details>",
    "",
    `**If anything fails:** ${plan.recovery}. Nothing is rolled back automatically.`,
    "",
  ].join("\n");
}

const END_STATE_TEXT = Object.freeze({
  reached: "reached (verified)",
  "not-reached": "NOT reached",
  unknown: "UNKNOWN",
});

/** The "End state" line the runbook tells the owner to read first; absent only for no-change. */
function renderEndState(endState) {
  return endState ? [`- End state: ${END_STATE_TEXT[endState]}`] : [];
}

export function renderOperationReceipt(receipt) {
  const icon = ["verified", "no-change"].includes(receipt.status) ? "✅" : "❌";
  return [
    `## ${icon} Production operation \`${receipt.operation}\`: ${receipt.status === "no-change" ? `${receipt.outcome} (no change)` : receipt.status}`,
    "",
    `- Commit \`${receipt.revision}\`, plan digest \`${receipt.digest}\``,
    ...(receipt.sql
      ? [`- SQL \`${receipt.sql.path}\` SHA-256 \`${receipt.sql.sha256}\``]
      : []),
    `- Write attempted: ${receipt.writeAttempted ? "yes" : "no"}`,
    ...renderEndState(receipt.endState),
    ...(receipt.issues.length
      ? [`- Issues: ${receipt.issues.join(", ")}`]
      : []),
    ...(receipt.warnings.length
      ? [`- Warnings: ${receipt.warnings.join(", ")}`]
      : []),
    `- Recovery: ${receipt.recovery}`,
    "",
    ...renderSteps(receipt.steps),
    "",
  ].join("\n");
}

export function renderOperationReplay(result) {
  const lines = [
    `## Rehearsal of \`${result.receipt.operation}\` on a throwaway database (no production access): ${result.status}`,
    "",
    "### What the rehearsal proved",
    "",
    ...result.proofs.map(
      (p) =>
        `- ${p.ok ? "✅" : "❌"} ${p.name}${p.detail ? ` — ${p.detail}` : ""}`,
    ),
    "",
    "### The exact production code path",
    "",
    ...renderSteps(result.receipt.steps),
    "",
    "### Repeated once (must change nothing)",
    "",
    ...renderSteps(result.repeat?.steps ?? []),
    "",
  ];
  return lines.join("\n");
}

/** Always-run, secret-free closing record for an operation; covers cancellation and timeouts. */
export function renderOperationFinal(receipt, { applyOutcome, jobStatus }) {
  const how = jobStatus === "cancelled" ? "cancelled" : "stopped or timed out";
  let outcome =
    receipt.status === "no-change"
      ? `${receipt.outcome} (no change)`
      : receipt.status;
  let recovery = receipt.recovery;
  let endState = receipt.endState;
  if (receipt.status === "in-progress") {
    // The run ended before it could judge the end state, wherever it was interrupted.
    endState = "unknown";
    // Every operation is safe to repeat: the one to run again is the one that was interrupted.
    const again = receipt.operation;
    if (receipt.applied) {
      outcome = `operation ran; verification not completed (interrupted: ${how})`;
      recovery = `run ${again} again (safe to repeat; it reports the state and writes nothing if already done)`;
    } else if (receipt.writeAttempted) {
      outcome = `operation started; result unknown (interrupted: ${how})`;
      recovery = `run ${again} again (safe to repeat); it reads the state first`;
    } else {
      outcome = `interrupted before any write (${how})`;
      recovery = "nothing was written; plan and approve again.";
    }
  }
  return [
    "## Operation closing record",
    "",
    `- Operation: \`${receipt.operation}\``,
    `- Outcome: ${outcome}; apply step ${applyOutcome || "unknown"}, job ${jobStatus || "unknown"}`,
    `- Write attempted: ${receipt.writeAttempted ? "yes" : "no"}`,
    ...renderEndState(endState),
    ...(receipt.sql
      ? [`- SQL \`${receipt.sql.path}\` SHA-256 \`${receipt.sql.sha256}\``]
      : []),
    `- Recovery: ${recovery}`,
    "",
    "Steps recorded before the end of the run:",
    "",
    ...renderSteps(receipt.steps),
    "",
  ].join("\n");
}

/**
 * Closing record when the apply step left no receipt for a known operation (it stopped before the
 * operation began, e.g. a malformed or loopback database URL). The operation writes its receipt
 * before any database write, so no receipt means no write: safe to plan and approve again.
 */
export function renderOperationFinalWithoutReceipt(
  operation,
  { applyOutcome, jobStatus },
) {
  return [
    "## Operation closing record",
    "",
    `- Operation: \`${operation}\``,
    `- Outcome: stopped before the operation began (no record was written); apply step ${applyOutcome || "not run"}, job ${jobStatus || "unknown"}`,
    "- Write attempted: no (no database write was recorded)",
    ...renderEndState("not-reached"),
    "- Recovery: no database write was recorded; it is safe to plan and approve again.",
    "",
  ].join("\n");
}

/** True when `name` is one of the registered operations (not the migrations mode). */
export const isKnownOperation = (name, registry = OPERATIONS) =>
  Object.hasOwn(registry, name);
