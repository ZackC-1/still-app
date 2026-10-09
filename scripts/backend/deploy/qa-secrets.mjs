// One protected operation: install the sandbox QA function secrets and the three database sign-ins
// they need. Modes:
//
//   plan-only  offline: bind the pinned SQL by hash and list every secret name the run may touch.
//   apply      first install. Generate a password in runner memory for each of still_policy_reader,
//              still_settings_writer and still_qa_sandbox_writer that has neither LOGIN nor its
//              URL secret, write the URL secret, then set LOGIN with a SCRAM-SHA-256 verifier.
//              Copy each staged QA_STAGE_<SUFFIX> value to STILL_QA_SANDBOX_<SUFFIX>. Never
//              replaces an existing secret: an equal digest reports "unchanged", a different one
//              refuses the whole run before any write. A role that already has LOGIN and its URL
//              secret is "unchanged".
//   rotate     every role gets a new password and URL, and staged values replace existing secrets
//              whose digest differs. The password changes FIRST, then the URL secrets are written:
//              a failed ALTER ROLE leaves everything as it was. If the ALTER succeeds and the write
//              fails, functions using those URLs cannot sign in until rotate is run again; re-running
//              rotate is the documented recovery and is safe (it generates and writes fresh values).
//   disable    still_qa_sandbox_writer NOLOGIN (and close its connections), then delete every
//              STILL_QA_SANDBOX_* secret. The shared PRODUCT_POLICY_READER_DB_URL and
//              SETTINGS_WRITER_DB_URL secrets and roles are kept.
//
// Emergency stops win: apply and rotate refuse (qa-role-paused) when a role is NOLOGIN while its
// URL secret exists, the state pause-settings-sync / pause-qa-sandbox leave behind. Run the matching
// resume operation first; this module never switches LOGIN back on implicitly.
//
// Shared names, plainly: PRODUCT_POLICY_READER_DB_URL and SETTINGS_WRITER_DB_URL are unprefixed and
// are also read by the production product-policy and sync-settings functions. Those functions are
// NOT deployed on hosted Supabase today (live: export-user-data, reconcile-entitlement, delete-user,
// revenuecat-webhook, selector-canary, create-web-checkout, review-signin, analytics-identify), so
// setting them switches nothing on now, but a future production deploy of either function would
// sign in with these URLs and logins.
//
// Limits of the proof: "unchanged" means a URL secret exists and its role has LOGIN; only a digest
// is readable, so this run cannot prove that an existing URL works. The sign-in probe for a new
// password goes through the admin connection's host (the pooler on GitHub runners, user
// "<role>.<ref>"), while functions use the direct host. The later qa-sandbox-functions readiness
// baseline and the post-deploy function probes prove the rest.
//
// Staged values must not have leading or trailing whitespace; a PEM block may end with one newline.
//
// Integration contract (the generalized protected-operation workflow calls this; nothing here
// edits the workflow, operations.mjs or deploy.mjs):
//
//   createQaSecretsPlan({ mode, projectRef, sourceDir, revision? }) -> plan (no secrets, has digest)
//   renderQaSecretsPlan(plan) -> markdown
//   runQaSecretsOperation({ plan, env, platform, cwd, sourceDir, exec?, fetchImpl?, randomBytesImpl?,
//                           sleep?, timeoutMs?, onProgress? }) -> receipt (never throws)
//   renderQaSecretsFinal(receipt | null, { applyOutcome? }) -> markdown closing record
//
//   sourceDir  the exact-commit archive; holds QA_SECRETS_SQL paths and ROLE_FACTS (role-facts.sql).
//   env        GITHUB_ACTIONS, RUNNER_ENVIRONMENT, GITHUB_EVENT_NAME, GITHUB_REF (production context),
//              GITHUB_REPOSITORY, GH_TOKEN, GITHUB_RUN_ID (owner approval read-back),
//              EXPECTED_PLAN_DIGEST, DEPLOY_MODE (must equal plan.mode),
//              SUPABASE_PRODUCTION_PROJECT_REF, SUPABASE_DB_URL (postgres on the protected ref,
//              direct or pooler; checked by assertQaTarget), SUPABASE_QA_SECRETS_ACCESS_TOKEN (a
//              Supabase token with Secrets read+write only), and for apply/rotate the 19
//              QA_STAGE_<SUFFIX> values listed in STAGED_SECRETS (STILL_QA_SANDBOX_<SUFFIX> <-
//              QA_STAGE_<SUFFIX>). Pass the token and QA_STAGE_* values ONLY to this step.
//   onProgress receives a copy of the receipt before every write; persist it so an interrupted run
//              still has a durable "outcome-unknown" record.
//
// Guarantees (each has a test in qa-secrets.test.mjs):
// - the writable names are exactly REQUIRED_SECRETS from qa-functions.mjs; SUPABASE_* names are
//   refused; disable deletes only STILL_QA_SANDBOX_* names;
// - passwords exist only in this process's memory: never printed, logged, written to disk or put
//   in argv. psql receives only a SCRAM-SHA-256 verifier through its environment; the Management
//   API receives the URL as a secret value. Receipts carry names, outcomes and counts only;
// - DB URLs use the direct host db.<ref>.supabase.co:5432 with the exact role name as user,
//   because the QA functions refuse the pooler form "<role>.<ref>";
// - every refusal happens before the first write; writes are never retried; a failure after a
//   write began records "outcome-unknown" with recovery guidance;
// - after writing, GET /secrets must show sha256(value) for every written name and no other
//   change; role-facts.sql must show only the promised LOGIN change (none for a rotate of logged-in
//   roles); a sign-in probe with each new password must succeed.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSamePlan,
  canonical,
  defaultExec,
  diffFacts,
  ENVIRONMENT_NAME,
  failureFacts,
  lintVerificationSql,
  OPERATIONS_DIR,
  parseJsonArray,
  parseDbUrl,
  pgEnv,
  readProtection,
  Refusal,
  requireProductionContext,
  runReadOnlySql,
  sha256,
} from "./deploy.mjs";
import { parseClosedCounts } from "./operations.mjs";
import {
  assertQaTarget,
  REQUIRED_SECRETS,
  secretInventory,
} from "./qa-functions.mjs";

