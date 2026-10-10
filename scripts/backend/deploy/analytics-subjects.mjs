// Four owner-approved operations that switch on Still's signed-in (per-device) analytics on the
// hosted project, in order, through the protected `Supabase production deploy` workflow. Nothing
// here is done with the Supabase CLI or by hand, and every write waits for the owner's approval.
//
//   1. analytics-subjects-secrets   (mode apply; rotate to recover or replace)
//      Generates, in runner memory only: a password for still_analytics_eraser (migration 0017's
//      narrow role), the erasure worker token and ANALYTICS_EVENT_ID_SECRET (64 hex characters).
//      Writes the function secrets ANALYTICS_ERASER_DB_URL, ANALYTICS_ERASURE_WORKER_TOKEN and
//      ANALYTICS_EVENT_ID_SECRET, gives the eraser LOGIN with a SCRAM-SHA-256 verifier, and stores the
//      worker token in Supabase Vault for the schedule. Nobody ever sees a value.
//   2. analytics-subjects-functions (mode apply)
//      Deploys exactly analytics-erasure, analytics-identify and delete-user, in that order, as sealed
//      single-file bundles built from the planned commit, and reads each one back byte for byte.
//      delete-user is included because the hard gate needs the current delete-user (it records an
//      account's device identities for deletion before the account goes), and no other protected
//      path can deploy it.
//   3. analytics-erasure-schedule   (policy_mode enable / disable)
//      A pg_cron job (Supabase Cron, with pg_net) that POSTs {"action":"work"} to analytics-erasure
//      every 15 minutes with the token read from Vault. Disable removes only that job.
//   4. analytics-subjects-switch    (policy_mode enable / disable)
//      Sets ANALYTICS_SUBJECTS_ENABLED to "true" or "false", then redeploys analytics-identify from
//      the planned commit so every running copy picks the setting up.
//
// Hard gates, all checked read-only before the first write (any failure stops the run and names
// fixed codes only):
//   - migration history holds 0017 and 0018, and 0018's post-apply check (which also re-pins 0017's
//     account-deletion snapshot trigger and the eraser role) returns no issue;
//   - the "Supabase settings rehearsal" workflow (which deletes accounts through GoTrue's admin
//     endpoint and the real delete-user handler) succeeded on the exact planned commit;
//   - functions: the three analytics secrets and the five POSTHOG_* secrets exist, the eraser can
//     sign in, and the Vault token matches the function secret (digests only);
//   - schedule enable: analytics-erasure is deployed at the planned source;
//   - switch enable: all three functions are deployed at the planned source, the schedule is present
//     with the exact planned command, pg_cron ran it in the last 35 minutes, a worker run in that
//     window answered 200 with a report that skipped nothing and has failed = 0 and lost = 0, and,
//     last, the PostHog provider proof passes inside analytics-erasure (the personal key reads the
//     project whose public token equals POSTHOG_PROJECT_KEY, and a bulk_delete of one random id is
//     accepted with nobody found), asked through pg_net with the Vault token;
//   - the secrets step and switch-on: the Secrets-only token must be refused by GET /functions.
// A rotate skips the history, migration and rehearsal gates (it is the recovery path; re-running
// it is always safe). The disable directions have no gate beyond owner approval: the way back.
//
// Public records (plan, logs, step summary) carry names, counts, fixed codes and hashes of public
// code only: never a secret value, digest of a secret, password, verifier, email, account id or
// PostHog data.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSamePlan,
  canonical,
  defaultExec,
  diffFacts,
  ENVIRONMENT_NAME,
  isLoopback,
  lintVerificationSql,
  migrationsAt,
  OPERATIONS_DIR,
  OWNER_REVIEWER_ID,
  parseDbUrl,
  parseHistory,
  parseJsonArray,
  readProtection,
  Refusal,
  requireProductionContext,
  runReadOnlySql,
  sha256,
  TOOLING_PATHS,
  VERIFY_DIR,
} from "./deploy.mjs";
import {
  ANALYTICS_BUNDLE_SET,
  buildFunctionBundles,
  verifyFunctionBundles,
} from "./qa-function-bundles.mjs";
import {
  assertQaTarget,
  inventory,
  management,
  prepareQaSource,
  readback,
  secretInventory,
} from "./qa-functions.mjs";
import {
  generatePassword,
  managementApi,
  probeLogin,
  runPinnedSql,
  scramSha256Verifier,
} from "./qa-secrets.mjs";

export const ANALYTICS_KIND = "supabase-analytics-subjects";
export const SECRETS_OP = "analytics-subjects-secrets";
export const FUNCTIONS_OP = "analytics-subjects-functions";
export const SCHEDULE_OP = "analytics-erasure-schedule";
export const SWITCH_OP = "analytics-subjects-switch";

/** The closed operations, in the order the owner runs them. */
export const ANALYTICS_OPERATIONS = Object.freeze({
  [SECRETS_OP]: Object.freeze({
    modes: Object.freeze(["plan-only", "apply", "rotate"]),
    policyModes: Object.freeze(["none"]),
    bundles: false,
  }),
  [FUNCTIONS_OP]: Object.freeze({
    modes: Object.freeze(["plan-only", "apply"]),
    policyModes: Object.freeze(["none"]),
    bundles: true,
  }),
  [SCHEDULE_OP]: Object.freeze({
    modes: Object.freeze(["plan-only", "apply"]),
    policyModes: Object.freeze(["enable", "disable"]),
    bundles: true,
  }),
  [SWITCH_OP]: Object.freeze({
    modes: Object.freeze(["plan-only", "apply"]),
    policyModes: Object.freeze(["enable", "disable"]),
    bundles: true,
  }),
});
export const isAnalyticsOperation = (name) =>
  Object.hasOwn(ANALYTICS_OPERATIONS, String(name ?? ""));

export const ERASER_ROLE = "still_analytics_eraser";
export const ERASER_URL_SECRET = "ANALYTICS_ERASER_DB_URL";
export const EVENT_ID_SECRET = "ANALYTICS_EVENT_ID_SECRET";
export const WORKER_TOKEN_SECRET = "ANALYTICS_ERASURE_WORKER_TOKEN";
export const SWITCH_SECRET = "ANALYTICS_SUBJECTS_ENABLED";
/** The only function secrets these operations ever write. */
export const WRITABLE_SECRETS = Object.freeze([
  ERASER_URL_SECRET,
  EVENT_ID_SECRET,
  WORKER_TOKEN_SECRET,
  SWITCH_SECRET,
]);
/** Set on 2026-09-23 for 2.1 (docs/release/posthog-analytics.md); read, never written here. */
export const POSTHOG_SECRETS = Object.freeze([
  "POSTHOG_API_HOST",
  "POSTHOG_HOST",
  "POSTHOG_PERSONAL_API_KEY",
  "POSTHOG_PROJECT_ID",
  "POSTHOG_PROJECT_KEY",
]);
export const REQUIRED_RUNTIME_SECRETS = Object.freeze([
  ERASER_URL_SECRET,
  EVENT_ID_SECRET,
  WORKER_TOKEN_SECRET,
  ...POSTHOG_SECRETS,
]);
export const VAULT_TOKEN_NAME = "still_analytics_erasure_worker_token";
export const CRON_JOB = "still-analytics-erasure-worker";
export const CRON_SCHEDULE = "*/15 * * * *";
export const WORKER_TIMEOUT_MS = 60_000;
/** The Secrets-only token (read and write project secrets; no database or function access). */
export const SECRETS_TOKEN_ENV = "SUPABASE_QA_SECRETS_ACCESS_TOKEN";
export const FUNCTIONS_TOKEN_ENV = "SUPABASE_PRODUCTION_ACCESS_TOKEN";

/** The pinned SQL. Changing a file means changing its hash here in the same reviewed commit. */
export const ANALYTICS_SQL = Object.freeze({
  secrets: Object.freeze({
    path: `${OPERATIONS_DIR}/analytics-subjects-secrets.sql`,
    sha256: "40ff4db4de91112509af0fe0b3d6085916c882d7b6c57c9d40a87de6a510a767",
  }),
  scheduleEnable: Object.freeze({
    path: `${OPERATIONS_DIR}/analytics-erasure-schedule-enable.sql`,
    sha256: "166e54a321bcd07cb9860000bf619930ec34593d5e85be7b2de8501df4722a61",
  }),
  scheduleDisable: Object.freeze({
    path: `${OPERATIONS_DIR}/analytics-erasure-schedule-disable.sql`,
    sha256: "44765b36115b5c50a3060be671290d5518ce6fb97ab7097a3ddd644d203572cb",
  }),
  providerCheck: Object.freeze({
    path: `${OPERATIONS_DIR}/analytics-provider-check.sql`,
    sha256: "6462383729f01ef26335699ab03210ae5ed2a71e75afb551a9a6a8b0eb642c62",
  }),
  providerRead: Object.freeze({
    path: `${OPERATIONS_DIR}/analytics-provider-check.read.sql`,
    sha256: "f81dd072c75e299aef3afa241d2b04b4d3e2f1e4963db9eaaafa67b469e17697",
  }),
  verify: Object.freeze({
    path: `${OPERATIONS_DIR}/analytics-subjects.verify.sql`,
    sha256: "b4b953b191072fdbf9765ad3af47363b3571f134732ea4dd4e509b395e4c396a",
  }),
});
/** 0018's post-apply check: covers 0018, 0017's snapshot trigger and routes, and the eraser role. */
export const MIGRATION_GATE = `${VERIFY_DIR}/0018_analytics_account_erasure.sql`;
/**
 * Codes 0018's check reports only because a LATER reviewed migration changed that object on
 * purpose: 0020 replaced the shared rate limiter's body (new buckets; 0020's own check pins the new
 * body). The limiter is not part of the deletion safety net. Any other code stops the run, so a
 * future change to an analytics object needs a reviewed update here first.
 */
