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

/** Kind of an operation that publishes a pinned SANDBOX sales body (one transaction, compare-and-set). */
export const QA_SALES_POLICY = "qa-sales-policy";
/** Kind of an operation that enables or disables QA sandbox memberships (one transaction, never deletes). */
export const QA_SUBJECTS = "qa-subjects";

/** Ledger subject the protected workflow records as "operator", so no owner identity is in Git. */
export const PROTECTED_OPERATOR_SUBJECT =
  "00000000-0000-0000-0000-000000000000";

/**
 * Decision A3: the build identifiers the current QA test set (test set 5) presents, frozen from its artifacts (built from
 * main 4f122a82, first-parent count 321). Extensions present their manifest version
 * (`browser.runtime.getManifest().version` = package.json version + `.` + VITE_QA_BUILD_SEQUENCE);
 * Apple hosts present CFBundleShortVersionString (MARKETING_VERSION). A new QA test set changes these
 * here, in both sales-policy SQL templates and their pinned hashes, in one reviewed change, then
 * publishes a new sandbox revision.
 */
export const QA_SANDBOX_SALES_BUILDS = Object.freeze(
  [
    ["chrome_desktop", "2.1.1.321"],
    ["firefox_desktop", "2.1.1.321"],
    ["firefox_android", "2.1.1.321"],
    ["apple_mobile_host", "2.1.0"],
    ["apple_macos_host", "2.1.0"],
  ].map(([surface, build]) => Object.freeze({ surface, build })),
);

const salesTemplate = (enabled) =>
  Object.freeze({
    schema: 1,
    environment: "sandbox",
    salesEnabled: enabled,
    channels: Object.freeze({
      apple: Object.freeze({ enabled, offer: "still-pro-v3" }),
      web: Object.freeze({ enabled, offer: "still-pro-v3" }),
    }),
    builds: QA_SANDBOX_SALES_BUILDS,
  });

/** The pinned sandbox sales bodies (without their revision), exactly as in the two SQL files. */
export const QA_SANDBOX_SALES_TEMPLATES = Object.freeze({
  off: salesTemplate(false),
  on: salesTemplate(true),
});

/**
 * Decision D2 (accepted for the sandbox): the sandbox paid cutoff written once by the first `on`: a
 * protected product id (never still-pro-v3) and the sorted ids of the features released free
 * (FEATURE_REGISTRY tier "free" plus the TikTok website alias). 0016 open question 6 still leaves the
 * production content to a separate decision.
 */
export const QA_SANDBOX_CUTOFF = Object.freeze({
  product: "still-free-v2",
  benefits: Object.freeze([
    "facebook.reels",
    "instagram.reels",
    "tiktok.all",
    "youtube.shorts",
  ]),
});

/** The exact bytes private.product_policy_render('sales', template + revision) produces. */
export function renderSalesBody(template, revision) {
  const channel = (name) =>
    `"${name}":{"enabled":${template.channels[name].enabled},"offer":"${template.channels[name].offer}"}`;
  const builds = template.builds
    .map((b) => `{"surface":"${b.surface}","build":"${b.build}"}`)
    .join(",");
  return (
    `{"schema":1,"environment":"${template.environment}","revision":${revision},` +
    `"salesEnabled":${template.salesEnabled},"channels":{${channel("apple")},${channel("web")}},` +
    `"builds":[${builds}]}`
  );
}

const salesPolicy = (mode, { sql, verification }) =>
  Object.freeze({
    kind: QA_SALES_POLICY,
    workflowOperation: "qa-sandbox-sales-policy",
    policyMode: mode,
    run: `qa-sandbox-sales-policy with policy_mode ${mode}`,
    requiresMigration: "0016_product_policy.sql",
    sql: Object.freeze(sql),
    verification: Object.freeze(verification),
    noChange: `already-${mode}`,
    template: QA_SANDBOX_SALES_TEMPLATES[mode],
    cutoff: mode === "on" ? QA_SANDBOX_CUTOFF : null,
    // Content not yet approved for production would be listed here (apply is then refused).
    provisional: Object.freeze([]),
    effect:
      mode === "on"
        ? "the newest sandbox sales revision is the pinned on body, the sandbox paid cutoff exists with the pinned content, and production has no paid cutoff"
        : "the newest sandbox sales revision is the pinned off body, and production has no paid cutoff",
    lane: "sandbox sales",
    counterpart: `qa-sandbox-sales-policy with policy_mode ${mode === "on" ? "off" : "on"}`,
    lastResort:
      "run pause-qa-sandbox, which stops every paid QA function at once",
    preconditionRecovery:
      "Nothing was written. If the refusal lists production_cutoff_present: once production has a paid cutoff, both sandbox sales switches (off and on) refuse by design; to stop QA purchases use pause-qa-sandbox. Otherwise check the state privately, then plan and approve again.",
  });

const subjects = (mode, { sql, verification }) =>
  Object.freeze({
    kind: QA_SUBJECTS,
    workflowOperation: "qa-sandbox-subjects",
    policyMode: mode,
    run: `qa-sandbox-subjects with policy_mode ${mode}`,
    requiresMigration: "0021_qa_sandbox_access.sql",
    sql: Object.freeze(sql),
    verification: Object.freeze(verification),
    noChange: mode === "enable" ? "already-enabled" : "already-disabled",
    provisional: Object.freeze([]),
    effect:
      mode === "enable"
        ? "the enabled QA sandbox memberships are exactly the approved test accounts, each a confirmed, active account (no row deleted)"
        : "no QA sandbox membership is enabled (every row kept)",
    lane: "QA test accounts",
    counterpart: `qa-sandbox-subjects with policy_mode ${mode === "enable" ? "disable" : "enable"}`,
    lastResort:
      "run pause-qa-sandbox, which stops every paid QA function at once",
    preconditionRecovery:
      "Nothing was written. An approved account is unknown, matches more than one account, or is not confirmed and active. Rebuild the list only from the designated QA accounts file, check its count, and plan and approve again.",
    // Said on every verified run: what switching memberships off does not do.
    verifiedNote:
      "Switching a membership off stops new paid grants for that account; sandbox rights it was already granted are kept (refund or transfer them through the QA flows). To stop every paid QA function at once, run pause-qa-sandbox.",
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
  "qa-sandbox-sales-policy-off": salesPolicy("off", {
    sql: {
      path: `${OPERATIONS_DIR}/qa-sandbox-sales-policy-off.sql`,
      sha256:
        "7740dc3294f237e8637d2f533f73bc194d42f6f3dff950bd894b2bf0338bb5ac",
    },
    verification: {
      path: `${OPERATIONS_DIR}/qa-sandbox-sales-policy-off.verify.sql`,
      sha256:
        "9d2fbd96ad5533880ef1168cad5267800a251dab5fea995a51b1b3e79a356857",
    },
  }),
  "qa-sandbox-sales-policy-on": salesPolicy("on", {
    sql: {
      path: `${OPERATIONS_DIR}/qa-sandbox-sales-policy-on.sql`,
      sha256:
        "6595a4aaad3b23339e70d438e819bcb8d6d1fd736a4e42523545df37933148bc",
    },
    verification: {
      path: `${OPERATIONS_DIR}/qa-sandbox-sales-policy-on.verify.sql`,
      sha256:
        "c6c5277462a826f796ee259226d70da53585d581bae6a59446cb1a78e56df25f",
    },
  }),
  "qa-sandbox-subjects-enable": subjects("enable", {
    sql: {
      path: `${OPERATIONS_DIR}/qa-sandbox-subjects-enable.sql`,
      sha256:
        "cbadc23205271745bf85f3c5c148078d77d0bac2017b4fcf708a0b1828c02d2c",
    },
    verification: {
      path: `${OPERATIONS_DIR}/qa-sandbox-subjects-enable.verify.sql`,
      sha256:
        "3e4d15a1d67dbc762d8af178d5ef3e6e577b0c168048bf3c4a209b96bf186c17",
    },
  }),
  "qa-sandbox-subjects-disable": subjects("disable", {
    sql: {
      path: `${OPERATIONS_DIR}/qa-sandbox-subjects-disable.sql`,
      sha256:
        "51a7695b80cfdcc77bdfcc4b038ac6275df038a4e6d1b2223c9704d337b6ad8e",
    },
    verification: {
      path: `${OPERATIONS_DIR}/qa-sandbox-subjects-disable.verify.sql`,
      sha256:
        "4cb686c69f7819ad4d0b57b2172c3a760abcc4b88a70e8cd9c73df6fe225377d",
    },
  }),
});