export const QA_SECRETS_OPERATION = "qa-sandbox-secrets";
export const QA_SECRETS_KIND = "supabase-qa-secrets";
export const QA_SECRETS_MODES = Object.freeze([
  "plan-only",
  "apply",
  "rotate",
  "disable",
]);
export const QA_SECRETS_TOKEN_ENV = "SUPABASE_QA_SECRETS_ACCESS_TOKEN";
export const STAGE_PREFIX = "QA_STAGE_";
export const QA_SECRET_PREFIX = "STILL_QA_SANDBOX_";
export const ROLE_FACTS = "scripts/backend/deploy/sql/role-facts.sql";

/** The pinned SQL. Changing a file means changing its hash here in the same reviewed commit. */
export const QA_SECRETS_SQL = Object.freeze({
  login: Object.freeze({
    path: `${OPERATIONS_DIR}/qa-role-login.sql`,
    sha256: "4013b648843946237c860a054b5faf1098ac9ea25923637f4b0cf93acb87d86f",
  }),
  disable: Object.freeze({
    path: `${OPERATIONS_DIR}/qa-role-disable.sql`,
    sha256: "8a21db36ac7e4d9a4473d17aa3f00e9377e4e00fc82e0d5ab98f66ba65deb362",
  }),
  verify: Object.freeze({
    path: `${OPERATIONS_DIR}/qa-role-login.verify.sql`,
    sha256: "86f470214a29f7c88dbdd491855729700058333384e9b4f4a2eb91a48a4a86ff",
  }),
});

/** The three sign-ins. `variable` is the environment name qa-role-login.sql reads with \getenv. */
export const QA_ROLE_LOGINS = Object.freeze([
  Object.freeze({
    role: "still_policy_reader",
    secret: "PRODUCT_POLICY_READER_DB_URL",
    variable: "STILL_QA_POLICY_READER_VERIFIER",
  }),
  Object.freeze({
    role: "still_settings_writer",
    secret: "SETTINGS_WRITER_DB_URL",
    variable: "STILL_QA_SETTINGS_WRITER_VERIFIER",
  }),
  Object.freeze({
    role: "still_qa_sandbox_writer",
    secret: "STILL_QA_SANDBOX_ENTITLEMENT_WRITER_DB_URL",
    variable: "STILL_QA_WRITER_VERIFIER",
  }),
]);
const QA_WRITER = "still_qa_sandbox_writer";
const GENERATED = new Set(QA_ROLE_LOGINS.map((item) => item.secret));

/** Provider values staged as write-only GitHub environment secrets: name <- env `from`. */
export const STAGED_SECRETS = Object.freeze(
  REQUIRED_SECRETS.filter((name) => !GENERATED.has(name)).map((name) => {
    if (!name.startsWith(QA_SECRET_PREFIX)) {
      throw new Error(`${name} is neither generated nor a QA-prefixed secret`);
    }
    return Object.freeze({
      name,
      from: `${STAGE_PREFIX}${name.slice(QA_SECRET_PREFIX.length)}`,
    });
  }),
);
/** Disable removes only these. */
export const DISABLE_SECRETS = Object.freeze(
  REQUIRED_SECRETS.filter((name) => name.startsWith(QA_SECRET_PREFIX)),
);
for (const name of REQUIRED_SECRETS) {
  if (/^SUPABASE_/i.test(name)) throw new Error(`${name} is platform-reserved`);
}
for (const { secret } of QA_ROLE_LOGINS) {
  if (!REQUIRED_SECRETS.includes(secret)) {
    throw new Error(`${secret} is not a required QA secret`);
  }
}

const refuse = (category, names) => {
  const error = new Refusal(category);
  if (names?.length) error.names = [...names].sort();
  throw error;
};
const validRef = (ref) => /^[a-z]{20}$/.test(ref ?? "");
const PASSWORD = /^[a-f0-9]{64}$/;
export const SCRAM_VERIFIER =
  /^SCRAM-SHA-256\$([1-9][0-9]{3,6}):([A-Za-z0-9+/]{22,}={0,2})\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$/;

/** Refuses any name outside the allowlist; `remove` further limits it to QA-prefixed names. */
export function assertWritableName(name, { remove = false } = {}) {
  if (
    typeof name !== "string" ||
    /^SUPABASE_/i.test(name) ||
    !REQUIRED_SECRETS.includes(name) ||
    (remove && !name.startsWith(QA_SECRET_PREFIX))
  ) {
    refuse("qa-secrets-name-refused");
  }
}