export const LATER_MIGRATION_CODES = Object.freeze([
  "erasure_function_body_changed:public.consume_rate_limit(text,integer,integer)",
]);
const HISTORY_SQL = "scripts/backend/deploy/sql/migration-history.sql";
const ROLE_FACTS = "scripts/backend/deploy/sql/role-facts.sql";
export const REHEARSAL_WORKFLOW =
  ".github/workflows/supabase-settings-rehearsal.yml";
export const ANALYTICS_TOOLING = Object.freeze(
  [
    ...new Set([
      ...TOOLING_PATHS,
      "scripts/backend/deploy/analytics-subjects.mjs",
      "scripts/backend/deploy/qa-function-bundles.mjs",
      "scripts/backend/deploy/qa-functions.mjs",
      "scripts/backend/deploy/qa-secrets.mjs",
      "scripts/backend/deploy/qa-secrets-operation.mjs",
      "scripts/backend/plan.mjs",
      REHEARSAL_WORKFLOW,
      MIGRATION_GATE,
      HISTORY_SQL,
      ROLE_FACTS,
    ]),
  ].sort(),
);

const validRef = (ref) => /^[a-z]{20}$/.test(ref ?? "");
const SECRET_VALUE = /^[a-f0-9]{64}$/;
const same = (a, b) => canonical(a) === canonical(b);
const refuse = (category, codes) => {
  const refusal = new Refusal(category);
  if (codes?.length) refusal.codes = [...new Set(codes)].sort();
  throw refusal;
};

/**
 * The exact command the schedule runs (one line). The token is read from Vault at run time, so it
 * is never part of the job; the project ref is the bound, nonsecret repository variable.
 */
export function workerCommand(projectRef) {
  if (!validRef(projectRef)) refuse("analytics-input-invalid");
  return (
    "select net.http_post(" +
    `url := 'https://${projectRef}.supabase.co/functions/v1/analytics-erasure', ` +
    "headers := pg_catalog.jsonb_build_object('Content-Type', 'application/json', 'Authorization', " +
    `(select s.decrypted_secret from vault.decrypted_secrets s where s.name = '${VAULT_TOKEN_NAME}')), ` +
    `body := '{"action":"work"}'::jsonb, timeout_milliseconds := ${WORKER_TIMEOUT_MS})`
  );
}

/** The analytics-erasure route on the bound project (the provider proof's target). */
export function functionUrl(projectRef) {
  if (!validRef(projectRef)) refuse("analytics-input-invalid");
  return `https://${projectRef}.supabase.co/functions/v1/analytics-erasure`;
}

/** The provider proof's fixed codes (supabase/functions/_shared/posthog-erasure.ts keeps the same list). */
export const PROVIDER_CHECK_CODES = Object.freeze([
  "provider_unconfigured",
  "project_read_ok",
  "project_read_forbidden",
  "project_read_unavailable",
  "project_read_rejected",
  "project_read_network",
  "project_read_shape",
  "project_key_matches",
  "project_key_mismatch",
  "delete_scope_ok",
  "delete_forbidden",
  "delete_unavailable",
  "delete_rejected",
  "delete_network",
  "delete_shape",
  "delete_found_person",
]);

/** Direct host and exact role name, like the other function database URLs. */
export function eraserDbUrl(projectRef, password) {
  if (!validRef(projectRef) || !SECRET_VALUE.test(password ?? "")) {
    refuse("analytics-url-invalid");
  }
  const url =
    `postgresql://${ERASER_ROLE}:${password}@db.${projectRef}.supabase.co:5432/postgres?sslmode=require`;
  const conn = parseDbUrl(url);
  if (
    conn.user !== ERASER_ROLE || conn.password !== password ||
    conn.host !== `db.${projectRef}.supabase.co` || conn.port !== "5432" ||
    conn.database !== "postgres" || conn.sslmode !== "require"
  ) refuse("analytics-url-invalid");
  return url;
}

/** Refuses any name outside the closed list; SUPABASE_* names are platform-reserved. */
export function assertWritableSecret(name) {
  if (
    typeof name !== "string" || /^SUPABASE_/i.test(name) ||
    !WRITABLE_SECRETS.includes(name)
  ) refuse("analytics-secret-name-refused");
}

// ── Plan (no secrets) ──────────────────────────────────────────────────────────────────────────

function operationInputs({
  operation,
  mode,
  policyMode,
  sha,
  projectRef,
  migrations,
  functions,
  expectedRevision,
  subjectsSha256,
  baselineSha256,
}) {
  const spec = ANALYTICS_OPERATIONS[operation];
  if (!spec) refuse("analytics-operation-unknown");
  if (
    String(migrations ?? "").trim() || String(functions ?? "").trim() ||
    String(expectedRevision ?? "").trim() ||
    String(subjectsSha256 ?? "").trim() || String(baselineSha256 ?? "").trim()
  ) refuse("analytics-input-invalid");
  const policy = String(policyMode ?? "").trim() || "none";
  if (
    !spec.modes.includes(mode) || !spec.policyModes.includes(policy) ||
    !/^[a-f0-9]{40}$/.test(sha ?? "") || !validRef(projectRef)
  ) refuse("analytics-input-invalid");
  return { spec, policy };
}

async function pinnedFiles(sourceDir) {
  const files = [];
  for (const pin of Object.values(ANALYTICS_SQL)) {
    let bytes;
    try {
      bytes = await readFile(join(sourceDir, pin.path));
    } catch {
      refuse("analytics-sql-missing");
    }
    if (sha256(bytes) !== pin.sha256) refuse("analytics-sql-unpinned");
    files.push({ path: pin.path, text: bytes.toString("utf8") });
  }
  for (const pin of [ANALYTICS_SQL.verify, ANALYTICS_SQL.providerRead]) {
    lintVerificationSql(files.find((file) => file.path === pin.path).text);
  }
  return files;
}

export async function createAnalyticsPlan({
  git,
  sha,
  mainRef = "HEAD",
  cwd,
  exec = defaultExec,
  sourceDir,
  artifactDir,
  projectRef,
  operation,
  mode = "plan-only",
  policyMode = "none",
  migrations = "",
  functions = "",
  expectedRevision = "",
  subjectsSha256 = "",
  baselineSha256 = "",
  buildBundles = buildFunctionBundles,
}) {
  const { spec, policy } = operationInputs({
    operation,
    mode,
    policyMode,
    sha,
    projectRef,
    migrations,
    functions,
    expectedRevision,
    subjectsSha256,
    baselineSha256,
  });
  const revision = await git.commit(sha);
  const workflowRevision = await git.commit(mainRef);
  if (revision !== sha || !(await git.isAncestor(revision, workflowRevision))) {
    refuse("analytics-commit-not-on-main");
  }
  const history = await migrationsAt(git, revision);
  for (const version of ["0017", "0018"]) {
    if (!history.some((item) => item.version === version)) {
      refuse("analytics-prerequisite-history-missing");
    }
  }
  if (!sourceDir || (spec.bundles && !artifactDir)) {
    refuse("analytics-artifact-directory-missing");
  }
  await prepareQaSource({ exec, cwd, revision, sourceDir });
  await pinnedFiles(sourceDir);
  const bundles = spec.bundles
    ? await buildBundles(ANALYTICS_BUNDLE_SET, { sourceDir, artifactDir, exec })
    : null;
  const paths = [
    ...new Set([
      ...ANALYTICS_TOOLING,
      ...Object.values(ANALYTICS_SQL).map((pin) => pin.path),
      ...(bundles ? bundles.sources.map((item) => item.path) : []),
    ]),
  ].sort();
  const files = [];
  for (const path of paths) {
    const source = await git.blob(revision, path);
    const current = await git.blob(workflowRevision, path);
    if (!source || !current || sha256(source) !== sha256(current)) {
      refuse("analytics-bound-file-differs");
    }
    if (path === MIGRATION_GATE) lintVerificationSql(source.toString());
    files.push({ path, sha256: sha256(source) });
  }
  const manifest = {
    protocol: 1,
    kind: ANALYTICS_KIND,
    operation,
    policyMode: policy,
    mode,
    environment: ENVIRONMENT_NAME,
    revision,
    workflowRevision,
    onFirstParent: await git.onFirstParent(revision, workflowRevision),
    projectRef,
    files,
    bundles,
    writable: [...WRITABLE_SECRETS],
    workerCommandSha256: sha256(workerCommand(projectRef)),
    recovery:
      "stop; a run that began writing records outcome-unknown; recover with the counterpart or a separately approved rotate; never blindly retry",
  };
  return { ...manifest, digest: sha256(canonical(manifest)) };
}

/** Every file the apply relies on, for the workflow's freshness check. */
export const analyticsBoundFiles = (plan) => plan.files;

/** Extracts the exact commit (supabase/, the deploy scripts, the bundled sources) and checks hashes. */
export async function prepareAnalyticsWorkdir({ exec, cwd, plan, dir }) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await prepareQaSource({ exec, cwd, revision: plan.revision, sourceDir: dir });
  await checkSource(plan, dir);
  return dir;
}

async function checkSource(plan, sourceDir) {
  for (const file of plan.files) {
    let bytes;
    try {
      bytes = await readFile(join(sourceDir, file.path));
    } catch {
      bytes = null;
    }
    if (!bytes || sha256(bytes) !== file.sha256) {
      refuse("analytics-source-differs");
    }
  }
  for (const pin of Object.values(ANALYTICS_SQL)) {
    if (
      !plan.files.some((file) =>
        file.path === pin.path && file.sha256 === pin.sha256
      )
    ) refuse("analytics-sql-unpinned");
  }
}

// ── Reads (read-only) ──────────────────────────────────────────────────────────────────────────

const ERASER_STATES = ["missing", "login", "nologin"];