/** Workflow value for an ordinary numbered-migration deploy. */
export const MIGRATIONS_MODE = "migrations";

/** The `policy_mode` workflow value for every operation that takes no mode. */
export const NO_POLICY_MODE = "none";

/**
 * The workflow's `operation` choices that run an owner-approved operation, and the registry row
 * each `policy_mode` selects. A future kind (for example the QA credentials operation) adds its
 * workflow choice here and its own secret wiring in the workflow, scoped to its apply step.
 */
export const WORKFLOW_OPERATIONS = Object.freeze({
  "pause-settings-sync": Object.freeze({ none: "pause-settings-sync" }),
  "resume-settings-sync": Object.freeze({ none: "resume-settings-sync" }),
  "pause-qa-sandbox": Object.freeze({ none: "pause-qa-sandbox" }),
  "resume-qa-sandbox": Object.freeze({ none: "resume-qa-sandbox" }),
  "qa-sandbox-sales-policy": Object.freeze({
    off: "qa-sandbox-sales-policy-off",
    on: "qa-sandbox-sales-policy-on",
  }),
  "qa-sandbox-subjects": Object.freeze({
    enable: "qa-sandbox-subjects-enable",
    disable: "qa-sandbox-subjects-disable",
  }),
});

/** Every `policy_mode` value the workflow offers, in its order. */
export const POLICY_MODES = Object.freeze([
  NO_POLICY_MODE,
  "off",
  "on",
  "enable",
  "disable",
]);

/** The registry row a workflow `operation` and `policy_mode` select; anything else is refused. */
export function resolveOperation(operation, policyMode) {
  const mode = isBlankText(policyMode) ? NO_POLICY_MODE : String(policyMode);
  if (
    typeof operation !== "string" ||
    !Object.hasOwn(WORKFLOW_OPERATIONS, operation)
  )
    throw new Refusal(
      "operation-unknown",
      `Unknown operation; use one of: ${Object.keys(WORKFLOW_OPERATIONS).join(", ")}`,
    );
  const modes = WORKFLOW_OPERATIONS[operation];
  if (!Object.hasOwn(modes, mode))
    throw new Refusal(
      "operation-input-invalid",
      `${operation} takes policy_mode ${Object.keys(modes).join(" or ")}`,
    );
  return modes[mode];
}

const isBlankText = (text) => String(text ?? "").trim() === "";

/** How the owner runs an operation again from the workflow form. */
export const runName = (name, registry = OPERATIONS) =>
  registry[name]?.run ?? name;

// ── QA test-account list (the list itself never leaves the runner's memory) ──────────────────

const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,185}\.[a-z]{2,24}$/;
/** At least 128 random bits, lower-case hex, so the public approval value cannot be guessed. */
const SALT = /^[0-9a-f]{32,128}$/;
/** The workflow's subjects_sha256 value: the approved account count, a colon, the salted SHA-256. */
const SUBJECTS_BINDING = /^([1-9][0-9]?):([0-9a-f]{64})$/;

/**
 * The approved test-account list secret, `{"salt":"<32+ random lower-case hex>","emails":[...]}`.
 * Returns the SHA-256 of its canonical form (`{"salt":...,"emails":[sorted, lower-cased]}`), the
 * account count, the `subjects_sha256` workflow value (`<count>:<sha256>`, so the plan shows the
 * count) and the per-email SHA-256 values the database receives. The salt keeps the public value
 * from being checked by guessing emails. Refuses a missing or short salt, any other key, or anything
 * but 1 to 50 distinct email addresses. Never echoes input.
 */
export function canonicalSubjects(text) {
  let secret;
  try {
    secret = JSON.parse(String(text ?? ""));
  } catch {
    secret = null;
  }
  if (
    !secret ||
    typeof secret !== "object" ||
    Array.isArray(secret) ||
    Object.keys(secret).sort().join(",") !== "emails,salt"
  )
    throw new Refusal(
      "subjects-list-invalid",
      'The test-account list secret must be {"salt":"<random hex>","emails":[...]}',
    );
  if (typeof secret.salt !== "string" || !SALT.test(secret.salt))
    throw new Refusal(
      "subjects-list-invalid",
      "The test-account list secret needs a salt of at least 32 random lower-case hex characters",
    );
  const list = secret.emails;
  if (!Array.isArray(list) || list.length < 1 || list.length > 50)
    throw new Refusal(
      "subjects-list-invalid",
      "The test-account list must hold 1 to 50 email addresses",
    );
  const emails = list.map((e) =>
    typeof e === "string" ? e.trim().toLowerCase() : "",
  );
  if (
    emails.some((e) => !EMAIL.test(e)) ||
    new Set(emails).size !== emails.length
  )
    throw new Refusal(
      "subjects-list-invalid",
      "The test-account list must hold distinct, well-formed email addresses",
    );
  const digest = sha256(
    JSON.stringify({ salt: secret.salt, emails: [...emails].sort() }),
  );
  return {
    sha256: digest,
    count: emails.length,
    binding: `${emails.length}:${digest}`,
    hashes: emails.map((e) => sha256(e)).sort(),
  };
}

const MAX_REVISION = 9007199254740990; // 0016: a published revision stays below 2^53 - 1

const noRoleChange = () => ({ removed: [], added: [] });

/** Parses the one-line JSON outcome a transactional operation prints; null if it is not exactly `keys`. */
function parseOutcome(line, keys) {
  try {
    const value = JSON.parse(line);
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(",")
    )
      return value;
  } catch {
    // fall through
  }
  return null;
}
const count = (n) => Number.isInteger(n) && n >= 0;