// ── SCRAM-SHA-256 (RFC 5802 / RFC 7677; PostgreSQL's stored verifier format) ──────────────────

const hmac = (key, text) => createHmac("sha256", key).update(text).digest();

/** The keys a SCRAM-SHA-256 verifier stores. Exported for the RFC 7677 test vector. */
export function scramKeys(password, salt, iterations = 4096) {
  // Printable ASCII only, so SASLprep (which PostgreSQL applies) leaves the password unchanged.
  if (typeof password !== "string" || !/^[\x21-\x7e]{1,1024}$/.test(password)) {
    refuse("qa-password-invalid");
  }
  if (!Buffer.isBuffer(salt) || salt.length < 16) refuse("qa-password-invalid");
  if (!Number.isInteger(iterations) || iterations < 4096) {
    refuse("qa-password-invalid");
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = hmac(salted, "Client Key");
  return {
    clientKey,
    storedKey: createHash("sha256").update(clientKey).digest(),
    serverKey: hmac(salted, "Server Key"),
  };
}

/** "SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>", all base64. */
export function scramSha256Verifier(
  password,
  { salt = randomBytes(16), iterations = 4096 } = {},
) {
  const { storedKey, serverKey } = scramKeys(password, salt, iterations);
  const verifier =
    `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$` +
    `${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
  if (!SCRAM_VERIFIER.test(verifier)) refuse("qa-password-invalid");
  return verifier;
}

/** 32 random bytes as hex: URL-safe, so the DB URL needs no encoding. */
export function generatePassword(randomBytesImpl = randomBytes) {
  const password = Buffer.from(randomBytesImpl(32)).toString("hex");
  if (!PASSWORD.test(password)) refuse("qa-password-invalid");
  return password;
}

/** Direct host and exact role name: the QA functions refuse the pooler user "<role>.<ref>". */
export function roleDbUrl(projectRef, role, password) {
  if (
    !validRef(projectRef) ||
    !QA_ROLE_LOGINS.some((item) => item.role === role) ||
    !PASSWORD.test(password ?? "")
  ) {
    refuse("qa-secrets-url-invalid");
  }
  const url = `postgresql://${role}:${password}@db.${projectRef}.supabase.co:5432/postgres?sslmode=require`;
  const conn = parseDbUrl(url);
  if (
    conn.user !== role ||
    conn.password !== password ||
    conn.host !== `db.${projectRef}.supabase.co` ||
    conn.port !== "5432" ||
    conn.database !== "postgres" ||
    conn.sslmode !== "require"
  ) {
    refuse("qa-secrets-url-invalid");
  }
  return url;
}

// ── Plan (offline; no secrets) ────────────────────────────────────────────────────────────────

async function boundFiles(sourceDir, { pinnedOnly = false } = {}) {
  if (!sourceDir) refuse("qa-secrets-source-missing");
  const files = [];
  const entries = [
    ...Object.values(QA_SECRETS_SQL),
    ...(pinnedOnly ? [] : [{ path: ROLE_FACTS, sha256: null }]),
  ];
  for (const pin of entries) {
    let bytes;
    try {
      bytes = await readFile(join(sourceDir, pin.path));
    } catch {
      refuse("qa-secrets-sql-missing");
    }
    const digest = sha256(bytes);
    if (pin.sha256 && digest !== pin.sha256) refuse("qa-secrets-sql-unpinned");
    files.push({
      path: pin.path,
      sha256: digest,
      text: bytes.toString("utf8"),
    });
  }
  lintVerificationSql(
    files.find((file) => file.path === QA_SECRETS_SQL.verify.path).text,
  );
  return files;
}

export async function createQaSecretsPlan({
  mode,
  projectRef,
  sourceDir,
  revision = null,
}) {
  if (
    !QA_SECRETS_MODES.includes(mode) ||
    !validRef(projectRef) ||
    (revision !== null && !/^[a-f0-9]{40}$/.test(revision))
  ) {
    refuse("qa-secrets-input-invalid");
  }
  const files = (await boundFiles(sourceDir)).map(({ path, sha256 }) => ({
    path,
    sha256,
  }));
  const manifest = {
    protocol: 1,
    kind: QA_SECRETS_KIND,
    operation: QA_SECRETS_OPERATION,
    environment: ENVIRONMENT_NAME,
    mode,
    projectRef,
    revision,
    files,
    roles: QA_ROLE_LOGINS.map(({ role, secret }) => ({ role, secret })),
    staged: STAGED_SECRETS.map(({ name, from }) => ({ name, from })),
    removable: [...DISABLE_SECRETS],
    recovery:
      "stop; a run that began writing records outcome-unknown; recover with a separately approved rotate or disable; never blindly retry",
  };
  return { ...manifest, digest: sha256(canonical(manifest)) };
}

function assertQaSecretsPlan(plan) {
  if (
    plan?.kind !== QA_SECRETS_KIND ||
    plan.operation !== QA_SECRETS_OPERATION ||
    plan.environment !== ENVIRONMENT_NAME ||
    !["apply", "rotate", "disable"].includes(plan.mode) ||
    !validRef(plan.projectRef)
  ) {
    refuse("qa-secrets-plan-invalid");
  }
  for (const pin of Object.values(QA_SECRETS_SQL)) {
    if (
      !plan.files?.some(
        (file) => file.path === pin.path && file.sha256 === pin.sha256,
      )
    ) {
      refuse("qa-secrets-sql-unpinned");
    }
  }
  if (!plan.files.some((file) => file.path === ROLE_FACTS)) {
    refuse("qa-secrets-plan-invalid");
  }
  // The plan names must be exactly this module's allowlist; a hand-edited plan cannot widen it.
  const expected = canonical({
    roles: QA_ROLE_LOGINS.map(({ role, secret }) => ({ role, secret })),
    staged: STAGED_SECRETS.map(({ name, from }) => ({ name, from })),
    removable: [...DISABLE_SECRETS],
  });
  if (
    canonical({
      roles: plan.roles,
      staged: plan.staged,
      removable: plan.removable,
    }) !== expected
  ) {
    refuse("qa-secrets-plan-invalid");
  }
}

// ── Supabase Management API (bounded; reads may retry, writes never do) ───────────────────────

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function managementApi({
  projectRef,
  token,
  fetchImpl,
  sleep = defaultSleep,
  timeoutMs = 30_000,
}) {
  if (
    !validRef(projectRef) ||
    typeof token !== "string" ||
    !token.trim() ||
    /\s/.test(token)
  ) {
    refuse("qa-secrets-token-missing");
  }
  const url = `https://api.supabase.com/v1/projects/${projectRef}/secrets`;
  const call = (method, body) =>
    fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    /** GET /secrets: names and SHA-256 digests only (validated by secretInventory). */
    async list() {
      for (let attempt = 1; ; attempt++) {
        let response;
        try {
          response = await call("GET");
        } catch {
          if (attempt < 3) {
            await sleep(1000 * attempt);
            continue;
          }
          refuse("qa-secrets-read-failed");
        }
        if (response.ok) {
          let value;
          try {
            value = await response.json();
          } catch {
            refuse("qa-secrets-read-invalid");
          }
          return secretInventory(value);
        }
        await response.body?.cancel?.().catch(() => {});
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < 3
        ) {
          await sleep(1000 * attempt);
          continue;
        }
        refuse("qa-secrets-read-failed");
      }
    },
    /** One POST (upsert) or DELETE. Any failure means the outcome is unknown; never retried. */
    async write(method, body) {
      if (!["POST", "DELETE"].includes(method))
        refuse("qa-secrets-write-invalid");
      let response;
      try {
        response = await call(method, body);
      } catch {
        refuse("qa-secrets-write-outcome-unknown");
      }
      // The body is never read: an error response could echo request content.
      await response.body?.cancel?.().catch(() => {});
      if (!response.ok) refuse("qa-secrets-write-outcome-unknown");
    },
  };
}