/** Parses analytics-subjects.verify.sql output; anything unexpected is refused. */
export function parseFacts(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    refuse("analytics-facts-unreadable");
  }
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  const evidence = (n) => n === null || count(n);
  const job = value?.job;
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !ERASER_STATES.includes(value.eraser) ||
    typeof value.pgCron !== "boolean" || typeof value.pgNet !== "boolean" ||
    !count(value.vaultTokens) || !count(value.jobs) ||
    !count(value.recentRuns) || !evidence(value.recentWorkerOk) ||
    !evidence(value.recentWorkerSkipped) || !evidence(value.recentWorkerFailing) ||
    (value.recentWorkerOk === null) !== (value.recentWorkerSkipped === null) ||
    (value.recentWorkerOk === null) !== (value.recentWorkerFailing === null) ||
    !(value.vaultTokenSha256 === null ||
      /^[a-f0-9]{64}$/.test(value.vaultTokenSha256)) ||
    (value.vaultTokens === 1) !== (value.vaultTokenSha256 !== null) ||
    !(job === null ||
      (job && typeof job.schedule === "string" &&
        typeof job.active === "boolean" && typeof job.username === "string" &&
        /^[a-f0-9]{64}$/.test(job.commandSha256 ?? ""))) ||
    (value.jobs === 1) !== (job !== null)
  ) refuse("analytics-facts-unreadable");
  return value;
}

const GATE_CODE = /^[a-z_]{1,48}(?::[a-z0-9_.,()=[\] -]{1,160})?$/;
const MAX_CODES = 60;
/** Fixed catalog identifiers only; anything else collapses to one marker. */
export function gateCodes(list, prefix) {
  const codes = new Set();
  for (const code of Array.isArray(list) ? list : [null]) {
    codes.add(
      typeof code === "string" && GATE_CODE.test(code)
        ? `${prefix}:${code}`
        : `${prefix}:unrecognized`,
    );
  }
  const sorted = [...codes].sort();
  return sorted.length > MAX_CODES
    ? [...sorted.slice(0, MAX_CODES), `${prefix}:more:${sorted.length - MAX_CODES}`]
    : sorted;
}

/** True when the GoTrue deletion rehearsal workflow succeeded on exactly this commit. */
export async function rehearsalGreen({ fetchImpl, repository, token, sha }) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository)) ||
    !/^[a-f0-9]{40}$/.test(sha ?? "")
  ) return false;
  const workflow = REHEARSAL_WORKFLOW.split("/").at(-1);
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&status=success&per_page=20`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
  } catch {
    return false;
  }
  if (!response.ok) return false;
  let body;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  return Array.isArray(body?.workflow_runs) &&
    body.workflow_runs.some((run) =>
      run?.head_sha === sha && run?.conclusion === "success" &&
      String(run?.path ?? "").split("@")[0] === REHEARSAL_WORKFLOW
    );
}

/**
 * The Secrets-only token must not be able to read or deploy functions: GET /functions with it has to
 * be refused (401 or 403). Read-only; returns a fixed code, or null when the token is narrow.
 */
export async function secretsTokenProbe({ fetchImpl, projectRef, token }) {
  if (!validRef(projectRef) || typeof token !== "string" || !token.trim()) {
    return "secrets_token_missing";
  }
  let response;
  try {
    response = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/functions`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch {
    return "secrets_token_probe_failed";
  }
  await response.body?.cancel?.().catch(() => {});
  if (response.status === 401 || response.status === 403) return null;
  return response.ok ? "secrets_token_too_broad" : "secrets_token_probe_failed";
}

/** Parses the provider proof's answer: fixed codes only; anything else is a shape failure. */
export function providerCodes(content) {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    return ["provider_check_shape"];
  }
  if (
    !value || typeof value !== "object" || typeof value.ok !== "boolean" ||
    !Array.isArray(value.codes) || value.codes.length > PROVIDER_CHECK_CODES.length ||
    value.codes.some((code) => !PROVIDER_CHECK_CODES.includes(code))
  ) return ["provider_check_shape"];
  const passing = ["project_read_ok", "project_key_matches", "delete_scope_ok"];
  const proven = passing.every((code) => value.codes.includes(code));
  if (value.ok && proven) return [];
  // Anything short of all three passing codes with ok:true refuses, and always names a reason.
  const failures = value.codes.filter((code) => !passing.includes(code)).map((code) => `provider:${code}`);
  if (value.ok !== proven) failures.push("provider_check_shape");
  return failures.length ? failures : ["provider_check_failed"];
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the provider proof inside the analytics-erasure function: queues one pg_net request (the
 * worker token is read from Vault inside the database), then reads pg_net's answer read-only.
 * Returns fixed gate codes; [] when PostHog deletion is proven for the event project.
 */
export async function proveProvider({ exec, cwd, conn, sourceDir, projectRef, sleep = defaultSleep, polls = 20 }) {
  const ran = await runPinnedSql({
    exec,
    cwd,
    conn,
    file: join(sourceDir, ANALYTICS_SQL.providerCheck.path),
    variables: { STILL_ANALYTICS_FUNCTION_URL: functionUrl(projectRef) },
    single: true,
  });
  if (ran.code !== 0 || !/^[1-9][0-9]{0,18}$/.test(ran.last)) return ["provider_check_not_queued"];
  for (let attempt = 0; attempt < polls; attempt++) {
    await sleep(3000);
    let answer;
    try {
      answer = JSON.parse(
        await runReadOnlySql({
          exec,
          conn,
          target: "production",
          cwd,
          file: join(sourceDir, ANALYTICS_SQL.providerRead.path),
          vars: { STILL_OPERATION_REQUEST_ID: ran.last },
        }),
      );
    } catch {
      return ["provider_check_unreadable"];
    }
    if (!answer?.found) continue;
    if (answer.status !== 200) {
      return [`provider_check_http_${Number.isSafeInteger(answer.status) ? answer.status : "none"}`];
    }
    return providerCodes(answer.content);
  }
  return ["provider_check_unanswered"];
}