/**
 * Per-kind contracts. `definition` checks the registry row; `scope` checks the SQL text against the
 * kind's allowed statement shapes; `inputs` validates the workflow inputs into plan fields;
 * `pinned` re-checks those plan fields at apply; `vars` are the values the SQL and its check read
 * through psql (never argv); `closes` lists the end-state check's issue codes the operation may
 * close (any other code before the write is a refusal); `wrote` turns the SQL's last output line
 * into a safe step; `refusals` names the SQLSTATEs the SQL raises deliberately (nothing written);
 * `expectedRoleDiff` is the only change to role facts the operation may cause.
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
    inputs(op, { expectedRevision, subjectsSha256 }) {
      noExtraInputs({ expectedRevision, subjectsSha256 });
      return {
        role: op.role,
        login: op.login,
        closesConnections: op.closesConnections,
      };
    },
    pinned: (plan, op) =>
      plan.role === op.role &&
      plan.login === op.login &&
      plan.closesConnections === op.closesConnections,
    vars: () => ({}),
    closes: (op) =>
      op.login
        ? ["writer_cannot_login"]
        : ["writer_can_login", "writer_connections_open"],
    wrote(op, line, receipt) {
      if (!op.closesConnections)
        return { outcome: "ok", detail: "login switched on" };
      const counts = parseClosedCounts(line);
      if (!counts) {
        receipt.warnings.push("close-counts-unreadable");
        return {
          outcome: "warning",
          detail: "login switched off; connection counts unreadable",
        };
      }
      receipt.connections = counts;
      return {
        outcome: "ok",
        detail: `login switched off; closed ${counts.closed} open connection(s)${counts.remaining ? `; ${counts.remaining} did not end within 5 seconds` : ""}`,
      };
    },
    refusals: Object.freeze({}),
    expectedRoleDiff(op, factsBefore) {
      const from = `role ${op.role} | login ${!op.login}`;
      const to = `role ${op.role} | login ${op.login}`;
      return factsBefore.includes(from)
        ? { removed: [from], added: [to] }
        : { removed: [], added: [] };
    },
  }),
  [QA_SALES_POLICY]: Object.freeze({
    definition(op, bad) {
      if (op.role !== undefined || op.login !== undefined)
        bad("a sales-policy operation touches no role");
      if (!["off", "on"].includes(op.policyMode)) bad("bad policy mode");
      if (op.template !== QA_SANDBOX_SALES_TEMPLATES[op.policyMode])
        bad("the body template is not the pinned one");
      if (op.template.environment !== "sandbox")
        bad("a sales-policy operation may only publish a sandbox body");
      if (op.cutoff !== (op.policyMode === "on" ? QA_SANDBOX_CUTOFF : null))
        bad("only the on mode writes the pinned cutoff");
      if (op.noChange !== `already-${op.policyMode}`)
        bad("missing no-change outcome");
      if (!Array.isArray(op.provisional)) bad("missing provisional list");
    },
    scope: (sql, op) =>
      assertTransactionScope(sql, op, {
        getenv: [
          "STILL_OPERATION_EXPECTED_REVISION",
          "STILL_OPERATION_POLICY_BODY",
        ],
        writes:
          op.policyMode === "on"
            ? [
                "private.product_policy_operations",
                "private.product_policy_revisions",
                "private.paid_cutoff",
              ]
            : [
                "private.product_policy_operations",
                "private.product_policy_revisions",
              ],
        reads: ["private.product_policy_revisions", "private.paid_cutoff"],
        updates: false,
        required: ["'sandbox'"],
      }),
    inputs(op, { expectedRevision, subjectsSha256 }) {
      noExtraInputs({ subjectsSha256 });
      const text = String(expectedRevision ?? "").trim();
      if (!/^(0|[1-9][0-9]{0,15})$/.test(text) || Number(text) > MAX_REVISION)
        throw new Refusal(
          "operation-input-invalid",
          "policy_expected_revision must be the current sandbox sales revision (0 for the first entry)",
        );
      const expected = Number(text);
      const body = renderSalesBody(op.template, expected + 1);
      return {
        workflowOperation: op.workflowOperation,
        policyMode: op.policyMode,
        expectedRevision: expected,
        policyRevision: expected + 1,
        body,
        bodySha256: sha256(body),
        ...(op.cutoff
          ? {
              cutoff: {
                product: op.cutoff.product,
                benefits: [...op.cutoff.benefits],
              },
            }
          : {}),
        provisional: [...op.provisional],
      };
    },
    pinned: (plan, op) =>
      plan.policyMode === op.policyMode &&
      Number.isSafeInteger(plan.expectedRevision) &&
      plan.expectedRevision >= 0 &&
      plan.expectedRevision <= MAX_REVISION &&
      plan.body === renderSalesBody(op.template, plan.expectedRevision + 1) &&
      plan.bodySha256 === sha256(plan.body) &&
      canonical(plan.cutoff ?? null) ===
        canonical(
          op.cutoff
            ? { product: op.cutoff.product, benefits: [...op.cutoff.benefits] }
            : null,
        ) &&
      canonical(plan.provisional) === canonical([...op.provisional]),
    vars: (plan) => ({
      STILL_OPERATION_EXPECTED_REVISION: String(plan.expectedRevision),
      STILL_OPERATION_POLICY_BODY: plan.body,
    }),
    closes: (op) =>
      op.policyMode === "on"
        ? [
            "sandbox_cutoff_missing",
            "sandbox_sales_policy_differs",
            "sandbox_sales_policy_missing",
          ]
        : ["sandbox_sales_policy_differs", "sandbox_sales_policy_missing"],
    wrote(op, line, receipt) {
      const result = parseOutcome(line, ["revision", "cutoff"]);
      if (
        !result ||
        !count(result.revision) ||
        !["inserted", "present", "unchanged"].includes(result.cutoff)
      ) {
        receipt.warnings.push("result-unreadable");
        return {
          outcome: "warning",
          detail: "published; the result line was unreadable",
        };
      }
      receipt.result = result;
      return {
        outcome: "ok",
        detail: `published sandbox sales revision ${result.revision}; sandbox paid cutoff ${result.cutoff}`,
      };
    },
    refusals: Object.freeze({
      QP000: "operator-role-required",
      QP001: "stale-expected-revision",
      QP002: "body-invalid",
      QP003: "body-differs-from-plan",
      QP004: "body-wrong-for-mode",
      QP005: "expected-revision-invalid",
    }),
    expectedRoleDiff: noRoleChange,
  }),
  [QA_SUBJECTS]: Object.freeze({
    definition(op, bad) {
      if (op.role !== undefined || op.login !== undefined)
        bad("a subjects operation touches no role");
      if (!["enable", "disable"].includes(op.policyMode))
        bad("bad policy mode");
      if (
        op.noChange !==
        (op.policyMode === "enable" ? "already-enabled" : "already-disabled")
      )
        bad("missing no-change outcome");
      if (!Array.isArray(op.provisional)) bad("missing provisional list");
    },
    scope: (sql, op) =>
      assertTransactionScope(sql, op, {
        getenv:
          op.policyMode === "enable" ? ["STILL_OPERATION_SUBJECT_HASHES"] : [],
        writes: ["private.qa_sandbox_subjects"],
        reads:
          op.policyMode === "enable"
            ? ["auth.users", "private.qa_sandbox_subjects"]
            : ["private.qa_sandbox_subjects"],
        updates: true,
        required: [],
      }),
    inputs(op, { expectedRevision, subjectsSha256 }) {
      noExtraInputs({ expectedRevision });
      const digest = String(subjectsSha256 ?? "").trim();
      if (op.policyMode === "disable") {
        if (digest !== "")
          throw new Refusal(
            "operation-input-invalid",
            "disable switches every membership off; leave subjects_sha256 empty",
          );
        return {
          workflowOperation: op.workflowOperation,
          policyMode: op.policyMode,
        };
      }
      const bound = SUBJECTS_BINDING.exec(digest);
      if (!bound || Number(bound[1]) > 50)
        throw new Refusal(
          "operation-input-invalid",
          "subjects_sha256 must be <account count>:<SHA-256> of the salted test-account list (deploy.mjs subjects-digest prints it)",
        );
      return {
        workflowOperation: op.workflowOperation,
        policyMode: op.policyMode,
        subjectCount: Number(bound[1]),
        subjectsSha256: bound[2],
      };
    },
    pinned: (plan, op) =>
      plan.policyMode === op.policyMode &&
      (op.policyMode === "enable"
        ? /^[0-9a-f]{64}$/.test(plan.subjectsSha256 ?? "") &&
          Number.isInteger(plan.subjectCount) &&
          plan.subjectCount >= 1 &&
          plan.subjectCount <= 50
        : plan.subjectsSha256 === undefined && plan.subjectCount === undefined),
    vars(plan, { subjectEmails } = {}) {
      if (plan.policyMode !== "enable") return {};
      const list = canonicalSubjects(subjectEmails);
      if (
        list.sha256 !== plan.subjectsSha256 ||
        list.count !== plan.subjectCount
      )
        throw new Refusal(
          "subjects-list-mismatch",
          "The test-account list secret is not the list approved by subjects_sha256",
        );
      return { STILL_OPERATION_SUBJECT_HASHES: JSON.stringify(list.hashes) };
    },
    closes: (op) =>
      op.policyMode === "enable"
        ? ["subject_not_enabled", "subjects_unlisted_enabled"]
        : ["subjects_enabled"],
    wrote(op, line, receipt) {
      const keys =
        op.policyMode === "enable"
          ? ["listed", "admitted", "changed", "removed"]
          : ["disabled", "members"];
      const result = parseOutcome(line, keys);
      if (!result || !keys.every((k) => count(result[k]))) {
        receipt.warnings.push("result-unreadable");
        return {
          outcome: "warning",
          detail: "written; the result counts were unreadable",
        };
      }
      receipt.result = result;
      return {
        outcome: "ok",
        detail:
          op.policyMode === "enable"
            ? `${result.admitted} of ${result.listed} approved account(s) admitted; ${result.changed} membership(s) switched on; ${result.removed} unlisted membership(s) switched off (none deleted)`
            : `${result.disabled} membership(s) switched off; ${result.members} kept (none deleted)`,
      };
    },
    refusals: Object.freeze({
      QS000: "operator-role-required",
      QS001: "subject-input-invalid",
      QS002: "account-unresolved",
      QS003: "account-ambiguous",
      QS004: "account-not-confirmed-or-active",
    }),
    expectedRoleDiff: noRoleChange,
  }),
});

function noExtraInputs(inputs) {
  for (const [name, value] of Object.entries(inputs))
    if (!isBlankText(value))
      throw new Refusal(
        "operation-input-invalid",
        `This operation takes no ${name === "expectedRevision" ? "policy_expected_revision" : "subjects_sha256"}; leave it empty`,
      );
}

/**
 * One-transaction operation: exactly `begin; [select set_config(...) as configured;] do $$ ... $$;
 * select current_setting(outcome); commit;`, with only the allowed `\getenv` lines, inserts and
 * updates only into `writes`, reads only from `reads` and `writes`, no other role, no DDL or
 * privilege change, no dynamic SQL, no delete and never the production environment.
 */