// ── Database steps ─────────────────────────────────────────────────────────────────────────────

const ROLE_FACT =
  /^([a-z_]+):(missing|login|nologin|password-(?:scram|other|none|unreadable))$/;

/** Parses qa-role-login.verify.sql output into one state per role; anything else is refused. */
export function parseRoleState(list) {
  if (!Array.isArray(list)) refuse("qa-role-state-invalid");
  const state = new Map(
    QA_ROLE_LOGINS.map(({ role }) => [
      role,
      { exists: true, login: null, password: null },
    ]),
  );
  for (const fact of list) {
    const match = typeof fact === "string" ? ROLE_FACT.exec(fact) : null;
    const item = match && state.get(match[1]);
    if (!item) refuse("qa-role-state-invalid");
    const [, , value] = match;
    if (value === "missing") item.exists = false;
    else if (value === "login" || value === "nologin") {
      if (item.login !== null) refuse("qa-role-state-invalid");
      item.login = value === "login";
    } else {
      if (item.password !== null) refuse("qa-role-state-invalid");
      item.password = value.slice("password-".length);
    }
  }
  for (const item of state.values()) {
    if (
      item.exists
        ? item.login === null || item.password === null
        : item.login !== null || item.password !== null
    ) {
      refuse("qa-role-state-invalid");
    }
  }
  return state;
}

const factList = (line) => {
  const list = parseJsonArray(line, "qa-role-facts-unreadable");
  if (!list.length || list.some((fact) => typeof fact !== "string")) {
    refuse("qa-role-facts-unreadable");
  }
  return list;
};

/** Role facts after the change must equal the facts before with only these logins switched. */
function assertOnlyLoginChanged(before, after, changes) {
  const expected = new Set(before);
  for (const { role, login } of changes) {
    expected.delete(`role ${role} | login ${!login}`);
    expected.add(`role ${role} | login ${login}`);
  }
  const diff = diffFacts([...expected].sort(), [...after].sort());
  if (diff.added.length || diff.removed.length) refuse("qa-role-facts-changed");
}

async function psqlSupportsGetenv(exec, cwd) {
  const result = await exec("psql", ["--version"], { cwd });
  const major = Number(
    /\(PostgreSQL\)\s+(\d+)/.exec(String(result.stdout))?.[1],
  );
  if (result.code !== 0 || !(major >= 15)) refuse("qa-secrets-psql-too-old");
}