/** One deployed route equals the planned single-file bundle (metadata and bytes). Never throws. */
export async function deployedMatches(api, upload, bytes, metadata) {
  if (
    !metadata || metadata.status !== "ACTIVE" ||
    metadata.verify_jwt !== upload.verifyJwt || metadata.import_map !== false ||
    metadata.import_map_path !== null ||
    typeof metadata.entrypoint_path !== "string" ||
    !metadata.entrypoint_path.endsWith(`/${upload.file}`)
  ) return false;
  try {
    const body = await api(`/functions/${upload.name}/body`, {
      multipart: true,
    });
    let file = null;
    for (const [, value] of body) {
      if (typeof value === "string") continue;
      if (file || value.name.split("/").at(-1) !== upload.file) return false;
      file = Buffer.from(await value.arrayBuffer());
    }
    return !!file && file.equals(bytes);
  } catch {
    return false;
  }
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

/** The pinned SQL passes values as bind parameters (\bind), which needs psql 16 or newer. */
async function requirePsql16(exec, cwd) {
  const result = await exec("psql", ["--version"], { cwd });
  const major = Number(/\(PostgreSQL\)\s+(\d+)/.exec(String(result.stdout))?.[1]);
  if (result.code !== 0 || !(major >= 16)) refuse("analytics-psql-too-old");
}

const OUTCOME_UNKNOWN = "outcome-unknown";

function recoveryFor(receipt) {
  if (!receipt.writeAttempted) {
    return receipt.issues.length > 1
      ? "Nothing was written. Fix the listed gate failures, then create a new plan and approve it again."
      : "Nothing was written. Correct the named problem, then create a new plan and approve it again.";
  }
  switch (receipt.operation) {
    case SECRETS_OP:
      return "Stop; do not re-run apply. Rows marked outcome-unknown may or may not have changed. Recover with a separately approved analytics-subjects-secrets rotate (it changes the eraser password first, then rewrites the URL and token secrets and the Vault token, and verifies).";
    case FUNCTIONS_OP:
      return "Stop; inspect only the attempted route privately. The earlier routes in this record were verified. Recover with a reviewed fix-forward, then a new analytics-subjects-functions plan; never blindly retry, delete or roll back.";
    case SCHEDULE_OP:
      return "Stop. Run analytics-erasure-schedule disable (safe to repeat), then plan again. The switch refuses to enable without a verified schedule.";
    default:
      return "Stop. If the setting may be on, run analytics-subjects-switch disable now (it has no other gate). Then inspect analytics-identify privately before planning again.";
  }
}

const tally = (steps) => {
  const counts = {};
  for (const { outcome } of steps) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
};

export async function runAnalyticsOperation({
  plan,
  env,
  platform = process.platform,
  cwd,
  sourceDir,
  artifactDir,
  exec = defaultExec,
  fetchImpl = fetch,
  randomBytesImpl = randomBytes,
  verifyBundles = verifyFunctionBundles,
  provider = proveProvider,
  onProgress = async () => {},
}) {
  const receipt = {
    protocol: 1,
    kind: ANALYTICS_KIND,
    operation: plan?.operation ?? null,
    policyMode: plan?.policyMode ?? null,
    mode: plan?.mode ?? null,
    planDigest: plan?.digest ?? null,
    status: "not-started",
    writeAttempted: false,
    steps: [],
    counts: {},
    issues: [],
    recovery: "none needed",
  };
  const secretValues = new Map();
  const progress = () => {
    receipt.counts = tally(receipt.steps);
    return onProgress(structuredClone(receipt));
  };
  const step = (name, outcome) => {
    const existing = receipt.steps.find((item) => item.name === name);
    if (existing) existing.outcome = outcome;
    else receipt.steps.push({ name, outcome });
  };
  try {
    await progress();
    requireProductionContext(env, platform);
    const spec = ANALYTICS_OPERATIONS[plan?.operation];
    if (
      plan?.kind !== ANALYTICS_KIND || !spec ||
      plan.environment !== ENVIRONMENT_NAME ||
      !["apply", "rotate"].includes(plan.mode) ||
      !spec.modes.includes(plan.mode) ||
      !spec.policyModes.includes(plan.policyMode) ||
      !same(plan.writable, WRITABLE_SECRETS) || !validRef(plan.projectRef) ||
      plan.workerCommandSha256 !== sha256(workerCommand(plan.projectRef)) ||
      (spec.bundles !== (plan.bundles !== null))
    ) refuse("analytics-plan-invalid");
    assertSamePlan(plan, env.EXPECTED_PLAN_DIGEST);
    if (
      plan.projectRef !== env.SUPABASE_PRODUCTION_PROJECT_REF ||
      env.DEPLOY_MODE !== plan.mode || env.DEPLOY_OPERATION !== plan.operation ||
      (String(env.DEPLOY_POLICY_MODE ?? "").trim() || "none") !==
        plan.policyMode
    ) refuse("analytics-target-invalid");
    const protection = await readProtection({
      fetchImpl,
      repository: env.GITHUB_REPOSITORY,
      token: env.GH_TOKEN,
      runId: env.GITHUB_RUN_ID,
      includeApprovals: true,
    });
    if (!protection.ok) refuse("analytics-owner-approval-missing");
    await checkSource(plan, sourceDir);
    if (plan.bundles) {
      try {
        await verifyBundles(ANALYTICS_BUNDLE_SET, {
          sourceDir,
          artifactDir,
          manifest: plan.bundles,
          exec,
        });
      } catch {
        refuse("analytics-bundle-differs");
      }
    }
    const conn = parseDbUrl(env.SUPABASE_DB_URL);
    assertQaTarget(plan.projectRef, conn);
    const path = (pin) => join(sourceDir, pin.path);
    const read = (file) =>
      runReadOnlySql({ exec, conn, target: "production", cwd, file });
    const facts = async () => parseFacts(await read(path(ANALYTICS_SQL.verify)));
    const roleFacts = async () => {
      const list = parseJsonArray(
        await read(join(sourceDir, ROLE_FACTS)),
        "analytics-role-facts-unreadable",
      );
      if (!list.length || list.some((fact) => typeof fact !== "string")) {
        refuse("analytics-role-facts-unreadable");
      }
      return list;
    };
    const operation = plan.operation;
    const enable = plan.policyMode === "enable";
    const needsFunctions = operation !== SECRETS_OP;
    const needsSecretWrite = operation === SECRETS_OP || operation === SWITCH_OP;
    const functionsApi = needsFunctions
      ? management({
        projectRef: plan.projectRef,
        token: env[FUNCTIONS_TOKEN_ENV],
        fetchImpl,
      })
      : null;
    const secretsApi = needsSecretWrite
      ? managementApi({
        projectRef: plan.projectRef,
        token: env[SECRETS_TOKEN_ENV],
        fetchImpl,
      })
      : null;
    const listSecrets = async () =>
      secretsApi
        ? await secretsApi.list()
        : secretInventory(await functionsApi("/secrets"));
    const listFunctions = async () => inventory(await functionsApi("/functions"));
    const bundleBytes = async (upload) => {
      const bytes = await readFile(join(artifactDir, upload.file));
      if (sha256(bytes) !== upload.sha256 || bytes.length !== upload.bytes) {
        refuse("analytics-upload-bytes-differ");
      }
      return bytes;
    };

    // ── Read the starting state; every gate is decided before any write ──
    const before = {
      facts: await facts(),
      secrets: await listSecrets(),
      functions: functionsApi ? await listFunctions() : null,
    };
    const digest = new Map(before.secrets.map((item) => [item.name, item.digest]));
    // A rotate is the recovery path: it skips the history, migration and rehearsal gates so it can
    // always repair a half-finished secrets run; it keeps the role check and its own write checks.
    const gated = (operation === SECRETS_OP && plan.mode !== "rotate") ||
      operation === FUNCTIONS_OP || enable;
    const codes = [];
    if (operation === SECRETS_OP && before.facts.eraser === "missing") codes.push("eraser_role_missing");
    // The Secrets-only token must not reach functions (switch-off skips this: it must always work).
    if (operation === SECRETS_OP || (operation === SWITCH_OP && enable)) {
      const probe = await secretsTokenProbe({
        fetchImpl,
        projectRef: plan.projectRef,
        token: env[SECRETS_TOKEN_ENV],
      });
      if (probe) codes.push(probe);
    }
    if (gated) {
      const history = parseHistory(await read(join(sourceDir, HISTORY_SQL)));
      for (const version of ["0017", "0018"]) {
        if (!history.some((item) => item.version === version)) {
          codes.push(`history_missing:${version}`);
        }
      }
      const gate = parseJsonArray(
        await read(join(sourceDir, MIGRATION_GATE)),
        "analytics-gate-unreadable",
      );
      const unexpected = gate.filter((code) => !LATER_MIGRATION_CODES.includes(code));
      if (unexpected.length) codes.push(...gateCodes(unexpected, "migration_gate"));
      if (
        !(await rehearsalGreen({
          fetchImpl,
          repository: env.GITHUB_REPOSITORY,
          token: env.GH_TOKEN,
          sha: plan.revision,
        }))
      ) codes.push("gotrue_rehearsal_not_green");
      if (operation !== SECRETS_OP && before.facts.eraser === "missing") codes.push("eraser_role_missing");
    }
    const runtimeReady = () => {
      for (const name of REQUIRED_RUNTIME_SECRETS) {
        if (!digest.has(name)) codes.push(`missing_secret:${name}`);
      }
      if (before.facts.eraser !== "login") codes.push("eraser_cannot_sign_in");
      if (
        before.facts.vaultTokens !== 1 ||
        before.facts.vaultTokenSha256 !== digest.get(WORKER_TOKEN_SECRET)
      ) codes.push("worker_token_mismatch");
    };
    const atSource = async (names) => {
      for (const name of names) {
        const upload = plan.bundles.functions.find((item) => item.name === name);
        const metadata = before.functions.find((item) => item.slug === name);
        if (
          !(await deployedMatches(
            functionsApi,
            upload,
            await bundleBytes(upload),
            metadata,
          ))
        ) codes.push(`function_not_at_source:${name}`);
      }
    };
    if (operation === FUNCTIONS_OP) runtimeReady();
    if (operation === SCHEDULE_OP && enable) {
      runtimeReady();
      if (!before.facts.pgCron) codes.push("pg_cron_missing");
      await atSource(["analytics-erasure"]);
    }
    if (operation === SWITCH_OP && enable) {
      runtimeReady();
      await atSource(plan.bundles.functions.map((item) => item.name));
      const job = before.facts.job;
      if (!job) codes.push("schedule_missing");
      else if (
        job.schedule !== CRON_SCHEDULE || !job.active ||
        job.username !== "postgres" ||
        job.commandSha256 !== plan.workerCommandSha256
      ) codes.push("schedule_differs");
      if (before.facts.recentRuns < 1) codes.push("schedule_not_running");
      if (before.facts.recentWorkerOk === null) codes.push("worker_evidence_unreadable");
      else if (before.facts.recentWorkerOk < 1) {
        codes.push(
          before.facts.recentWorkerSkipped > 0
            ? "worker_provider_unconfigured"
            : before.facts.recentWorkerFailing > 0
            ? "worker_failing"
            : "worker_not_succeeding",
        );
      }
      // Last, and only when everything else holds: the PostHog provider proof, run inside the
      // function (queues one request; writes no state of Still's). Fixed codes only.
      if (!codes.length) {
        await requirePsql16(exec, cwd);
        codes.push(...(await provider({ exec, cwd, conn, sourceDir, projectRef: plan.projectRef })));
      }
    }
    if (codes.length) refuse("analytics-gate-failed", codes);

    // ── Operation-specific decision and writes ──
    if (operation === SECRETS_OP) {
      await secretsOperation({
        plan, receipt, step, progress, digest, before, secretsApi, exec, cwd,
        conn, path, facts, roleFacts, randomBytesImpl, secretValues,
      });
    } else if (operation === FUNCTIONS_OP) {
      for (const upload of plan.bundles.functions) {
        step(upload.name, "pending");
      }
      for (const upload of plan.bundles.functions) {
        const bytes = await bundleBytes(upload);
        const current = await listFunctions();
        const metadata = current.find((item) => item.slug === upload.name);
        if (await deployedMatches(functionsApi, upload, bytes, metadata)) {
          step(upload.name, "unchanged");
          await progress();
          continue;
        }
        await deployRoute({
          api: functionsApi, upload, bytes, plan, receipt, step, progress,
          listFunctions, listSecrets, current,
        });
      }
      if (receipt.steps.every((item) => item.outcome === "unchanged")) {
        receipt.status = "no-change";
        await progress();
        return receipt;
      }
    } else if (operation === SCHEDULE_OP) {
      const job = before.facts.job;
      const matches = job && job.schedule === CRON_SCHEDULE && job.active &&
        job.username === "postgres" &&
        job.commandSha256 === plan.workerCommandSha256;
      if (enable ? before.facts.jobs === 1 && matches : before.facts.jobs === 0) {
        step(CRON_JOB, enable ? "already-scheduled" : "already-absent");
        receipt.status = "no-change";
        await progress();
        return receipt;
      }
      if (enable && before.facts.jobs > 1) refuse("analytics-schedule-duplicate");
      if (enable) await requirePsql16(exec, cwd);
      const rolesBefore = await roleFacts();
      step(CRON_JOB, OUTCOME_UNKNOWN);
      receipt.status = enable ? "scheduling" : "unscheduling";
      receipt.writeAttempted = true;
      await progress(); // Durable attempt precedes the write.
      const ran = await runPinnedSql({
        exec,
        cwd,
        conn,
        file: path(enable ? ANALYTICS_SQL.scheduleEnable : ANALYTICS_SQL.scheduleDisable),
        variables: enable
          ? { STILL_ANALYTICS_WORKER_COMMAND: workerCommand(plan.projectRef) }
          : {},
        single: true,
      });
      if (ran.code !== 0) refuse("analytics-schedule-sql-failed");
      const after = await facts();
      if (enable) {
        const j = after.job;
        if (
          after.jobs !== 1 || !after.pgNet || !j || j.schedule !== CRON_SCHEDULE ||
          !j.active || j.username !== "postgres" ||
          j.commandSha256 !== plan.workerCommandSha256
        ) refuse("analytics-schedule-not-verified");
      } else if (after.jobs !== 0) refuse("analytics-schedule-still-present");
      if (
        after.eraser !== before.facts.eraser ||
        after.vaultTokenSha256 !== before.facts.vaultTokenSha256
      ) refuse("analytics-preservation-failed");
      // No role, login, setting or membership changed. One exception: installing pg_net for the
      // first time creates Supabase's own supabase_functions_admin role (its install script).
      const roleDiff = diffFacts([...rolesBefore].sort(), [...(await roleFacts())].sort());
      const platform = (fact) =>
        enable && !before.facts.pgNet &&
        /^(role supabase_functions_admin \||member supabase_functions_admin of |member \S+ of supabase_functions_admin \|)/
          .test(fact);
      if (roleDiff.removed.length || roleDiff.added.some((fact) => !platform(fact))) {
        refuse("analytics-role-facts-changed");
      }
      step(CRON_JOB, enable ? "scheduled" : "unscheduled");
    } else {
      const value = enable ? "true" : "false";
      const current = digest.get(SWITCH_SECRET);
      if (enable ? current === sha256(value) : current === undefined || current === sha256(value)) {
        step(SWITCH_SECRET, enable ? "already-on" : "already-off");
        receipt.status = "no-change";
        await progress();
        return receipt;
      }
      assertWritableSecret(SWITCH_SECRET);
      step(SWITCH_SECRET, OUTCOME_UNKNOWN);
      step("analytics-identify", "pending");
      receipt.status = "writing-secret";
      receipt.writeAttempted = true;
      await progress();
      await secretsApi.write("POST", [{ name: SWITCH_SECRET, value }]);
      const expected = new Map(digest);
      expected.set(SWITCH_SECRET, sha256(value));
      await verifySecrets(listSecrets, expected);
      step(SWITCH_SECRET, enable ? "set-true" : "set-false");
      await progress();
      const upload = plan.bundles.functions.find((item) => item.name === "analytics-identify");
      await deployRoute({
        api: functionsApi, upload, bytes: await bundleBytes(upload), plan, receipt,
        step, progress, listFunctions, listSecrets, current: await listFunctions(),
      });
    }
    if (receipt.status !== "no-change") receipt.status = "verified";
    await progress();
    return receipt;
  } catch (error) {
    receipt.status = receipt.writeAttempted ? OUTCOME_UNKNOWN : "stopped-before-write";
    receipt.issues = error instanceof Refusal
      ? [error.category, ...(error.codes ?? [])]
      : ["analytics-operation-failed"];
    for (const item of receipt.steps) {
      if (item.outcome === "pending") item.outcome = "not-attempted";
    }
    receipt.recovery = recoveryFor(receipt);
    await progress().catch(() => {});
    return receipt;
  } finally {
    secretValues.clear();
  }
}

/** GET /secrets must show exactly the expected digests: every written name, and nothing else moved. */
async function verifySecrets(listSecrets, expected) {
  const observed = new Map((await listSecrets()).map((item) => [item.name, item.digest]));
  const moved = [...new Set([...expected.keys(), ...observed.keys()])].filter((name) =>
    expected.get(name) !== observed.get(name)
  );
  if (moved.length) refuse("analytics-secret-digest-mismatch", moved.map((name) => `secret:${name}`));
}

/** One upload with the same readback as the QA routes, then a preservation check. */
async function deployRoute({
  api,
  upload,
  bytes,
  plan,
  receipt,
  step,
  progress,
  listFunctions,
  listSecrets,
  current,
}) {
  const secretsBefore = await listSecrets();
  const previous = current.find((item) => item.slug === upload.name);
  const body = new FormData();
  body.set(
    "metadata",
    JSON.stringify({
      name: upload.name,
      entrypoint_path: upload.file,
      verify_jwt: upload.verifyJwt,
    }),
  );
  body.append("file", new Blob([bytes], { type: "application/javascript" }), upload.file);
  step(upload.name, OUTCOME_UNKNOWN);
  receipt.status = "uploading";
  receipt.writeAttempted = true;
  receipt.attemptedRoute = upload.name;
  await progress(); // Durable attempt precedes the potentially ambiguous network write.
  const posted = await api(`/functions/deploy?slug=${upload.name}`, { body });
  const metadata = await readback({ api, upload, posted, bytes, projectRef: plan.projectRef });
  if (
    metadata.version !== (previous?.version ?? 0) + 1 ||
    (previous && (metadata.id !== previous.id || metadata.created_at !== previous.created_at))
  ) refuse("analytics-deployed-version-differs");
  const expected = [...current.filter((item) => item.slug !== upload.name), metadata]
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (!same(await listFunctions(), expected)) refuse("analytics-preservation-failed");
  if (!same(await listSecrets(), secretsBefore)) refuse("analytics-preservation-failed");
  step(upload.name, previous ? "deployed" : "created");
  receipt.status = "upload-verified";
  await progress();
}

async function secretsOperation({
  plan,
  receipt,
  step,
  progress,
  digest,
  before,
  secretsApi,
  exec,
  cwd,
  conn,
  path,
  facts,
  roleFacts,
  randomBytesImpl,
  secretValues,
}) {
  const rotate = plan.mode === "rotate";
  const has = (name) => digest.has(name);
  const eraserLogin = before.facts.eraser === "login";
  let eraser;
  if (rotate) eraser = "rotate";
  else if (has(ERASER_URL_SECRET) && eraserLogin) eraser = "none";
  else if (!has(ERASER_URL_SECRET) && !eraserLogin) eraser = "install";
  // A URL without LOGIN, or LOGIN without a URL: someone else may hold a password. Only rotate decides.
  else refuse("analytics-eraser-mismatch");
  let token;
  const tokenMatches = before.facts.vaultTokens === 1 &&
    before.facts.vaultTokenSha256 === digest.get(WORKER_TOKEN_SECRET);
  if (rotate) token = "rotate";
  else if (has(WORKER_TOKEN_SECRET) && tokenMatches) token = "none";
  else if (!has(WORKER_TOKEN_SECRET) && before.facts.vaultTokens === 0) token = "install";
  else refuse("analytics-worker-token-mismatch");
  const eventId = has(EVENT_ID_SECRET) ? "none" : "install";
  step(ERASER_URL_SECRET, eraser === "none" ? "unchanged" : "pending");
  step(`role ${ERASER_ROLE}`, eraser === "none" ? "unchanged" : "pending");
  step(WORKER_TOKEN_SECRET, token === "none" ? "unchanged" : "pending");
  step(`vault ${VAULT_TOKEN_NAME}`, token === "none" ? "unchanged" : "pending");
  step(EVENT_ID_SECRET, eventId === "none" ? "unchanged" : "pending");
  if (eraser === "none" && token === "none" && eventId === "none") {
    receipt.status = "no-change";
    await progress();
    return;
  }
  await requirePsql16(exec, cwd);
  const roleFactsBefore = await roleFacts();

  // Every value for this run is generated up front, in memory only.
  const password = eraser === "none" ? null : generatePassword(randomBytesImpl);
  const workerToken = token === "none" ? null : generatePassword(randomBytesImpl);
  const eventSecret = eventId === "none" ? null : generatePassword(randomBytesImpl);
  const body = [];
  const expected = new Map(digest);
  const add = (name, value) => {
    assertWritableSecret(name);
    secretValues.set(name, value);
    body.push({ name, value });
    expected.set(name, sha256(value));
  };
  if (password) add(ERASER_URL_SECRET, eraserDbUrl(plan.projectRef, password));
  if (workerToken) add(WORKER_TOKEN_SECRET, workerToken);
  if (eventSecret) add(EVENT_ID_SECRET, eventSecret);
  const variables = {};
  if (password) {
    variables.STILL_ANALYTICS_ERASER_VERIFIER = scramSha256Verifier(password, {
      salt: Buffer.from(randomBytesImpl(16)),
    });
  }
  if (workerToken) variables.STILL_ANALYTICS_WORKER_TOKEN = workerToken;

  const writeSecrets = async () => {
    for (const item of body) step(item.name, OUTCOME_UNKNOWN);
    receipt.status = "writing-secrets";
    receipt.writeAttempted = true;
    await progress(); // Durable attempt precedes the write.
    await secretsApi.write("POST", body);
    await verifySecrets(() => secretsApi.list(), expected);
    for (const item of body) {
      step(item.name, digest.has(item.name) ? "replaced" : "installed");
    }
    await progress();
  };
  const writeDatabase = async () => {
    if (!Object.keys(variables).length) return;
    if (password) step(`role ${ERASER_ROLE}`, OUTCOME_UNKNOWN);
    if (workerToken) step(`vault ${VAULT_TOKEN_NAME}`, OUTCOME_UNKNOWN);
    receipt.status = "writing-database";
    receipt.writeAttempted = true;
    await progress();
    const ran = await runPinnedSql({
      exec,
      cwd,
      conn,
      file: path(ANALYTICS_SQL.secrets),
      variables,
      single: true,
    });
    if (ran.code !== 0) refuse("analytics-secrets-sql-failed");
    const after = await facts();
    if (after.eraser !== "login") refuse("analytics-eraser-cannot-sign-in");
    if (workerToken && after.vaultTokenSha256 !== sha256(workerToken)) {
      refuse("analytics-vault-token-mismatch");
    }
    if (!workerToken && after.vaultTokenSha256 !== before.facts.vaultTokenSha256) {
      refuse("analytics-preservation-failed");
    }
    // Every role fact is unchanged except, at most, the eraser's login switching on.
    const expectedFacts = new Set(roleFactsBefore);
    expectedFacts.delete(`role ${ERASER_ROLE} | login false`);
    expectedFacts.add(`role ${ERASER_ROLE} | login true`);
    const diff = diffFacts([...expectedFacts].sort(), [...(await roleFacts())].sort());
    if (diff.added.length || diff.removed.length) refuse("analytics-role-facts-changed");
    if (password) {
      const ok = await probeLogin({
        exec,
        cwd,
        conn,
        projectRef: plan.projectRef,
        role: ERASER_ROLE,
        password,
      });
      if (!ok) refuse("analytics-eraser-probe-failed");
      step(`role ${ERASER_ROLE}`, rotate && before.facts.eraser === "login" ? "password-rotated" : "login-set");
    }
    if (workerToken) {
      step(`vault ${VAULT_TOKEN_NAME}`, before.facts.vaultTokens ? "replaced" : "installed");
    }
    await progress();
  };
  if (rotate) {
    // Password first: a failed ALTER ROLE leaves every login and URL as it was.
    await writeDatabase();
    await writeSecrets();
  } else {
    // Install: secrets first; a failure before LOGIN leaves only an unused URL.
    await writeSecrets();
    await writeDatabase();
  }
  // The Vault token and the function secret must end equal (digests only).
  const final = await facts();
  const finalDigests = new Map((await secretsApi.list()).map((item) => [item.name, item.digest]));
  if (final.vaultTokens !== 1 || final.vaultTokenSha256 !== finalDigests.get(WORKER_TOKEN_SECRET)) {
    refuse("analytics-vault-token-mismatch");
  }
}

// ── Public records (names, outcomes, counts and fixed codes only) ─────────────────────────────

const DESCRIPTIONS = {
  [SECRETS_OP]: {
    apply:
      "Generate in runner memory and install `ANALYTICS_ERASER_DB_URL`, `ANALYTICS_ERASURE_WORKER_TOKEN` and `ANALYTICS_EVENT_ID_SECRET`; give `still_analytics_eraser` LOGIN with a SCRAM-SHA-256 verifier; store the worker token in Vault for the schedule. Never replaces an existing value (a mixed state refuses and names rotate).",
    rotate:
      "Change the eraser password first, then rewrite `ANALYTICS_ERASER_DB_URL`, a new `ANALYTICS_ERASURE_WORKER_TOKEN` and its Vault copy. `ANALYTICS_EVENT_ID_SECRET` is kept (installed only if absent).",
  },
  [FUNCTIONS_OP]: {
    none:
      "Deploy exactly `analytics-erasure`, `analytics-identify`, then `delete-user` as sealed single-file bundles from this commit, each read back byte for byte. A route already at this source is left alone.",
  },
  [SCHEDULE_OP]: {
    enable:
      "Schedule `still-analytics-erasure-worker` (pg_cron, every 15 minutes; pg_net created if absent) to POST `{\"action\":\"work\"}` to `analytics-erasure` with the token read from Vault at run time.",
    disable:
      "Remove only the `still-analytics-erasure-worker` job. Queued deletions wait until it is enabled again.",
  },
  [SWITCH_OP]: {
    enable:
      "Set `ANALYTICS_SUBJECTS_ENABLED=true`, then redeploy `analytics-identify` from this commit.",
    disable:
      "Set `ANALYTICS_SUBJECTS_ENABLED=false`, then redeploy `analytics-identify` from this commit. No other gate: this is the way back.",
  },
};

export function renderAnalyticsPlan(plan) {
  const what = DESCRIPTIONS[plan.operation]?.[plan.operation === SECRETS_OP ? (plan.mode === "rotate" ? "rotate" : "apply") : plan.policyMode] ?? "";
  const gates = plan.operation === SECRETS_OP || plan.operation === FUNCTIONS_OP || plan.policyMode === "enable";
  return [
    `## Analytics ${plan.operation}${plan.policyMode !== "none" ? ` ${plan.policyMode}` : ""} (${plan.mode})`,
    "",
    `- Digest: \`${plan.digest}\`; commit \`${plan.revision}\` on main (workflow from \`${plan.workflowRevision}\`)${plan.onFirstParent ? "" : " ⚠️ reached main through a merged branch; allowed only because every bound file is identical"}; project ref bound.`,
    `- What it does: ${what}`,
    ...(gates
      ? ["- Refuses before any write unless: migration history holds 0017 and 0018 and 0018's check is clean; the \"Supabase settings rehearsal\" (GoTrue deletion) succeeded on this exact commit; and this step's own prerequisites hold (see docs/release/posthog-analytics.md)."]
      : ["- No prerequisite gate beyond owner approval: this is the way back."]),
    `- Pinned SQL: ${Object.values(ANALYTICS_SQL).map((pin) => `\`${pin.path.split("/").at(-1)}\` \`${pin.sha256.slice(0, 12)}…\``).join(", ")}.`,
    ...(plan.bundles
      ? [`- Bundles: ${plan.bundles.functions.map((f) => `\`${f.name}\` \`${f.sha256.slice(0, 12)}…\``).join(", ")} (${plan.bundles.sources.length} bound source files).`]
      : []),
    `- Schedule command SHA-256: \`${plan.workerCommandSha256.slice(0, 12)}…\`. Writable secret names: ${plan.writable.map((name) => `\`${name}\``).join(", ")}.`,
    `- Approval environment \`${ENVIRONMENT_NAME}\`; ${plan.mode === "plan-only" ? "a plan-only run reads no secret and writes nothing" : "the plan job reads no secret"}.`,
    "- No value, password, verifier, digest of a secret, email, account id or PostHog data appears in this plan, the logs or the closing record.",
    "",
  ].join("\n");
}