function assertTransactionScope(
  sql,
  op,
  { getenv, writes, reads, updates, required },
) {
  const fail = (why) => {
    throw new Refusal("operation-scope", `The operation SQL ${why}`);
  };
  const text = stripComments(sql);
  const lines = text.split("\n").map((l) => l.trim());
  const meta = lines.filter((l) => l.startsWith("\\"));
  const expectedMeta = getenv.map(
    (name) => `\\getenv ${name.toLowerCase()} ${name.toLowerCase()}`,
  );
  if (
    canonical(meta.map((l) => l.replace(/\s+/g, " "))) !==
    canonical(expectedMeta)
  )
    fail("has psql commands other than the reviewed \\getenv inputs");
  const flat = lines
    .filter((l) => !l.startsWith("\\"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const configured = getenv.length
    ? `select ${getenv
        .map(
          (name) =>
            `pg_catalog.set_config('still_operation.${name.toLowerCase().replace(/^still_operation_/, "")}', :'${name.toLowerCase()}', true) is not null`,
        )
        .join(" and ")} as configured; `
    : "";
  const prefix = `begin; ${configured}do $$ `;
  const suffix =
    " $$; select pg_catalog.current_setting('still_operation.outcome'); commit;";
  if (!flat.startsWith(prefix) || !flat.endsWith(suffix))
    fail("is not one transaction of the reviewed shape");
  const body = flat.slice(prefix.length, flat.length - suffix.length);
  if (/\$[a-z_]*\$/.test(body)) fail("nests another quoted body");
  const forbidden =
    /\b(delete|truncate|drop|alter|grant|revoke|create|copy|execute|call|dblink\w*|lo_\w+|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|security|reset|vacuum|notify|listen|comment|production)\b|\bset\s+(role|session|local)\b/;
  const hit = forbidden.exec(body);
  if (hit) fail(`uses ${hit[0]}, which this kind may never do`);
  const role = /\bstill_(?!operation\b)[a-z0-9_]+/.exec(body);
  if (role) fail(`names role ${role[0]}; this kind touches no role`);
  for (const m of body.matchAll(
    /\binsert into ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/g,
  ))
    if (!writes.includes(m[1])) fail(`writes to ${m[1]}`);
  for (const m of body.matchAll(/\bupdate\s+(?!set\b)([a-z_][a-z0-9_.]*)/g))
    if (!updates || !writes.includes(m[1])) fail(`updates ${m[1]}`);
  if (!updates && /\bdo update\b/.test(body)) fail("updates an existing row");
  for (const m of body.matchAll(
    /\b(?:from|join)\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b(?!\s*\()/g,
  ))
    if (!reads.includes(m[1]) && !writes.includes(m[1]))
      fail(`reads from ${m[1]}`);
  for (const literal of required)
    if (!body.includes(literal)) fail(`does not name ${literal}`);
  return [body];
}

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
  policyMode = "",
  expectedRevision = "",
  subjectsSha256 = "",
  mode = "plan-only",
  migrations = "",
  functions = "",
  mainRef = "HEAD",
  registry = OPERATIONS,
}) {
  // A workflow choice plus its policy_mode selects one registry row; a registry name is taken as
  // itself only without a mode.
  const name = Object.hasOwn(WORKFLOW_OPERATIONS, operation ?? "")
    ? resolveOperation(operation, policyMode)
    : isBlankText(policyMode) || policyMode === NO_POLICY_MODE
      ? operation
      : resolveOperation(operation, policyMode);
  const op = operationNamed(name, registry);
  const fields = KINDS[op.kind].inputs(op, {
    expectedRevision,
    subjectsSha256,
  });
  if (mode === "apply" && op.provisional?.length)
    throw new Refusal(
      "operation-provisional",
      `${name} still carries provisional content and cannot be applied: ${op.provisional.join("; ")}`,
    );
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
      `${op.requiresMigration} (which the operation needs) is not at that commit`,
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
    operation: name,
    operationKind: op.kind,
    ...fields,
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
    recovery:
      op.kind !== ROLE_LOGIN
        ? `safe to repeat (once the end state holds it reports no change and writes nothing); to undo, run ${op.counterpart}${op.cutoff ? " (the sandbox paid cutoff stays: it is write-once)" : ""}`
        : op.login
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
    !KINDS[op.kind].pinned(plan, op) ||
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

/**
 * Runs the operation SQL. A login switch's statements autocommit one by one (ALTER commits before
 * the close); the other kinds wrap themselves in one transaction. `vars` reach psql only through
 * its environment (the SQL reads them with \getenv), never through argv.
 */
export async function runOperationSql({
  exec,
  conn,
  target,
  file,
  cwd,
  vars = {},
}) {
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
    { cwd, env: { ...pgEnv(conn, target), ...vars } },
  );
  const lines = String(result.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    code: result.code,
    last: lines.at(-1) ?? "",
    // A deliberate refusal raises a fixed Q-class SQLSTATE; the message never carries data.
    refusal:
      result.code === 0
        ? null
        : (/(?:ERROR|FATAL):\s+(Q[A-Z][0-9]{3})\b/.exec(
            String(result.stderr),
          )?.[1] ?? null),
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
export function recoveryText(
  op,
  name,
  situation,
  sideFailed = [],
  reason = "",
) {
  if (op.kind !== ROLE_LOGIN)
    return transactionRecovery(op, situation, sideFailed, reason);
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

/** Recovery for a one-transaction operation: a failure commits all of it or none of it. */
function transactionRecovery(op, situation, sideFailed, reason) {
  switch (situation) {
    case "write-attempted":
      return `The change runs in one transaction, so all of it or none of it was committed. Run ${op.run} again: it reads the state first and reports no change if the earlier run committed. Last resort: ${op.lastResort}.`;
    case "refused-in-transaction":
      return `Nothing was written: the database refused the change inside its transaction (${reason}). Check the state and the inputs, then plan and approve again.`;
    case "end-state-missed": {
      let text =
        `End state NOT reached: do not assume ${op.effect}. Run ${op.run} again (safe to repeat); ` +
        "if the checks still fail, run the runbook's read-only checks privately.";
      if (sideFailed.length)
        text += ` Separately, a side check failed (${sideFailed.join(", ")}): inspect role settings and migration history privately (Supabase SQL editor).`;
      return text;
    }
    case "side-check-failed":
      return (
        `End state verified: ${op.effect}. But a separate check failed (${sideFailed.join(", ")}): ` +
        "a role setting or migration history changed during the run, possibly unrelated activity. " +
        `Do not run ${op.run} again to fix that, and do not undo it because of it; inspect role settings and migration history privately (Supabase SQL editor) and decide.`
      );
    case "verified":
      return `none needed; to undo, run ${op.counterpart}${op.cutoff ? " (the sandbox paid cutoff stays: it is write-once)" : ""}${op.verifiedNote ? `. ${op.verifiedNote}` : ""}`;
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
  // qa-sandbox-subjects enable only: the approved list (JSON) from the environment secret. It
  // stays in memory: only its per-email SHA-256 values reach psql, through the environment.
  subjectEmails,
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
  const read = (file, vars) =>
    runReadOnlySql({ exec, conn, target, cwd, file, vars });
  let vars = {};
  const check = async () =>
    issueList(await read(join(dir, plan.verification.path), vars));
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
    if (target === "production" && op.provisional?.length) {
      await step(
        "content approved for production",
        "refused",
        `still provisional: ${op.provisional.join("; ")}`,
      );
      throw new Refusal("operation-provisional");
    }
    vars = KINDS[op.kind].vars(plan, { subjectEmails });

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
    if (
      error instanceof Refusal &&
      error.category === "operation-precondition" &&
      op?.preconditionRecovery
    )
      receipt.recovery = op.preconditionRecovery;
    if (error instanceof Refusal && error.message !== error.category)
      log(error.message);
    await onProgress(receipt);
    return receipt;
  }

  receipt.writeAttempted = true;
  const name = runName(plan.operation, registry);
  receipt.recovery = recoveryText(op, name, "write-attempted");
  await onProgress(receipt);
  const ran = await runOperationSql({
    exec,
    conn,
    target,
    cwd,
    file: join(dir, plan.sql.path),
    vars,
  });
  if (ran.code !== 0) {
    receipt.status = "stopped";
    receipt.issues.push("operation-failed");
    const refused = KINDS[op.kind].refusals[ran.refusal ?? ""];
    if (refused) {
      // A deliberate refusal inside the one transaction: nothing was committed.
      receipt.issues.push(`operation-refused:${refused}`);
      receipt.recovery = recoveryText(
        op,
        name,
        "refused-in-transaction",
        [],
        refused,
      );
    }
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
  const wrote = KINDS[op.kind].wrote(op, ran.last, receipt);
  await step(plan.operation, wrote.outcome, wrote.detail);

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

  const rolesStep =
    op.kind === ROLE_LOGIN
      ? "only the writer's login changed (every other role and setting untouched)"
      : "no role changed (every role and setting untouched)";
  try {
    const factsAfter = await roleFacts();
    const diff = diffFacts(factsBefore, factsAfter);
    const expected = expectedRoleDiff(op, factsBefore);
    if (canonical(diff) !== canonical(expected)) {
      receipt.issues.push("other-roles-changed");
      await step(
        rolesStep,
        "failed",
        raw
          ? `removed ${diff.removed.join("; ")} | added ${diff.added.join("; ")}`
          : `${diff.removed.length} fact(s) removed, ${diff.added.length} added; expected ${expected.removed.length} and ${expected.added.length} (facts not printed)`,
      );
    } else
      await step(rolesStep, "ok", `${factsAfter.length} role facts compared`);
  } catch (error) {
    receipt.issues.push("role-facts-error");
    await step(rolesStep, "failed", publicError(error));
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
      name,
      endStateReached ? "side-check-failed" : "end-state-missed",
      sideFailed,
    );
  } else {
    receipt.status = "verified";
    receipt.recovery = recoveryText(op, name, "verified");
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
  if (op.kind !== ROLE_LOGIN) {
    const shared = {
      exec,
      plan,
      op,
      dir,
      conn,
      cwd,
      log,
      registry,
      prove,
      proofs,
      sql,
      loginEnv,
      snapshot,
    };
    return op.kind === QA_SALES_POLICY
      ? replaySalesPolicy(shared)
      : replaySubjects(shared);
  }

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

// ── Rehearsal of the one-transaction kinds ─────────────────────────────────────────────────────

/** A plan for the same kind in another mode or at another revision (rehearsal follow-ups only). */
export function derivePolicyPlan(plan, mode, expected, registry = OPERATIONS) {
  const name = WORKFLOW_OPERATIONS["qa-sandbox-sales-policy"][mode];
  const op = operationNamed(name, registry);
  const { cutoff: _cutoff, ...rest } = plan;
  return {
    ...rest,
    operation: name,
    sql: { ...op.sql },
    verification: { ...op.verification },
    ...KINDS[QA_SALES_POLICY].inputs(op, {
      expectedRevision: String(expected),
    }),
  };
}

function deriveSubjectsPlan(plan, mode, subjectsSha256, registry = OPERATIONS) {
  const name = WORKFLOW_OPERATIONS["qa-sandbox-subjects"][mode];
  const op = operationNamed(name, registry);
  const { subjectsSha256: _bound, subjectCount: _count, ...rest } = plan;
  return {
    ...rest,
    operation: name,
    sql: { ...op.sql },
    verification: { ...op.verification },
    ...KINDS[QA_SUBJECTS].inputs(op, {
      subjectsSha256: mode === "enable" ? subjectsSha256 : "",
    }),
  };
}

/** Tables whose fingerprint changed between two data snapshots ("schema.table | ..." lines). */
const changedTables = (before, after) => {
  const table = (line) => String(line).split(" | ")[0];
  const a = new Map(before.map((l) => [table(l), l]));
  const b = new Map(after.map((l) => [table(l), l]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((t) => a.get(t) !== b.get(t))
    .sort();
};

const sameList = (a, b) => canonical(a) === canonical(b);

/**
 * Sales-policy rehearsal: seeds a production sales revision that must stay untouched and, for an
 * expected revision N > 0, sandbox revisions 1..N (the last in the opposite mode, so the run has
 * work to do). Negative controls first (each must write nothing): a stale expected revision, a body
 * other than the approved one (a production body), and an invalid revision input. Then the exact
 * production code path, and proofs: production rows unchanged, no production cutoff, sandbox rows
 * only appended, one ledger row for the fixed operator, the policy reader returns exactly the
 * approved body, the cutoff written only by `on` and only when absent, no role/catalog/history
 * change, only the policy tables changed, and a repeat writes nothing.
 */
async function replaySalesPolicy({
  exec,
  plan,
  op,
  dir,
  conn,
  cwd,
  log,
  registry,
  prove,
  proofs,
  sql,
  loginEnv,
  snapshot,
}) {
  const target = "local-replay";
  const run = (p) =>
    runOperation({ exec, plan: p, dir, conn, target, cwd, log, registry });
  const e = plan.expectedRevision;
  const seed = async (environment, revision, template) => {
    const body = renderSalesBody({ ...template, environment }, revision);
    await sql(
      "with op as (insert into private.product_policy_operations (operation_id, kind, namespace, environment, " +
        "owner_subject, expected_revision, body, preview_hash, created_at, expires_at, status, applied_revision, applied_at) " +
        `values (pg_catalog.gen_random_uuid(), 'apply', 'sales', '${environment}', '${PROTECTED_OPERATOR_SUBJECT}', ${revision - 1}, ` +
        `'${body}', pg_catalog.repeat('0', 64), pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), 'applied', ${revision}, ` +
        "pg_catalog.clock_timestamp()) returning operation_id) insert into private.product_policy_revisions (namespace, " +
        `environment, revision, body, operation_id, published_at) select 'sales', '${environment}', ${revision}, '${body}', ` +
        "op.operation_id, pg_catalog.clock_timestamp() from op",
    );
    return body;
  };
  const facts = async () =>
    JSON.parse(
      await sql(
        "select pg_catalog.json_build_object(" +
          "'production', (select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object('n', namespace, 'r', revision, 'b', pg_catalog.md5(body), 'o', operation_id) order by namespace, revision), '[]') from private.product_policy_revisions where environment = 'production'), " +
          "'productionCutoffs', (select pg_catalog.count(*) from private.paid_cutoff where environment = 'production'), " +
          "'sandbox', (select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object('n', namespace, 'r', revision, 'b', pg_catalog.md5(body), 'o', operation_id) order by namespace, revision), '[]') from private.product_policy_revisions where environment = 'sandbox'), " +
          "'sandboxCutoffs', (select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object('p', product, 'b', benefits, 'r', sales_revision, 'o', operation_id)), '[]') from private.paid_cutoff where environment = 'sandbox'), " +
          `'operatorRows', (select pg_catalog.count(*) from private.product_policy_operations where owner_subject = '${PROTECTED_OPERATOR_SUBJECT}' and status = 'applied'), ` +
          "'ledgerRows', (select pg_catalog.count(*) from private.product_policy_operations))::text",
        { readOnly: true },
      ),
    );
  const readerSees = async () => {
    const result = await exec(
      "psql",
      [
        "-X",
        "-q",
        "-A",
        "-t",
        "-c",
        "select private.read_product_policy('sales', 'sandbox')",
      ],
      { cwd, env: loginEnv("still_policy_reader") },
    );
    return result.code === 0 ? String(result.stdout).trim() : null;
  };

  // Starting state, rehearsal only.
  await seed("production", 1, {
    ...QA_SANDBOX_SALES_TEMPLATES.off,
    builds: [],
  });
  const opposite = op.policyMode === "on" ? "off" : "on";
  for (let r = 1; r <= e; r++) {
    await seed(
      "sandbox",
      r,
      QA_SANDBOX_SALES_TEMPLATES[r === e ? opposite : "off"],
    );
    if (r === e && opposite === "on")
      await sql(
        "insert into private.paid_cutoff (environment, product, benefits, sales_revision, operation_id, activated_at) " +
          `select 'sandbox', '${QA_SANDBOX_CUTOFF.product}', array[${QA_SANDBOX_CUTOFF.benefits.map((b) => `'${b}'`).join(", ")}], ${r}, ` +
          `operation_id, pg_catalog.clock_timestamp() from private.product_policy_revisions where environment = 'sandbox' and revision = ${r}`,
      );
  }
  await sql(
    `alter role still_policy_reader login password '${loginEnv("still_policy_reader").PGPASSWORD}'`,
  );

  const start = await snapshot();
  const startFacts = await facts();

  // Negative controls: each must be refused and write nothing.
  const stale = await run(
    derivePolicyPlan(plan, op.policyMode, e + 1, registry),
  );
  prove(
    "negative control: a stale expected revision is refused inside the transaction",
    stale.status === "stopped" &&
      stale.issues.includes("operation-refused:stale-expected-revision"),
    stale.issues.join(", ") || stale.status,
  );
  const direct = async (expected, body) =>
    runOperationSql({
      exec,
      conn,
      target,
      cwd,
      file: join(dir, plan.sql.path),
      vars: {
        STILL_OPERATION_EXPECTED_REVISION: expected,
        STILL_OPERATION_POLICY_BODY: body,
      },
    });
  const productionBody = renderSalesBody(
    { ...op.template, environment: "production" },
    e + 1,
  );
  const wrongBody = await direct(String(e), productionBody);
  prove(
    "negative control: a body other than the approved one (here a production body) is refused",
    wrongBody.code !== 0 && wrongBody.refusal === "QP003",
    wrongBody.refusal ?? `exit ${wrongBody.code}`,
  );
  const badInput = await direct("-1", plan.body);
  prove(
    "negative control: an invalid expected revision is refused",
    badInput.code !== 0 && badInput.refusal === "QP005",
    badInput.refusal ?? `exit ${badInput.code}`,
  );
  prove(
    "the negative controls wrote nothing",
    sameList(await snapshot(), start) && sameList(await facts(), startFacts),
  );

  const receipt = await run(plan);
  prove(
    "the exact production code path verified the operation",
    receipt.status === "verified",
    receipt.status,
  );
  const after = await snapshot();
  const afterFacts = await facts();
  prove(
    "production sales and rating revisions unchanged",
    sameList(afterFacts.production, startFacts.production) &&
      startFacts.production.length === 1,
    `${afterFacts.production.length} production revision(s)`,
  );
  prove(
    "no production paid cutoff exists",
    afterFacts.productionCutoffs === 0,
    `${afterFacts.productionCutoffs}`,
  );
  const newRows = afterFacts.sandbox.slice(startFacts.sandbox.length);
  prove(
    "sandbox revisions only appended: every earlier row unchanged and exactly one new revision",
    sameList(
      afterFacts.sandbox.slice(0, startFacts.sandbox.length),
      startFacts.sandbox,
    ) &&
      newRows.length === 1 &&
      newRows[0].n === "sales" &&
      newRows[0].r === e + 1,
    `${startFacts.sandbox.length} -> ${afterFacts.sandbox.length}`,
  );
  prove(
    "one ledger row recorded for the fixed protected-workflow operator",
    afterFacts.ledgerRows === startFacts.ledgerRows + 1 &&
      afterFacts.operatorRows === startFacts.operatorRows + 1,
  );
  const served = await readerSees();
  prove(
    "the policy reader (the qa-sandbox-product-policy route's login) reads exactly the approved body",
    served === plan.body,
    served === null ? "read failed" : `${served.length} bytes`,
  );
  const cutoffWanted =
    op.policyMode === "on" && startFacts.sandboxCutoffs.length === 0;
  prove(
    cutoffWanted
      ? "the sandbox paid cutoff was written once, with the pinned content, at the new revision"
      : "the sandbox paid cutoff is unchanged",
    cutoffWanted
      ? afterFacts.sandboxCutoffs.length === 1 &&
          afterFacts.sandboxCutoffs[0].p === QA_SANDBOX_CUTOFF.product &&
          sameList(afterFacts.sandboxCutoffs[0].b, [
            ...QA_SANDBOX_CUTOFF.benefits,
          ]) &&
          afterFacts.sandboxCutoffs[0].r === e + 1
      : sameList(afterFacts.sandboxCutoffs, startFacts.sandboxCutoffs),
    `${afterFacts.sandboxCutoffs.length} sandbox cutoff(s)`,
  );
  const roleDiff = diffFacts(start.roles, after.roles);
  prove(
    "no role changed",
    roleDiff.removed.length === 0 && roleDiff.added.length === 0,
  );
  const catalogDiff = diffFacts(start.catalog, after.catalog);
  prove(
    "grants, functions, policies and migration history unchanged",
    catalogDiff.removed.length === 0 && catalogDiff.added.length === 0,
    `${catalogDiff.removed.length} removed, ${catalogDiff.added.length} added`,
  );
  const allowed = [
    "private.product_policy_operations",
    "private.product_policy_revisions",
    ...(cutoffWanted ? ["private.paid_cutoff"] : []),
  ];
  const touched = changedTables(start.data, after.data);
  prove(
    "only the policy ledger and revisions (and, for the first on, the cutoff) changed",
    sameList(touched, [...allowed].sort()),
    touched.join(", ") || "none",
  );
  prove(
    "nothing added to migration history",
    sameList(start.history, after.history),
  );

  const repeat = await run(plan);
  prove(
    `repeating the operation reports ${op.noChange} and writes nothing`,
    repeat.status === "no-change" &&
      repeat.outcome === op.noChange &&
      !repeat.writeAttempted,
    repeat.status,
  );
  prove(
    "the repeat changed nothing at all",
    sameList(await snapshot(), after) && sameList(await facts(), afterFacts),
  );

  if (op.policyMode === "on") {
    // Off, then on again: the cutoff is never written a second time.
    const off = await run(derivePolicyPlan(plan, "off", e + 1, registry));
    const onAgain = await run(derivePolicyPlan(plan, "on", e + 2, registry));
    const later = await facts();
    prove(
      "switching off and on again publishes two more revisions and never rewrites the cutoff",
      off.status === "verified" &&
        onAgain.status === "verified" &&
        onAgain.result?.cutoff === "present" &&
        later.sandbox.length === afterFacts.sandbox.length + 2 &&
        sameList(later.sandboxCutoffs, afterFacts.sandboxCutoffs),
      `${off.status}, ${onAgain.status}, cutoff ${onAgain.result?.cutoff ?? "unknown"}`,
    );
  }
  return {
    kind: "operation",
    status: proofs.every((p) => p.ok) ? "verified" : "rehearsal-failed",
    receipt,
    repeat,
    proofs,
    roleDiff,
  };
}

/** Synthetic accounts for the subjects rehearsal (throwaway database only; never real people). */
const REHEARSAL_ACCOUNTS = Object.freeze({
  listed: Object.freeze([
    [
      "e1000000-0000-4000-8000-000000000001",
      "qa-rehearsal-listed-1@example.invalid",
    ],
    [
      "e1000000-0000-4000-8000-000000000002",
      "qa-rehearsal-listed-2@example.invalid",
    ],
    [
      "e1000000-0000-4000-8000-000000000003",
      "qa-rehearsal-listed-3@example.invalid",
    ],
  ]),
  nonMember: Object.freeze([
    "e1000000-0000-4000-8000-000000000004",
    "qa-rehearsal-free@example.invalid",
  ]),
  unconfirmed: Object.freeze([
    "e1000000-0000-4000-8000-000000000005",
    "qa-rehearsal-unconfirmed@example.invalid",
  ]),
});

/**
 * Subjects rehearsal on synthetic accounts (three listed, one confirmed non-member, one
 * unconfirmed). Negative controls first (each must write nothing): the approved list hash not
 * matching the list, an unknown account, an unconfirmed account and malformed input, at the plan
 * check and inside the SQL. Then the exact production code path; proofs: listed accounts admitted
 * (a new row, a re-enabled row, an already-enabled row left alone), non-members still absent, no
 * Auth row or role changed, only the membership table changed, a repeat writes nothing; then
 * disable keeps every row and switches every membership off, and its repeat writes nothing.
 */
async function replaySubjects({
  exec,
  plan,
  op,
  dir,
  conn,
  cwd,
  log,
  registry,
  prove,
  proofs,
  sql,
  snapshot,
}) {
  const target = "local-replay";
  const run = (p, subjectEmails) =>
    runOperation({
      exec,
      plan: p,
      dir,
      conn,
      target,
      cwd,
      log,
      registry,
      subjectEmails,
    });
  const { listed, nonMember, unconfirmed } = REHEARSAL_ACCOUNTS;
  const values = [...listed, nonMember, unconfirmed]
    .map(
      ([id, email]) =>
        `('${id}', '${email}', ${id === unconfirmed[0] ? "null" : "pg_catalog.clock_timestamp()"})`,
    )
    .join(", ");
  await sql(
    `insert into auth.users (id, email, email_confirmed_at) values ${values}`,
  );
  const seedRows = (rows) =>
    sql(
      `insert into private.qa_sandbox_subjects (holder, enabled, revision) values ${rows
        .map(([id, enabled, revision]) => `('${id}', ${enabled}, ${revision})`)
        .join(", ")}`,
    );
  const members = async () =>
    JSON.parse(
      await sql(
        "select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object('h', holder, 'e', enabled, 'r', revision) order by holder), '[]')::text from private.qa_sandbox_subjects",
        { readOnly: true },
      ),
    );
  const authRows = () =>
    sql(
      "select pg_catalog.md5(coalesce(pg_catalog.string_agg(t::text, E'\\n' order by t.id), '')) from auth.users t",
      { readOnly: true },
    );
  // The list secret, salted like the real one (a fresh throwaway salt per rehearsal).
  const salt = randomBytes(16).toString("hex");
  const secretOf = (emails) => JSON.stringify({ salt, emails });
  const bindingOf = (emails) => canonicalSubjects(secretOf(emails)).binding;
  const boundTo = (emails) => {
    const list = canonicalSubjects(secretOf(emails));
    return { ...plan, subjectsSha256: list.sha256, subjectCount: list.count };
  };
  // Mixed case and spacing on purpose: the list is canonicalised before hashing.
  const approvedEmails = [
    ` ${listed[1][1].toUpperCase()} `,
    listed[0][1],
    listed[2][1],
  ];
  const approved = secretOf(approvedEmails);
  const enablePlan =
    op.policyMode === "enable"
      ? boundTo(approvedEmails)
      : deriveSubjectsPlan(plan, "enable", bindingOf(approvedEmails), registry);
  const disablePlan =
    op.policyMode === "disable"
      ? plan
      : deriveSubjectsPlan(plan, "disable", "", registry);

  if (op.policyMode === "enable")
    // A new row, a disabled row to re-enable, an enabled row to leave alone, and an enabled
    // account that is not on the list (it must be switched off, never deleted).
    await seedRows([
      [listed[1][0], false, 2],
      [listed[2][0], true, 1],
      [nonMember[0], true, 4],
    ]);
  else
    await seedRows([
      [listed[0][0], true, 1],
      [listed[1][0], true, 3],
      [nonMember[0], false, 2],
    ]);
  const start = await snapshot();
  const startMembers = await members();
  const startAuth = await authRows();

  if (op.policyMode === "enable") {
    // Negative controls: each must be refused and write nothing.
    const mismatch = await run(plan, approved);
    prove(
      "negative control: a list secret that is not the approved list is refused before any database call",
      mismatch.status === "refused" &&
        mismatch.issues.includes("subjects-list-mismatch"),
      mismatch.issues.join(", "),
    );
    const unsalted = await run(enablePlan, JSON.stringify(approvedEmails));
    prove(
      "negative control: a list secret without a salt is refused before any database call",
      unsalted.status === "refused" &&
        unsalted.issues.includes("subjects-list-invalid"),
      unsalted.issues.join(", "),
    );
    for (const [label, list] of [
      [
        "an unknown account",
        [listed[0][1], "qa-rehearsal-unknown@example.invalid"],
      ],
      ["an unconfirmed account", [listed[0][1], unconfirmed[1]]],
    ]) {
      const refused = await run(boundTo(list), secretOf(list));
      prove(
        `negative control: a list with ${label} is refused before writing`,
        refused.status === "refused" &&
          refused.issues.includes("operation-precondition") &&
          !refused.writeAttempted,
        refused.issues.join(", "),
      );
    }
    const direct = (hashes) =>
      runOperationSql({
        exec,
        conn,
        target,
        cwd,
        file: join(dir, plan.sql.path),
        vars: { STILL_OPERATION_SUBJECT_HASHES: hashes },
      });
    for (const [label, hashes, code] of [
      [
        "an unknown account",
        canonicalSubjects(
          secretOf([listed[0][1], "qa-rehearsal-unknown@example.invalid"]),
        ).hashes,
        "QS002",
      ],
      [
        "an unconfirmed account",
        canonicalSubjects(secretOf([listed[0][1], unconfirmed[1]])).hashes,
        "QS004",
      ],
      ["malformed input", ["not-a-hash"], "QS001"],
    ]) {
      const ran = await direct(JSON.stringify(hashes));
      prove(
        `negative control: the SQL itself refuses ${label}`,
        ran.code !== 0 && ran.refusal === code,
        ran.refusal ?? `exit ${ran.code}`,
      );
    }
    prove(
      "the negative controls wrote nothing",
      sameList(await snapshot(), start) &&
        sameList(await members(), startMembers),
    );
  }

  const enabled = (rows) => rows.filter((r) => r.e).map((r) => r.h);
  let receipt;
  let repeat;
  let after;
  if (op.policyMode === "enable") {
    receipt = await run(enablePlan, approved);
    prove(
      "the exact production code path verified the operation",
      receipt.status === "verified",
      receipt.status,
    );
    after = await snapshot();
    const rows = await members();
    const byHolder = Object.fromEntries(rows.map((r) => [r.h, r]));
    prove(
      "every approved account is admitted: a new row (revision 1), a re-enabled row (revision + 1), an enabled row left alone",
      byHolder[listed[0][0]]?.e === true &&
        byHolder[listed[0][0]]?.r === 1 &&
        byHolder[listed[1][0]]?.e === true &&
        byHolder[listed[1][0]]?.r === 3 &&
        byHolder[listed[2][0]]?.e === true &&
        byHolder[listed[2][0]]?.r === 1,
    );
    prove(
      "the counts match the approved list: 3 listed, 3 admitted, 2 switched on, 1 unlisted switched off",
      canonical(receipt.result) ===
        canonical({ listed: 3, admitted: 3, changed: 2, removed: 1 }),
      JSON.stringify(receipt.result ?? null),
    );
    prove(
      "the enabled set is exactly the list: the unlisted account is switched off (row kept, revision + 1), the unconfirmed one has no membership",
      byHolder[nonMember[0]]?.e === false &&
        byHolder[nonMember[0]]?.r === 5 &&
        !byHolder[unconfirmed[0]] &&
        enabled(rows).length === 3,
    );
    prove("no Auth account changed", (await authRows()) === startAuth);
    repeat = await run(enablePlan, approved);
  } else {
    receipt = await run(disablePlan);
    prove(
      "the exact production code path verified the operation",
      receipt.status === "verified",
      receipt.status,
    );
    after = await snapshot();
    repeat = await run(disablePlan);
  }
  const roleDiff = diffFacts(start.roles, after.roles);
  prove(
    "no role changed",
    roleDiff.removed.length === 0 && roleDiff.added.length === 0,
  );
  const catalogDiff = diffFacts(start.catalog, after.catalog);
  prove(
    "grants, functions, policies and migration history unchanged",
    catalogDiff.removed.length === 0 && catalogDiff.added.length === 0,
  );
  const touched = changedTables(start.data, after.data);
  prove(
    "only the QA membership table changed",
    sameList(touched, ["private.qa_sandbox_subjects"]),
    touched.join(", ") || "none",
  );
  prove(
    "nothing added to migration history",
    sameList(start.history, after.history),
  );
  prove(
    `repeating the operation reports ${op.noChange} and writes nothing`,
    repeat.status === "no-change" &&
      repeat.outcome === op.noChange &&
      !repeat.writeAttempted,
    repeat.status,
  );
  prove("the repeat changed nothing at all", sameList(await snapshot(), after));

  if (op.policyMode === "enable") {
    // Enabling a shorter list drops the others: [A, B, C] then [B] leaves only B enabled.
    const narrowed = [listed[1][1]];
    const narrow = await run(boundTo(narrowed), secretOf(narrowed));
    const rows = await members();
    const byHolder = Object.fromEntries(rows.map((r) => [r.h, r]));
    prove(
      "enabling a shorter list switches the dropped accounts off and keeps their rows",
      narrow.status === "verified" &&
        canonical(narrow.result) ===
          canonical({ listed: 1, admitted: 1, changed: 0, removed: 2 }) &&
        sameList(enabled(rows), [listed[1][0]]) &&
        byHolder[listed[0][0]]?.e === false &&
        byHolder[listed[2][0]]?.e === false &&
        rows.length === 4,
      JSON.stringify(narrow.result ?? null),
    );
  }

  // Disable keeps every row: (after an enable rehearsal this is the follow-up off switch).
  const beforeDisable = await members();
  const disabled =
    op.policyMode === "disable" ? receipt : await run(disablePlan);
  const afterDisable = await members();
  const was = Object.fromEntries(
    (op.policyMode === "disable" ? startMembers : beforeDisable).map((r) => [
      r.h,
      r,
    ]),
  );
  prove(
    "disable switches every membership off, keeps every row and bumps only the enabled rows' revisions",
    disabled.status === "verified" &&
      afterDisable.length === Object.keys(was).length &&
      enabled(afterDisable).length === 0 &&
      afterDisable.every((r) => r.r === was[r.h].r + (was[r.h].e ? 1 : 0)),
    `${afterDisable.length} row(s) kept`,
  );
  return {
    kind: "operation",
    status: proofs.every((p) => p.ok) ? "verified" : "rehearsal-failed",
    receipt,
    repeat,
    proofs,
    roleDiff,
  };
}

// ── Rendering (public, privacy-safe) ───────────────────────────────────────────────────────────

const STEP_ICON = { ok: "✅", warning: "⚠️" };
const renderSteps = (steps) =>
  steps.map(
    (s) =>
      `- ${STEP_ICON[s.outcome] ?? "❌"} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`,
  );
const fence = (text) => text.replace(/```/g, "``​`");

/** The kind-specific lines of a plan: the exact inputs the owner approves (no secret ever). */
function renderPlanInputs(plan) {
  const lines = [];
  if (plan.provisional?.length)
    lines.push(
      "- ⚠️ **Provisional content: plan-only.** Apply is refused until a reviewed change settles it:",
      ...plan.provisional.map((reason) => `  - ${reason}`),
    );
  if (plan.operationKind === QA_SALES_POLICY)
    lines.push(
      `- Sandbox sales revision: compare-and-set from \`${plan.expectedRevision}\` to \`${plan.policyRevision}\` (environment fixed to \`sandbox\`; production is never named).`,
      `- Exact body published (SHA-256 \`${plan.bodySha256}\`):`,
      "",
      "```json",
      fence(plan.body),
      "```",
      plan.cutoff
        ? `- First \`on\` only, and only if the sandbox has none: write-once sandbox paid cutoff \`${plan.cutoff.product}\` with \`${plan.cutoff.benefits.join(", ")}\`.`
        : "- The sandbox paid cutoff is not written.",
    );
  if (plan.operationKind === QA_SUBJECTS)
    lines.push(
      plan.policyMode === "enable"
        ? `- Approved test-account list: **${plan.subjectCount} account(s)**, salted SHA-256 \`${plan.subjectsSha256}\`. Check the count against the designated QA accounts file: the list must be built only from that file (enable cannot tell a mistyped real customer's email from a test account). The list stays in the protected environment secret and is checked against this value before any database call; every other enabled membership is switched off (never deleted); no email, hash or id is printed.`
        : "- Every enabled QA membership is switched off; no row is deleted; no account list is needed.",
    );
  return lines.length ? [...lines, ""] : [];
}

export function renderOperationPlan(plan) {
  return [
    `## Supabase production operation plan: \`${plan.operation}\``,
    "",
    ...renderPlanInputs(plan),
    `- Commit: \`${plan.revision}\` (on main; workflow from \`${plan.workflowRevision}\`)`,
    `- Plan digest: \`${plan.digest}\``,
    `- Approval environment: \`${plan.environment}\` (owner approval required before any secret is available)`,
    "- This is an operation, not a migration: nothing is added to migration history, and no migration or function runs with it.",
    `- End state the job verifies: ${plan.effect}.`,
    plan.operationKind === ROLE_LOGIN
      ? `- Untouched, and checked: every other role, including the other function roles ${plan.untouchedRoles.join(", ")}.`
      : `- Untouched, and checked: every role, including the function roles ${plan.untouchedRoles.join(", ")}; the SQL runs in one transaction, so a refusal writes nothing.`,
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
    const again = runName(receipt.operation);
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

/** True when `name` is a workflow operation choice (not migrations or the QA function deploy). */
export const isKnownOperation = (name) =>
  typeof name === "string" && Object.hasOwn(WORKFLOW_OPERATIONS, name);