async function runPinnedSql({ exec, cwd, conn, file, variables = {}, single }) {
  const result = await exec(
    "psql",
    [
      "-X",
      "-q",
      "-A",
      "-t",
      ...(single ? ["--single-transaction"] : []),
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=sqlstate",
      "-c",
      "set lock_timeout = '10s'",
      "-c",
      "set statement_timeout = '60s'",
      "-f",
      file,
    ],
    // Verifiers travel only in the child's environment, never in argv.
    { cwd, env: { ...pgEnv(conn, "production"), ...variables } },
  );
  const lines = String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    code: result.code,
    last: lines.at(-1) ?? "",
    sqlstate: result.code === 0 ? null : failureFacts(result.stderr).sqlstate,
  };
}

/** Signs in once as `role` with the new password, through the same host as the admin URL. */
async function probeLogin({ exec, cwd, conn, projectRef, role, password }) {
  const direct = conn.host === `db.${projectRef}.supabase.co`;
  const probe = {
    ...conn,
    user: direct ? role : `${role}.${projectRef}`,
    password,
    database: "postgres",
    sslmode: "require",
  };
  const result = await exec(
    "psql",
    ["-X", "-q", "-A", "-t", "-c", "select current_user"],
    {
      cwd,
      env: {
        ...pgEnv(probe, "production"),
        PGAPPNAME: "still-qa-secrets-probe",
      },
    },
  );
  return result.code === 0 && String(result.stdout).trim() === role;
}

// ── Decision (every refusal happens here, before any write) ──────────────────────────────────

function readStaged(env) {
  const known = new Set(STAGED_SECRETS.map((item) => item.from));
  const unexpected = Object.keys(env).filter(
    (key) => key.startsWith(STAGE_PREFIX) && !known.has(key),
  );
  if (unexpected.length) refuse("qa-stage-unexpected", unexpected);
  const values = new Map();
  const missing = [];
  const padded = [];
  for (const { name, from } of STAGED_SECRETS) {
    const value = env[from];
    if (typeof value !== "string" || !value.trim()) missing.push(from);
    else if (!cleanEdges(value)) padded.push(from);
    else values.set(name, value);
  }
  if (missing.length) refuse("qa-stage-value-missing", missing);
  if (padded.length) refuse("qa-stage-value-whitespace", padded);
  return values;
}

const PEM =
  /^-----BEGIN [A-Z0-9 ]+-----\r?\n[\s\S]*\r?\n-----END [A-Z0-9 ]+-----$/;

/** No leading or trailing whitespace, except that a PEM block may end with one newline. */
export function cleanEdges(value) {
  if (value === value.trim()) return true;
  const body = value.replace(/\r?\n$/, "");
  return body === body.trim() && PEM.test(body);
}

function decide(mode, { inventory, roles }, staged) {
  const digest = new Map(inventory.map((item) => [item.name, item.digest]));
  const secrets = [];
  const roleSteps = [];
  const paused = [];
  for (const { role, secret } of QA_ROLE_LOGINS) {
    const state = roles.get(role);
    const present = digest.has(secret);
    if (mode === "disable") {
      // The emergency path never refuses over a missing role; it reports it.
      const off = role === QA_WRITER && state.exists && state.login;
      roleSteps.push({
        role,
        action: !state.exists
          ? "absent"
          : off
            ? "nologin"
            : role === QA_WRITER
              ? "none"
              : "keep",
      });
      if (role !== QA_WRITER) {
        secrets.push({ name: secret, action: "keep", present });
      }
      continue;
    }
    if (!state.exists) refuse("qa-role-missing", [role]);
    // A URL secret without LOGIN is an emergency stop (pause-settings-sync, pause-qa-sandbox).
    // Never undo it here: the operator runs the matching resume operation first.
    if (present && !state.login) {
      paused.push(role);
      continue;
    }
    let action;
    if (mode === "rotate") action = "rotate";
    else if (present && state.login) action = "none";
    else if (!present && !state.login) action = "install";
    // LOGIN without its URL: some other consumer may hold the password; only rotate decides.
    else refuse("qa-role-secret-mismatch", [role]);
    roleSteps.push({ role, action });
    secrets.push({
      name: secret,
      action: action === "none" ? "none" : present ? "replace" : "install",
      present,
    });
  }
  if (paused.length) refuse("qa-role-paused", paused);
  if (mode === "disable") {
    for (const name of DISABLE_SECRETS) {
      secrets.push({
        name,
        action: digest.has(name) ? "delete" : "none",
        present: digest.has(name),
      });
    }
  } else {
    const conflicts = [];
    for (const { name } of STAGED_SECRETS) {
      const present = digest.get(name);
      const same = present === sha256(staged.get(name));
      let action = !present ? "install" : same ? "none" : "replace";
      if (action === "replace" && mode === "apply") conflicts.push(name);
      secrets.push({ name, action, present: !!present });
    }
    if (conflicts.length) refuse("qa-secret-exists", conflicts);
  }
  for (const item of secrets) {
    if (["install", "replace"].includes(item.action))
      assertWritableName(item.name);
    if (item.action === "delete")
      assertWritableName(item.name, { remove: true });
  }
  secrets.sort((a, b) => a.name.localeCompare(b.name));
  return { secrets, roleSteps };
}