export function renderAnalyticsFinal(receipt, { applyOutcome, operation } = {}) {
  if (!receipt) {
    if (applyOutcome === "skipped") {
      return "## Analytics closing record\n\n- Status: stopped-before-write.\n- The apply step was skipped; nothing was written.\n";
    }
    return `## Analytics closing record\n\nOutcome unknown: no durable receipt for ${operation ? `\`${operation}\`` : "this run"}. Stop; check the analytics secrets, the eraser login, the schedule and the three routes privately, then recover with the counterpart. Never blindly retry.\n`;
  }
  if (receipt.writeAttempted && !["verified", "no-change", OUTCOME_UNKNOWN].includes(receipt.status)) {
    receipt = { ...receipt, status: OUTCOME_UNKNOWN, recovery: recoveryFor(receipt) };
  }
  const counts = Object.entries(receipt.counts ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => `${name} ${n}`).join(", ") || "none";
  return [
    "## Analytics closing record",
    "",
    `- Operation: ${receipt.operation ?? "unknown"}${receipt.policyMode && receipt.policyMode !== "none" ? ` ${receipt.policyMode}` : ""}; mode ${receipt.mode ?? "unknown"}; status: ${receipt.status}.`,
    `- Write attempted: ${receipt.writeAttempted}; steps: ${counts}.`,
    `- Fixed issue codes: ${receipt.issues.join(", ") || "none"}.`,
    `- Recovery: ${receipt.recovery}`,
    "",
    ...(receipt.steps.length
      ? ["| Step | Outcome |", "|---|---|", ...receipt.steps.map((item) => `| \`${item.name}\` | ${item.outcome} |`), ""]
      : []),
  ].join("\n");
}