async function verifyInventory(api, expected, secrets, receipt) {
  const observed = new Map(
    (await api.list()).map((item) => [item.name, item.digest]),
  );
  const mismatched = [
    ...new Set([...expected.keys(), ...observed.keys()]),
  ].filter((name) => expected.get(name) !== observed.get(name));
  // Names only: a written name with the wrong digest, or any other secret that moved.
  if (mismatched.length) refuse("qa-secret-digest-mismatch", mismatched);
  for (const item of receipt.secrets) {
    const step = secrets.find((entry) => entry.name === item.name);
    if (item.outcome === "outcome-unknown") item.outcome = DONE[step.action];
  }
}

async function setLogins({
  changes,
  before,
  passwords,
  receipt,
  progress,
  run,
}) {
  if (!changes.length) return;
  const variables = {};
  for (const { role } of changes) {
    variables[QA_ROLE_LOGINS.find((entry) => entry.role === role).variable] =
      scramSha256Verifier(passwords.get(role), {
        salt: Buffer.from(run.randomBytesImpl(16)),
      });
  }
  receipt.status = "writing-roles";
  receipt.writeAttempted = true;
  for (const item of receipt.roles) {
    if (changes.some((step) => step.role === item.role))
      item.outcome = "outcome-unknown";
  }
  await progress();
  const ran = await runPinnedSql({
    exec: run.exec,
    cwd: run.cwd,
    conn: run.conn,
    file: run.path(QA_SECRETS_SQL.login),
    variables,
    single: true,
  });
  if (ran.code !== 0) refuse("qa-role-login-failed");
  const after = await run.roleState();
  for (const { role } of QA_ROLE_LOGINS) {
    if (after.get(role).login !== true) refuse("qa-role-cannot-login", [role]);
  }
  for (const { role } of changes) {
    if (!["scram", "unreadable"].includes(after.get(role).password)) {
      refuse("qa-role-password-not-scram", [role]);
    }
  }
  assertOnlyLoginChanged(
    before.facts,
    factList(await run.read(join(run.sourceDir, ROLE_FACTS))),
    changes.map(({ role }) => ({ role, login: true })),
  );
  const failed = [];
  for (const { role } of changes) {
    const ok = await probeLogin({
      exec: run.exec,
      cwd: run.cwd,
      conn: run.conn,
      projectRef: run.projectRef,
      role,
      password: passwords.get(role),
    });
    if (!ok) failed.push(role);
  }
  if (failed.length) refuse("qa-role-login-probe-failed", failed);
  for (const step of changes) {
    const item = receipt.roles.find((entry) => entry.role === step.role);
    item.outcome =
      step.action === "rotate" && before.roles.get(step.role).login
        ? DONE.rotate
        : "login-set";
  }
  await progress();
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

const DONE = {
  install: "installed",
  replace: "replaced",
  delete: "deleted",
  keep: "kept",
  rotate: "password-rotated",
  nologin: "nologin-set",
};
const NOOP = { none: "unchanged", keep: "kept", absent: "absent" };

function tally(entries) {
  const counts = {};
  for (const { outcome } of entries)
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
}

export async function runQaSecretsOperation({
  plan,
  env,
  platform = process.platform,
  cwd,
  sourceDir,
  exec = defaultExec,
  fetchImpl = fetch,
  randomBytesImpl = randomBytes,
  sleep = defaultSleep,
  timeoutMs = 30_000,
  onProgress = async () => {},
}) {
  const receipt = {
    protocol: 1,
    kind: QA_SECRETS_KIND,
    operation: QA_SECRETS_OPERATION,
    mode: plan?.mode ?? null,
    planDigest: plan?.digest ?? null,
    status: "not-started",
    writeAttempted: false,
    secrets: [],
    roles: [],
    counts: { secrets: {}, roles: {} },
    connections: null,
    issues: [],
    recovery: "none needed",
  };
  const passwords = new Map();
  const progress = () => {
    receipt.counts = {
      secrets: tally(receipt.secrets),
      roles: tally(receipt.roles),
    };
    return onProgress(structuredClone(receipt));
  };
  const mark = (list, names, outcome) => {
    for (const item of list)
      if (names.has(item.name ?? item.role)) item.outcome = outcome;
  };
  try {
    await progress();
    requireProductionContext(env, platform);
    assertQaSecretsPlan(plan);
    assertSamePlan(plan, env.EXPECTED_PLAN_DIGEST);
    if (
      plan.projectRef !== env.SUPABASE_PRODUCTION_PROJECT_REF ||
      env.DEPLOY_MODE !== plan.mode
    ) {
      refuse("qa-secrets-target-invalid");
    }
    const protection = await readProtection({
      fetchImpl,
      repository: env.GITHUB_REPOSITORY,
      token: env.GH_TOKEN,
      runId: env.GITHUB_RUN_ID,
      includeApprovals: true,
    });
    if (!protection.ok) refuse("qa-secrets-owner-approval-missing");
    const files = await boundFiles(sourceDir);
    for (const file of files) {
      if (
        !plan.files.some(
          (item) => item.path === file.path && item.sha256 === file.sha256,
        )
      ) {
        refuse("qa-secrets-source-differs");
      }
    }
    const path = (pin) => join(sourceDir, pin.path);
    const conn = parseDbUrl(env.SUPABASE_DB_URL);
    assertQaTarget(plan.projectRef, conn);
    const api = managementApi({
      projectRef: plan.projectRef,
      token: env[QA_SECRETS_TOKEN_ENV],
      fetchImpl,
      sleep,
      timeoutMs,
    });
    const staged = plan.mode === "disable" ? new Map() : readStaged(env);
    if (plan.mode !== "disable") await psqlSupportsGetenv(exec, cwd);
    const read = (file) =>
      runReadOnlySql({ exec, conn, target: "production", cwd, file });
    const roleState = async () =>
      parseRoleState(
        parseJsonArray(
          await read(path(QA_SECRETS_SQL.verify)),
          "qa-role-state-invalid",
        ),
      );
    const before = {
      inventory: await api.list(),
      roles: await roleState(),
      facts: factList(await read(join(sourceDir, ROLE_FACTS))),
    };
    const { secrets, roleSteps } = decide(plan.mode, before, staged);
    receipt.secrets = secrets.map(({ name, action }) => ({
      name,
      outcome:
        NOOP[action] ??
        (action === "delete" ? "pending-delete" : `pending-${action}`),
    }));
    if (plan.mode === "disable") {
      for (const item of receipt.secrets) {
        if (item.outcome === "unchanged") item.outcome = "absent";
      }
    }
    receipt.roles = roleSteps.map(({ role, action }) => ({
      role,
      outcome: NOOP[action] ?? `pending-${action}`,
    }));
    const writes = secrets.filter((item) =>
      ["install", "replace"].includes(item.action),
    );
    const deletes = secrets.filter((item) => item.action === "delete");
    const changes = roleSteps.filter((item) =>
      ["install", "rotate", "nologin"].includes(item.action),
    );
    if (!writes.length && !deletes.length && !changes.length) {
      receipt.status = "no-change";
      await progress();
      return receipt;
    }

    // The expected inventory after the secret write, kept in memory as digests only.
    const expected = new Map(
      before.inventory.map((item) => [item.name, item.digest]),
    );
    if (plan.mode === "disable") {
      if (changes.length) {
        receipt.status = "writing-role";
        receipt.writeAttempted = true;
        mark(receipt.roles, new Set([QA_WRITER]), "outcome-unknown");
        await progress(); // Durable attempt precedes the write.
        const ran = await runPinnedSql({
          exec,
          cwd,
          conn,
          file: path(QA_SECRETS_SQL.disable),
          single: false,
        });
        if (ran.code !== 0) refuse("qa-role-disable-failed");
        receipt.connections = parseClosedCounts(ran.last);
        const after = await roleState();
        if (after.get(QA_WRITER).login !== false) refuse("qa-role-still-login");
        assertOnlyLoginChanged(
          before.facts,
          factList(await read(join(sourceDir, ROLE_FACTS))),
          [{ role: QA_WRITER, login: false }],
        );
        mark(receipt.roles, new Set([QA_WRITER]), DONE.nologin);
        await progress();
      }
      if (deletes.length) {
        const names = deletes.map((item) => item.name);
        receipt.status = "deleting-secrets";
        receipt.writeAttempted = true;
        mark(receipt.secrets, new Set(names), "outcome-unknown");
        await progress();
        await api.write("DELETE", names);
        for (const name of names) expected.delete(name);
      }
    } else {
      // Every password for this run is generated up front, in memory only.
      for (const { role } of changes) {
        passwords.set(role, generatePassword(randomBytesImpl));
      }
      const body = [];
      for (const item of writes) {
        const login = QA_ROLE_LOGINS.find(
          (entry) => entry.secret === item.name,
        );
        const value = login
          ? roleDbUrl(plan.projectRef, login.role, passwords.get(login.role))
          : staged.get(item.name);
        assertWritableName(item.name);
        body.push({ name: item.name, value });
        expected.set(item.name, sha256(value));
      }
      const logins = () =>
        setLogins({
          changes,
          before,
          passwords,
          receipt,
          progress,
          run: {
            exec,
            cwd,
            conn,
            path,
            read,
            roleState,
            sourceDir,
            randomBytesImpl,
            projectRef: plan.projectRef,
          },
        });
      const write = async () => {
        receipt.status = "writing-secrets";
        receipt.writeAttempted = true;
        mark(
          receipt.secrets,
          new Set(body.map((item) => item.name)),
          "outcome-unknown",
        );
        await progress();
        if (body.length) await api.write("POST", body);
        body.length = 0;
        await verifyInventory(api, expected, secrets, receipt);
        await progress();
      };
      if (plan.mode === "rotate") {
        // Password first: a failed ALTER ROLE leaves every login and URL as it was.
        await logins();
        await write();
      } else {
        // Install: URL first; a failure before LOGIN leaves only an unused URL.
        await write();
        await logins();
      }
    }
    if (plan.mode === "disable") {
      await verifyInventory(api, expected, secrets, receipt);
    }
    receipt.status = "verified";
    await progress();
    return receipt;
  } catch (error) {
    receipt.status = receipt.writeAttempted
      ? "outcome-unknown"
      : "stopped-before-write";
    const category =
      error instanceof Refusal ? error.category : "qa-secrets-operation-failed";
    receipt.issues = [
      category,
      ...(error instanceof Refusal && Array.isArray(error.names)
        ? error.names.map((name) => `${category}:${name}`)
        : []),
    ];
    for (const item of [...receipt.secrets, ...receipt.roles]) {
      if (item.outcome.startsWith("pending-")) item.outcome = "not-attempted";
    }
    receipt.recovery = recoveryFor(receipt);
    await progress().catch(() => {});
    return receipt;
  } finally {
    passwords.clear();
  }
}

function recoveryFor({ writeAttempted, mode, roles = [], secrets = [] }) {
  if (!writeAttempted) {
    return "Nothing was written. Correct the named readiness problem, create a new plan and approve it again.";
  }
  if (mode === "disable") {
    return "Stop. Check the QA writer login and STILL_QA_SANDBOX_* names privately, then run a separately approved disable again (safe to repeat). Emergency fallback: delete STILL_QA_SANDBOX_ENTITLEMENT_WRITER_DB_URL in the Supabase dashboard.";
  }
  if (mode === "rotate") {
    const changed = roles.some((item) =>
      ["password-rotated", "login-set"].includes(item.outcome),
    );
    const unsaved = secrets.some((item) =>
      ["outcome-unknown", "not-attempted"].includes(item.outcome),
    );
    return (
      (changed && unsaved
        ? "The database passwords changed but the matching URL secrets may not have been saved: functions that use those URLs cannot sign in until rotate runs again. "
        : "Rows marked outcome-unknown may or may not have changed. ") +
      "Recover with a separately approved rotate (safe to repeat: it generates fresh passwords, changes them first, then rewrites every URL and verifies) or disable."
    );
  }
  return "Stop; do not re-run apply. Rows marked outcome-unknown may or may not have changed. Recover with a separately approved rotate (changes every password first, then rewrites every QA secret and verifies) or disable.";
}

// ── Public records (names, outcomes and counts only) ──────────────────────────────────────────

export function renderQaSecretsPlan(plan) {
  const lines = [
    `## QA sandbox secrets ${plan.mode} plan`,
    "",
    `- Digest: \`${plan.digest}\`; project ref bound; commit ${plan.revision ? `\`${plan.revision}\`` : "bound by the workflow"}.`,
    `- Pinned SQL: ${plan.files.map((file) => `\`${file.path}\` \`${file.sha256}\``).join(", ")}.`,
    `- Generated in runner memory (direct host, exact role): ${plan.roles.map((item) => `\`${item.secret}\` for \`${item.role}\``).join(", ")}.`,
    `- Copied from ${plan.staged.length} staged \`${STAGE_PREFIX}*\` values to the matching \`${QA_SECRET_PREFIX}*\` names.`,
    `- apply never replaces an existing secret or a working login; rotate changes each password first, then rewrites the URLs; disable removes the ${plan.removable.length} \`${QA_SECRET_PREFIX}*\` names and switches \`${QA_WRITER}\` to NOLOGIN.`,
    "- An emergency stop wins: a role that is switched off while its URL exists (pause-settings-sync, pause-qa-sandbox) stops the run; run the matching resume first. This operation never turns a login back on by itself.",
    "- **Shared names:** `PRODUCT_POLICY_READER_DB_URL` and `SETTINGS_WRITER_DB_URL` are also read by the production `product-policy` and `sync-settings` functions. Those are not deployed today, so this switches nothing on for customers now, but a future production deploy of either function would sign in with these URLs and logins.",
    "- Limits: an existing URL reported `unchanged` is not proven to work (only its digest is readable). The sign-in check for a new password goes through the database pooler, while functions use the direct host; the later function readiness and post-deploy probes prove the rest.",
    "- Staged values may not start or end with whitespace (a PEM block may end with one newline).",
    "- No value, password or verifier appears in this plan, the logs or the closing record.",
    "",
  ];
  return lines.join("\n");
}