// ── Rehearsal on the runner's throwaway database (plan job; no secret, no network) ─────────────

export const REHEARSAL_REPOSITORY = "still-rehearsal/still-app";
const ROUTE_NAMES = ["analytics-erasure", "analytics-identify", "delete-user"];

/** In-memory Management API (secrets and functions) and GitHub reads. Synthetic values only. */
export function rehearsalApi(projectRef) {
  const secrets = new Map(POSTHOG_SECRETS.map((name) => [name, `rehearsal-${name.toLowerCase()}`]));
  const functions = new Map();
  const bodies = new Map();
  const calls = { secretPosts: 0, deploys: 0 };
  let rehearsalGreen = true;
  let nextId = 1;
  const stamp = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  // Live production routes before this change: deployed long ago by the CLI, with other bytes.
  for (const [slug, version] of [["analytics-identify", 1], ["delete-user", 18]]) {
    functions.set(slug, {
      id: `rehearsal-${nextId++}`, slug, name: slug, status: "ACTIVE", version, verify_jwt: true,
      import_map: true, import_map_path: "/tmp/deno.json", entrypoint_path: `/tmp/source/${slug}/index.ts`,
      ezbr_sha256: sha256(slug), created_at: stamp(1), updated_at: stamp(2),
    });
    bodies.set(slug, { file: "index.ts", bytes: Buffer.from(`// legacy ${slug}`) });
  }
  const json = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const root = `https://api.supabase.com/v1/projects/${projectRef}`;
  const github = `https://api.github.com/repos/${REHEARSAL_REPOSITORY}`;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const bearer = new Headers(init.headers).get("Authorization") ?? "";
    // A token whose name says "secrets" stands for the Secrets-only token: functions refuse it.
    if (url.startsWith(`${root}/functions`) && bearer.includes("secrets")) return json(403, { message: "forbidden" });
    if (url === `${root}/secrets`) {
      if (method === "GET") {
        return json(200, [...secrets].map(([name, value]) => ({ name, value: sha256(value) })));
      }
      if (method === "POST") {
        calls.secretPosts++;
        for (const { name, value } of JSON.parse(init.body)) secrets.set(name, value);
        return json(201);
      }
    }
    if (url === `${root}/functions` && method === "GET") return json(200, [...functions.values()]);
    const deploy = /^.*\/functions\/deploy\?slug=([a-z0-9-]+)$/.exec(url);
    if (deploy && url.startsWith(root) && method === "POST") {
      calls.deploys++;
      const slug = deploy[1];
      const meta = JSON.parse(init.body.get("metadata"));
      const file = init.body.get("file");
      const bytes = Buffer.from(await file.arrayBuffer());
      const previous = functions.get(slug);
      const now = stamp(10 + calls.deploys);
      const item = {
        id: previous?.id ?? `rehearsal-${nextId++}`, slug, name: meta.name, status: "ACTIVE",
        version: (previous?.version ?? 0) + 1, verify_jwt: meta.verify_jwt, import_map: false,
        import_map_path: null, entrypoint_path: `/tmp/user_fn/source/${meta.entrypoint_path}`,
        ezbr_sha256: sha256(bytes), created_at: previous?.created_at ?? now, updated_at: now,
      };
      functions.set(slug, item);
      bodies.set(slug, { file: meta.entrypoint_path, bytes });
      return json(201, item);
    }
    const one = new RegExp(`^${root.replace(/[.?]/g, "\\$&")}/functions/([a-z0-9-]+)(/body)?$`).exec(url);
    if (one && method === "GET") {
      const item = functions.get(one[1]);
      if (!item) return json(404, { message: "not found" });
      if (!one[2]) return json(200, item);
      const stored = bodies.get(one[1]);
      const form = new FormData();
      form.set("metadata", JSON.stringify({
        deno2_entrypoint_path: `source/${stored.file}`,
        deployment_id: `${projectRef}_${item.id}_${item.version}`,
        original_size: stored.bytes.length,
      }));
      form.append("file", new Blob([stored.bytes]), `source/${stored.file}`);
      return new Response(form, { status: 200 });
    }
    const env = encodeURIComponent(ENVIRONMENT_NAME);
    if (url === `${github}/environments/${env}`) {
      return json(200, {
        id: 1, name: ENVIRONMENT_NAME, can_admins_bypass: false,
        protection_rules: [{ type: "required_reviewers", prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { id: OWNER_REVIEWER_ID } }] }],
        deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
      });
    }
    if (url === `${github}/environments/${env}/deployment-branch-policies?per_page=100`) {
      return json(200, { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] });
    }
    if (url === `${github}/actions/runs/1/approvals`) {
      return json(200, [{ state: "approved", user: { id: OWNER_REVIEWER_ID }, environments: [{ id: 1 }] }]);
    }
    const runs = /\/actions\/workflows\/supabase-settings-rehearsal\.yml\/runs\?head_sha=([a-f0-9]{40})&/.exec(url);
    if (url.startsWith(github) && runs) {
      return json(200, {
        workflow_runs: rehearsalGreen
          ? [{ head_sha: runs[1], conclusion: "success", path: REHEARSAL_WORKFLOW }]
          : [],
      });
    }
    return json(404, { message: "not found" });
  };
  return {
    secrets, functions, calls, fetchImpl,
    setRehearsalGreen: (value) => { rehearsalGreen = value; },
  };
}

/** Points the module's psql calls at the runner's own database (exact role names kept). */
function localExec(exec, local, projectRef, adminPassword) {
  return (cmd, args, opts = {}) => {
    if (cmd !== "psql" || !opts.env) return exec(cmd, args, opts);
    const env = { ...opts.env };
    env.PGHOST = local.host;
    env.PGPORT = local.port;
    env.PGSSLMODE = "disable";
    env.PGUSER = String(env.PGUSER ?? "").replace(`.${projectRef}`, "");
    if (env.PGUSER === "postgres" && env.PGPASSWORD === adminPassword) env.PGPASSWORD = local.password;
    return exec(cmd, args, { ...opts, env });
  };
}

/** A sibling plan for another operation of the same commit (rehearsal only), with a fresh digest. */
export function siblingPlan(plan, { operation, mode, policyMode, bundles }) {
  const { digest: _old, ...rest } = plan;
  const next = { ...rest, operation, mode, policyMode, bundles };
  return { ...next, digest: sha256(canonical(next)) };
}

/**
 * Plan-job rehearsal of the whole lifecycle through the exact module code path, against the
 * runner's throwaway database (all migrations applied) with the Management API and GitHub stubbed
 * in memory. Synthetic bundles stand in for the real ones (the bundle compiler has its own tests).
 * Negative controls first, then: secrets apply, repeat (no change), functions, schedule enable,
 * switch enable (refused without worker evidence, then allowed), switch disable, schedule disable,
 * and secrets rotate.
 */