export function renderQaSecretsFinal(receipt, { applyOutcome } = {}) {
  if (!receipt) {
    if (applyOutcome === "skipped") {
      return "## QA secrets closing record\n\n- Status: stopped-before-write.\n- The apply step was skipped; nothing was written.\n";
    }
    return "## QA secrets closing record\n\nOutcome unknown: no durable receipt. Stop; check the QA secret names and the three role logins privately, then recover with a separately approved rotate or disable. Never blindly retry.\n";
  }
  if (
    receipt.writeAttempted &&
    !["verified", "outcome-unknown"].includes(receipt.status)
  ) {
    receipt = {
      ...receipt,
      status: "outcome-unknown",
      recovery: recoveryFor(receipt),
    };
  }
  const count = (counts) =>
    Object.entries(counts ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, n]) => `${name} ${n}`)
      .join(", ") || "none";
  return [
    "## QA secrets closing record",
    "",
    `- Mode: ${receipt.mode ?? "unknown"}; status: ${receipt.status}.`,
    `- Write attempted: ${receipt.writeAttempted}.`,
    `- Secrets: ${count(receipt.counts?.secrets)}.`,
    `- Roles: ${count(receipt.counts?.roles)}.`,
    ...(receipt.connections
      ? [
          `- QA writer connections closed ${receipt.connections.closed}, remaining ${receipt.connections.remaining}.`,
        ]
      : []),
    `- Fixed issue codes: ${receipt.issues.join(", ") || "none"}.`,
    `- Recovery: ${receipt.recovery}`,
    "",
    "| Name | Outcome |",
    "|---|---|",
    ...receipt.roles.map(
      (item) => `| role \`${item.role}\` | ${item.outcome} |`,
    ),
    ...receipt.secrets.map((item) => `| \`${item.name}\` | ${item.outcome} |`),
    "",
  ].join("\n");
}