export async function runAnalyticsReplay({ exec, plan, dir, conn, cwd, log = () => {} }) {
  if (!isLoopback(conn)) {
    throw new Refusal("replay-not-local", "Replay only runs against the runner's own database");
  }
  const ref = plan.projectRef;
  const adminPassword = randomBytes(18).toString("hex");
  const api = rehearsalApi(ref);
  const run = localExec(exec, conn, ref, adminPassword);
  const proofs = [];
  const prove = (name, ok, detail) => {
    proofs.push(detail ? { name, ok, detail } : { name, ok });
    log(`${ok ? "PROVED" : "NOT PROVED"} ${name}${detail ? `: ${detail}` : ""}`);
  };
  const artifactDir = join(dir, ".rehearsal-uploads");
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  const functions = [];
  for (const name of ROUTE_NAMES) {
    const file = `${name}.js`;
    const bytes = Buffer.from(`// rehearsal bundle ${name} ${randomBytes(8).toString("hex")}\n`);
    await writeFile(join(artifactDir, file), bytes);
    functions.push({ name, verifyJwt: name !== "analytics-erasure", file, sha256: sha256(bytes), bytes: bytes.length });
  }
  const bundles = { protocol: 1, kind: ANALYTICS_BUNDLE_SET.kind, toolchain: {}, sources: [], functions };
  const planFor = (operation, mode, policyMode = "none") =>
    siblingPlan(plan, { operation, mode, policyMode, bundles: ANALYTICS_OPERATIONS[operation].bundles ? bundles : null });
  const envFor = (p, extra = {}) => ({
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: REHEARSAL_REPOSITORY,
    GITHUB_RUN_ID: "1",
    GH_TOKEN: "rehearsal",
    EXPECTED_PLAN_DIGEST: p.digest,
    DEPLOY_MODE: p.mode,
    DEPLOY_OPERATION: p.operation,
    DEPLOY_POLICY_MODE: p.policyMode,
    SUPABASE_PRODUCTION_PROJECT_REF: ref,
    SUPABASE_DB_URL: `postgresql://postgres:${adminPassword}@db.${ref}.supabase.co:5432/postgres?sslmode=require`,
    [FUNCTIONS_TOKEN_ENV]: p.operation === SECRETS_OP ? "" : `rehearsal-functions-${randomBytes(8).toString("hex")}`,
    [SECRETS_TOKEN_ENV]: [SECRETS_OP, SWITCH_OP].includes(p.operation) ? `rehearsal-secrets-${randomBytes(8).toString("hex")}` : "",
    ...extra,
  });
  const receipts = [];
  // The provider proof needs the real analytics-erasure function and PostHog: stand-ins here
  // (its SQL is exercised for real below; the function side has its own Deno tests).
  let providerAnswer = [];
  const operate = async (p, extra) => {
    const receipt = await runAnalyticsOperation({
      plan: p, env: envFor(p, extra), platform: "linux", cwd, sourceDir: dir, artifactDir,
      exec: run, fetchImpl: api.fetchImpl, verifyBundles: async () => true,
      provider: async () => providerAnswer,
    });
    receipts.push(receipt);
    return receipt;
  };
  const sql = async (text) => {
    const result = await exec("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", text], {
      cwd,
      env: { PGHOST: conn.host, PGPORT: conn.port, PGUSER: conn.user, PGPASSWORD: conn.password,
        PGDATABASE: conn.database, PGSSLMODE: "disable" },
    });
    if (result.code !== 0) throw new Refusal("rehearsal-setup-failed", "Rehearsal query failed");
    return String(result.stdout).trim();
  };
  const signsIn = async (url) => {
    const parsed = new URL(url);
    const result = await exec("psql", ["-X", "-q", "-A", "-t", "-c", "select current_user"], {
      cwd,
      env: { PGHOST: conn.host, PGPORT: conn.port, PGUSER: decodeURIComponent(parsed.username),
        PGPASSWORD: decodeURIComponent(parsed.password), PGDATABASE: "postgres", PGSSLMODE: "disable" },
    });
    return result.code === 0 && String(result.stdout).trim() === decodeURIComponent(parsed.username);
  };
  const login = async () => (await sql(`select rolcanlogin from pg_roles where rolname = '${ERASER_ROLE}'`)) === "t";
  const vaultDigest = async () =>
    sql(`select coalesce(string_agg(encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex'), ','), '') from vault.decrypted_secrets where name = '${VAULT_TOKEN_NAME}'`);
  const version = (slug) => api.functions.get(slug)?.version ?? 0;
  const issues = (r) => [r.status, ...r.issues].join(" ");

  // Negative controls: refused before any write, nothing changed.
  const secretsPlan = planFor(SECRETS_OP, "apply");
  const unapproved = await operate(secretsPlan, { EXPECTED_PLAN_DIGEST: "f".repeat(64) });
  api.setRehearsalGreen(false);
  const noRehearsal = await operate(secretsPlan);
  api.setRehearsalGreen(true);
  const tooEarly = await operate(planFor(FUNCTIONS_OP, "apply"));
  const broadToken = await operate(secretsPlan, { [SECRETS_TOKEN_ENV]: `rehearsal-broad-${randomBytes(8).toString("hex")}` });
  prove(
    "negative controls: an unapproved plan, a commit without a green GoTrue rehearsal, functions before secrets, and a secrets token that can reach functions are refused before any write",
    [unapproved, noRehearsal, tooEarly, broadToken].every((r) => r.status === "stopped-before-write" && !r.writeAttempted) &&
      noRehearsal.issues.includes("gotrue_rehearsal_not_green") &&
      broadToken.issues.includes("secrets_token_too_broad") &&
      tooEarly.issues.includes(`missing_secret:${ERASER_URL_SECRET}`) &&
      api.calls.secretPosts === 0 && api.calls.deploys === 0 && !(await login()),
    `${unapproved.issues[0]}; ${noRehearsal.issues.at(-1)}; ${tooEarly.issues[0]}`,
  );

  const installed = await operate(secretsPlan);
  const url = api.secrets.get(ERASER_URL_SECRET);
  const parsed = url ? new URL(url) : null;
  const wrong = parsed ? new URL(url) : null;
  if (wrong) wrong.password = randomBytes(16).toString("hex");
  prove(
    "secrets apply: verified; three names written; the eraser URL uses the direct host and exact role and its new password signs in (a wrong one is refused); the Vault token equals the secret",
    installed.status === "verified" &&
      [ERASER_URL_SECRET, EVENT_ID_SECRET, WORKER_TOKEN_SECRET].every((name) => api.secrets.has(name)) &&
      !api.secrets.has(SWITCH_SECRET) && parsed?.hostname === `db.${ref}.supabase.co` &&
      decodeURIComponent(parsed?.username ?? "") === ERASER_ROLE && (await login()) &&
      (await signsIn(url)) && !(await signsIn(wrong.href)) &&
      (await vaultDigest()) === sha256(api.secrets.get(WORKER_TOKEN_SECRET)),
    issues(installed),
  );
  const posts = api.calls.secretPosts;
  const again = await operate(secretsPlan);
  prove("secrets apply again: no change, nothing written", again.status === "no-change" && api.calls.secretPosts === posts, issues(again));

  const scheduleEarly = await operate(planFor(SCHEDULE_OP, "apply", "enable"));
  const functionsRun = await operate(planFor(FUNCTIONS_OP, "apply"));
  const functionsAgain = await operate(planFor(FUNCTIONS_OP, "apply"));
  prove(
    "functions: the schedule refuses before analytics-erasure is at source; then exactly the three routes deploy in order and read back; a repeat changes nothing",
    scheduleEarly.status === "stopped-before-write" && scheduleEarly.issues.includes("function_not_at_source:analytics-erasure") &&
      functionsRun.status === "verified" && functionsAgain.status === "no-change" &&
      version("analytics-erasure") === 1 && version("analytics-identify") === 2 && version("delete-user") === 19 &&
      api.calls.deploys === 3 && functionsRun.steps.map((s) => s.name).join(",") === ROUTE_NAMES.join(","),
    `${issues(functionsRun)}; again ${functionsAgain.status}`,
  );

  const switchEarly = await operate(planFor(SWITCH_OP, "apply", "enable"));
  const scheduled = await operate(planFor(SCHEDULE_OP, "apply", "enable"));
  const scheduledAgain = await operate(planFor(SCHEDULE_OP, "apply", "enable"));
  const job = await sql(`select schedule || '|' || active::text || '|' || encode(sha256(convert_to(command, 'UTF8')), 'hex') from cron.job where jobname = '${CRON_JOB}'`);
  prove(
    "schedule enable: the switch refuses without a schedule; the job is created with the exact command, every 15 minutes, active; a repeat changes nothing",
    switchEarly.status === "stopped-before-write" && switchEarly.issues.includes("schedule_missing") &&
      scheduled.status === "verified" && scheduledAgain.status === "no-change" &&
      job === `${CRON_SCHEDULE}|true|${plan.workerCommandSha256}`,
    `${issues(scheduled)}; again ${scheduledAgain.status}`,
  );

  // The provider proof's own SQL, for real: it queues one pg_net request (the worker token read from
  // Vault in the database) and its read-back parses. The request cannot reach a function here.
  const probeConn = parseDbUrl(envFor(planFor(SWITCH_OP, "apply", "enable")).SUPABASE_DB_URL);
  const probe = await proveProvider({ exec: run, cwd, conn: probeConn, sourceDir: dir, projectRef: ref, polls: 5 });
  prove(
    "provider proof SQL: one request is queued through pg_net and its answer is read back (here it cannot reach the function, so it refuses)",
    probe.length === 1 && ["provider_check_http_none", "provider_check_unanswered"].includes(probe[0]),
    probe.join(" "),
  );

  const noEvidence = await operate(planFor(SWITCH_OP, "apply", "enable"));
  // Synthetic evidence of scheduled runs and worker answers (rehearsal only).
  await sql(`insert into cron.job_run_details (jobid, runid, status, start_time, end_time) select j.jobid, 900000001, 'succeeded', now(), now() from cron.job j where j.jobname = '${CRON_JOB}'`);
  await sql(`insert into net._http_response (id, status_code, content, created) values (900000003, 200, '{"claimed":2,"advanced":1,"failed":1,"lost":0,"overdue":0,"batches":1}', now())`);
  const failing = await operate(planFor(SWITCH_OP, "apply", "enable"));
  await sql(`insert into net._http_response (id, status_code, content, created) values (900000001, 200, '{"claimed":0,"advanced":0,"failed":0,"lost":0,"overdue":0,"skipped":"provider_unconfigured"}', now())`);
  const skipped = await operate(planFor(SWITCH_OP, "apply", "enable"));
  await sql(`insert into net._http_response (id, status_code, content, created) values (900000002, 200, '{"claimed":0,"advanced":0,"failed":0,"lost":0,"overdue":0,"batches":0}', now())`);
  providerAnswer = ["provider:project_key_mismatch"];
  const wrongProject = await operate(planFor(SWITCH_OP, "apply", "enable"));
  providerAnswer = [];
  const identifyBefore = version("analytics-identify");
  const enabled = await operate(planFor(SWITCH_OP, "apply", "enable"));
  prove(
    "switch enable: refused without a scheduled run and a clean worker answer, while the worker fails jobs, while it skips (PostHog deletion unconfigured), and when the provider proof fails; then sets the switch to true and redeploys analytics-identify",
    noEvidence.status === "stopped-before-write" && noEvidence.issues.includes("schedule_not_running") &&
      noEvidence.issues.includes("worker_not_succeeding") &&
      failing.issues.includes("worker_failing") &&
      skipped.status === "stopped-before-write" && skipped.issues.includes("worker_provider_unconfigured") &&
      wrongProject.status === "stopped-before-write" && wrongProject.issues.includes("provider:project_key_mismatch") &&
      enabled.status === "verified" && api.secrets.get(SWITCH_SECRET) === "true" &&
      version("analytics-identify") === identifyBefore + 1,
    issues(enabled),
  );

  const disabled = await operate(planFor(SWITCH_OP, "apply", "disable"));
  const disabledAgain = await operate(planFor(SWITCH_OP, "apply", "disable"));
  prove(
    "switch disable: sets the switch to false and redeploys analytics-identify; a repeat changes nothing",
    disabled.status === "verified" && api.secrets.get(SWITCH_SECRET) === "false" &&
      version("analytics-identify") === identifyBefore + 2 && disabledAgain.status === "no-change",
    issues(disabled),
  );

  const unscheduled = await operate(planFor(SCHEDULE_OP, "apply", "disable"));
  const unscheduledAgain = await operate(planFor(SCHEDULE_OP, "apply", "disable"));
  prove(
    "schedule disable: the job is removed, nothing else; a repeat changes nothing",
    unscheduled.status === "verified" && unscheduledAgain.status === "no-change" &&
      (await sql(`select count(*) from cron.job where jobname = '${CRON_JOB}'`)) === "0" && (await login()),
    issues(unscheduled),
  );

  const oldUrl = api.secrets.get(ERASER_URL_SECRET);
  const oldToken = api.secrets.get(WORKER_TOKEN_SECRET);
  const oldEvent = api.secrets.get(EVENT_ID_SECRET);
  // Rotate is the recovery path: it does not need the GoTrue rehearsal on this commit.
  api.setRehearsalGreen(false);
  const rotated = await operate(planFor(SECRETS_OP, "rotate"));
  api.setRehearsalGreen(true);
  const newUrl = api.secrets.get(ERASER_URL_SECRET);
  prove(
    "secrets rotate (without the rehearsal gate): the eraser password and worker token change in every place (old password refused, new one signs in, Vault equals the new token); the event id secret is kept",
    rotated.status === "verified" && newUrl !== oldUrl && (await signsIn(newUrl)) && !(await signsIn(oldUrl)) &&
      api.secrets.get(WORKER_TOKEN_SECRET) !== oldToken && api.secrets.get(EVENT_ID_SECRET) === oldEvent &&
      (await vaultDigest()) === sha256(api.secrets.get(WORKER_TOKEN_SECRET)),
    issues(rotated),
  );

  const printed = JSON.stringify(receipts);
  // The switch's own value ("true"/"false") is not a secret and is left out of this check.
  const values = [...api.secrets].filter(([name]) => name !== SWITCH_SECRET).map(([, value]) => value);
  prove(
    "no value, password, URL or digest of a secret appears in any receipt",
    [...values, oldUrl, oldToken].filter(Boolean)
      .every((value) => !printed.includes(value) && !printed.includes(sha256(value))),
  );
  return {
    kind: ANALYTICS_KIND,
    status: proofs.every((p) => p.ok) ? "verified" : "rehearsal-failed",
    operation: plan.operation,
    proofs,
  };
}

export function renderAnalyticsReplay(result) {
  return [
    `## Rehearsal of the analytics operations (planned: \`${result.operation}\`) on a throwaway database (no production access; Management API and GitHub stubbed): ${result.status}`,
    "",
    ...result.proofs.map((p) => `- ${p.ok ? "✅" : "❌"} ${p.name}${p.detail ? ` — ${p.detail}` : ""}`),
    "",
  ].join("\n");
}
