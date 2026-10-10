// The qa-sandbox-secrets operation in the protected `Supabase production deploy` workflow: binds the
// secrets module (qa-secrets.mjs, which does the work and owns its own guarantees) to the same
// commit-on-main, tooling, plan-digest, freshness, approval and closing-record contract as every
// other operation, and rehearses it on the runner's throwaway database.
//
// Modes are the workflow `mode` input: plan-only (no secret at all), apply, rotate, disable. Only
// the apply step of this operation receives SUPABASE_QA_SECRETS_ACCESS_TOKEN and the QA_STAGE_*
// values (see the workflow); the plan job never sees a secret.
//
// Rehearsal (plan job, no secret, no network): the module runs unchanged against the runner's own
// database. Its psql calls are pointed at that database (the role names stay exact, so the new
// SCRAM passwords really sign in) and its Management API and GitHub reads are answered by an
// in-memory stub. Synthetic values only; nothing leaves the runner.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  OPERATIONS_DIR,
  OWNER_REVIEWER_ID,
  ENVIRONMENT_NAME,
  Refusal,
  TOOLING_PATHS,
  canonical,
  isLoopback,
  sha256,
} from "./deploy.mjs";
import { prepareQaSource } from "./qa-functions.mjs";
import {
  DISABLE_SECRETS,
  QA_ROLE_LOGINS,
  QA_SECRETS_KIND,
  QA_SECRETS_MODES,
  QA_SECRETS_OPERATION,
  QA_SECRETS_TOKEN_ENV,
  STAGED_SECRETS,
  createQaSecretsPlan,
  renderQaSecretsFinal,
  renderQaSecretsPlan,
  runQaSecretsOperation,
} from "./qa-secrets.mjs";

export {
  QA_SECRETS_KIND,
  QA_SECRETS_MODES,
  QA_SECRETS_OPERATION,
  STAGED_SECRETS,
  renderQaSecretsFinal,
};

/**
 * Every file the secrets operation's run depends on, bound by hash and checked for freshness: the
 * deploy tooling plus the whole module import closure of this file and deploy.mjs (a test derives
 * the closure from the import statements and requires it to be listed here).
 */
export const SECRETS_TOOLING = Object.freeze(
  [
    ...new Set([
      ...TOOLING_PATHS,
      "scripts/backend/deploy/analytics-subjects.mjs",
      "scripts/backend/deploy/qa-function-bundles.mjs",
      "scripts/backend/deploy/qa-functions.mjs",
      "scripts/backend/deploy/qa-secrets.mjs",
      "scripts/backend/deploy/qa-secrets-operation.mjs",
    ]),
  ].sort(),
);

const isBlank = (text) => String(text ?? "").trim() === "";

/**
 * The plan: the module's own plan (mode, pinned SQL, allowlisted names) extended with the commit on
 * main, the workflow revision and the tooling hashes, under one digest. Needs no secret.
 */
export async function createSecretsOperationPlan({
  git,
  sha,
  mainRef = "HEAD",
  cwd,
  exec,
  sourceDir,
  projectRef,
  mode = "plan-only",
  migrations = "",
  functions = "",
}) {
  if (!isBlank(migrations) || !isBlank(functions))
    throw new Refusal(
      "operation-with-migrations",
      "An operation runs alone: leave the migration and function lists empty",
    );
  if (!/^[0-9a-f]{40}$/.test(String(sha ?? "")))
    throw new Refusal(
      "input-invalid",
      "Commit must be a full 40-character lowercase SHA",
    );
  if (!QA_SECRETS_MODES.includes(mode))
    throw new Refusal(
      "mode-invalid",
      `qa-sandbox-secrets takes mode ${QA_SECRETS_MODES.join(", ")}`,
    );
  const workflowRevision = await git.commit(mainRef);
  if (
    (await git.commit(sha)) !== sha ||
    !(await git.isAncestor(sha, workflowRevision))
  )
    throw new Refusal(
      "not-on-main",
      "The commit is not on main; only merged, reviewed commits can run an operation",
    );
  if (!sourceDir)
    throw new Refusal("input-invalid", "The secrets plan needs --source-dir");
  await prepareQaSource({ exec, cwd, revision: sha, sourceDir });
  const inner = await createQaSecretsPlan({
    mode,
    projectRef,
    sourceDir,
    revision: sha,
  });
  const tooling = [];
  for (const path of SECRETS_TOOLING) {
    const atSha = await git.blob(sha, path);
    const onMain = await git.blob(workflowRevision, path);
    if (!onMain)
      throw new Refusal("tooling-missing", `${path} missing on main`);
    if (!atSha || sha256(atSha) !== sha256(onMain))
      throw new Refusal(
        "file-changed-on-main",
        `${path} differs between the commit and main`,
      );
    tooling.push({ path, sha256: sha256(onMain) });
  }
  for (const file of inner.files) {
    const onMain = await git.blob(workflowRevision, file.path);
    if (!onMain || sha256(onMain) !== file.sha256)
      throw new Refusal(
        "file-changed-on-main",
        `${file.path} differs between the commit and main`,
      );
  }
  const { digest: _inner, ...manifest } = inner;
  const plan = {
    ...manifest,
    workflowRevision,
    onFirstParent: await git.onFirstParent(sha, workflowRevision),
    tooling,
  };
  return { ...plan, digest: sha256(canonical(plan)) };
}

/**
 * The protected apply: the module itself re-checks production context, owner approval, the plan
 * digest, mode and target, and every pinned file in the exact-commit source, then writes.
 */
export const runSecretsOperation = (options) => runQaSecretsOperation(options);

/** Bound files for the freshness check: the module's SQL and role facts, plus the tooling. */
export const secretsBoundFiles = (plan) => [...plan.files, ...plan.tooling];

export function renderSecretsOperationPlan(plan) {
  return [
    renderQaSecretsPlan(plan),
    `- Commit \`${plan.revision}\` on main (workflow from \`${plan.workflowRevision}\`)${plan.onFirstParent ? "" : " ⚠️ reached main through a merged branch; allowed only because every bound file is identical"}.`,
    `- Approval environment \`${ENVIRONMENT_NAME}\`: only its apply step receives \`${QA_SECRETS_TOKEN_ENV}\` and the ${STAGED_SECRETS.length} \`QA_STAGE_*\` values; ${plan.mode === "plan-only" ? "a plan-only run reads no secret and writes nothing" : "the plan job reads no secret"}.`,
    `- Bound tooling: ${plan.tooling.length} files (workflow, deploy tools and this module), checked again before the run.`,
    "",
  ].join("\n");
}

/** The exact commit's database and the module's files, for the rehearsal (and its hash check). */
export async function prepareSecretsWorkdir({ exec, cwd, plan, dir }) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const tarball = join(dir, ".source.tar");
  for (const [cmd, args] of [
    [
      "git",
      [
        "archive",
        "--format=tar",
        `--output=${tarball}`,
        plan.revision,
        "supabase",
        OPERATIONS_DIR,
        "scripts/backend/deploy/sql",
      ],
    ],
    ["tar", ["-xf", tarball, "-C", dir]],
  ]) {
    const result = await exec(cmd, args, { cwd });
    if (result.code !== 0)
      throw new Refusal("workdir-failed", "Could not extract the exact commit");
  }
  await rm(tarball, { force: true });
  await rm(join(dir, "supabase", ".temp"), { recursive: true, force: true });
  for (const file of plan.files) {
    let bytes;
    try {
      bytes = await readFile(join(dir, file.path));
    } catch {
      bytes = null;
    }
    if (!bytes || sha256(bytes) !== file.sha256)
      throw new Refusal(
        "hash-mismatch",
        `${file.path} hash differs from the plan`,
      );
  }
  return dir;
}

// ── Rehearsal on the runner's throwaway database ───────────────────────────────────────────────

const REHEARSAL_REPOSITORY = "still-rehearsal/still-app";

/** In-memory Management API secrets store and GitHub protection read-back (rehearsal only). */
function rehearsalApi(projectRef) {
  const store = new Map();
  const calls = { post: 0, delete: 0 };
  const environmentId = 1;
  const reply = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url === `https://api.supabase.com/v1/projects/${projectRef}/secrets`) {
      if (method === "GET")
        return reply(
          200,
          [...store].map(([name, value]) => ({ name, value: sha256(value) })),
        );
      const body = JSON.parse(init.body);
      if (method === "POST") {
        calls.post++;
        for (const { name, value } of body) store.set(name, value);
        return reply(201);
      }
      if (method === "DELETE") {
        calls.delete++;
        for (const name of body) store.delete(name);
        return reply(200);
      }
    }
    const github = `https://api.github.com/repos/${REHEARSAL_REPOSITORY}`;
    const env = encodeURIComponent(ENVIRONMENT_NAME);
    if (url === `${github}/environments/${env}`)
      return reply(200, {
        id: environmentId,
        name: ENVIRONMENT_NAME,
        can_admins_bypass: false,
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: false,
            reviewers: [{ type: "User", reviewer: { id: OWNER_REVIEWER_ID } }],
          },
        ],
        deployment_branch_policy: {
          custom_branch_policies: true,
          protected_branches: false,
        },
      });
    if (
      url ===
      `${github}/environments/${env}/deployment-branch-policies?per_page=100`
    )
      return reply(200, {
        total_count: 1,
        branch_policies: [{ name: "main", type: "branch" }],
      });
    if (url === `${github}/actions/runs/1/approvals`)
      return reply(200, [
        {
          state: "approved",
          user: { id: OWNER_REVIEWER_ID },
          environments: [{ id: environmentId }],
        },
      ]);
    return reply(404);
  };
  return { store, calls, fetchImpl };
}

/**
 * Points the module's psql calls at the runner's own database: host, port and TLS come from the
 * local connection; the admin user's password is the local one; a role probe keeps its exact role
 * name (a pooler-style "<role>.<ref>" is reduced to the role) and its newly generated password.
 */
function localExec(exec, local, projectRef, adminPassword) {
  return (cmd, args, opts = {}) => {
    if (cmd !== "psql" || !opts.env) return exec(cmd, args, opts);
    const env = { ...opts.env };
    env.PGHOST = local.host;
    env.PGPORT = local.port;
    env.PGSSLMODE = "disable";
    env.PGUSER = String(env.PGUSER ?? "").replace(`.${projectRef}`, "");
    if (env.PGUSER === "postgres" && env.PGPASSWORD === adminPassword)
      env.PGPASSWORD = local.password;
    return exec(cmd, args, { ...opts, env });
  };
}

const withMode = (plan, mode) => {
  const { digest: _old, ...rest } = plan;
  const next = { ...rest, mode };
  return { ...next, digest: sha256(canonical(next)) };
};

/**
 * Plan-job rehearsal of the exact module code path. Negative controls first (a missing staged
 * value, a plan the owner did not approve), then apply from the post-migration starting state,
 * proving every login is set with a password that really signs in, every name is written with a
 * matching digest, and a repeat writes nothing; then an emergency pause wins over apply; then the
 * plan's own mode (rotate: old passwords stop working, new ones work; disable: only QA-prefixed names
 * removed, the QA writer cannot sign in, shared names and logins kept).
 */
export async function runSecretsReplay({
  exec,
  plan,
  dir,
  conn,
  cwd,
  log = () => {},
}) {
  if (!isLoopback(conn))
    throw new Refusal(
      "replay-not-local",
      "Replay only runs against the runner's own database",
    );
  const ref = plan.projectRef;
  const adminPassword = randomBytes(18).toString("hex");
  const api = rehearsalApi(ref);
  const run = localExec(exec, conn, ref, adminPassword);
  const proofs = [];
  const prove = (name, ok, detail) => {
    proofs.push(detail ? { name, ok, detail } : { name, ok });
    log(
      `${ok ? "PROVED" : "NOT PROVED"} ${name}${detail ? `: ${detail}` : ""}`,
    );
  };
  const staged = Object.fromEntries(
    STAGED_SECRETS.map(({ from }) => [
      from,
      `rehearsal-${from.toLowerCase()}-${randomBytes(6).toString("hex")}`,
    ]),
  );
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
    SUPABASE_PRODUCTION_PROJECT_REF: ref,
    SUPABASE_DB_URL: `postgresql://postgres:${adminPassword}@db.${ref}.supabase.co:5432/postgres?sslmode=require`,
    [QA_SECRETS_TOKEN_ENV]: `rehearsal-${randomBytes(8).toString("hex")}`,
    ...(p.mode === "disable" ? {} : staged),
    ...extra,
  });
  const operate = (p, extra) =>
    runQaSecretsOperation({
      plan: p,
      env: envFor(p, extra),
      platform: "linux",
      cwd,
      sourceDir: dir,
      exec: run,
      fetchImpl: api.fetchImpl,
      sleep: async () => {},
    });
  const sql = async (text) => {
    const result = await exec(
      "psql",
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", text],
      {
        cwd,
        env: {
          PGHOST: conn.host,
          PGPORT: conn.port,
          PGUSER: conn.user,
          PGPASSWORD: conn.password,
          PGDATABASE: conn.database,
          PGSSLMODE: "disable",
        },
      },
    );
    if (result.code !== 0)
      throw new Refusal("rehearsal-setup-failed", "Rehearsal query failed");
    return String(result.stdout).trim();
  };
  const signsIn = async (url) => {
    const parsed = new URL(url);
    const result = await exec(
      "psql",
      ["-X", "-q", "-A", "-t", "-c", "select current_user"],
      {
        cwd,
        env: {
          PGHOST: conn.host,
          PGPORT: conn.port,
          PGUSER: decodeURIComponent(parsed.username),
          PGPASSWORD: decodeURIComponent(parsed.password),
          PGDATABASE: "postgres",
          PGSSLMODE: "disable",
        },
      },
    );
    return (
      result.code === 0 &&
      String(result.stdout).trim() === decodeURIComponent(parsed.username)
    );
  };
  const logins = async () =>
    Object.fromEntries(
      (
        await sql(
          `select string_agg(rolname || '=' || rolcanlogin::text, ',' order by rolname) from pg_roles where rolname in (${QA_ROLE_LOGINS.map((r) => `'${r.role}'`).join(", ")})`,
        )
      )
        .split(",")
        .map((pair) => pair.split("=")),
    );
  const everyName = [
    ...QA_ROLE_LOGINS.map((r) => r.secret),
    ...STAGED_SECRETS.map((s) => s.name),
  ].sort();
  const applyPlan = withMode(plan, "apply");

  // Negative controls: refused before any write, nothing changed.
  const missing = STAGED_SECRETS[0].from;
  const noValue = await operate(applyPlan, { [missing]: "" });
  const notApproved = await operate(applyPlan, {
    EXPECTED_PLAN_DIGEST: "f".repeat(64),
  });
  prove(
    "negative controls: a missing staged value and an unapproved plan are refused before any write",
    noValue.status === "stopped-before-write" &&
      noValue.issues.includes("qa-stage-value-missing") &&
      notApproved.status === "stopped-before-write" &&
      !noValue.writeAttempted &&
      !notApproved.writeAttempted &&
      api.store.size === 0 &&
      Object.values(await logins()).every((v) => v === "false"),
    `${noValue.issues[0]}; ${notApproved.issues[0]}`,
  );

  const applied = await operate(applyPlan);
  prove(
    "apply: the exact module code path verified the install",
    applied.status === "verified",
    [applied.status, ...applied.issues].join(" "),
  );
  prove(
    "apply: exactly the required names were written, each value matching its digest",
    canonical([...api.store.keys()].sort()) === canonical(everyName),
    `${api.store.size} names`,
  );
  const urls = QA_ROLE_LOGINS.map((r) => api.store.get(r.secret));
  let urlsOk = urls.every(Boolean);
  for (const [i, url] of urls.entries()) {
    if (!url) continue;
    const parsed = new URL(url);
    urlsOk &&=
      parsed.hostname === `db.${ref}.supabase.co` &&
      parsed.port === "5432" &&
      decodeURIComponent(parsed.username) === QA_ROLE_LOGINS[i].role &&
      (await signsIn(url));
  }
  // The proof above means something only if this database checks passwords at all.
  const wrong = new URL(
    urls[0] ??
      `postgresql://still_policy_reader:x@db.${ref}.supabase.co:5432/postgres`,
  );
  wrong.password = randomBytes(16).toString("hex");
  prove(
    "apply: each generated URL uses the direct host and exact role, and its new password really signs in (a wrong password is refused)",
    urlsOk && !(await signsIn(wrong.href)),
  );
  prove(
    "apply: the three roles can sign in",
    Object.values(await logins()).every((v) => v === "true"),
  );
  const posts = api.calls.post;
  const again = await operate(applyPlan);
  prove(
    "apply again: everything reported unchanged and nothing written",
    ["verified", "no-change"].includes(again.status) &&
      !again.writeAttempted &&
      api.calls.post === posts,
    [again.status, ...again.issues].join(" "),
  );

  // An emergency pause wins: apply never switches a paused login back on.
  await sql("alter role still_qa_sandbox_writer nologin");
  const paused = await operate(applyPlan);
  prove(
    "an emergency pause wins: apply refuses while the QA writer is paused and writes nothing",
    paused.status === "stopped-before-write" &&
      paused.issues.includes("qa-role-paused") &&
      api.calls.post === posts &&
      (await logins()).still_qa_sandbox_writer === "false",
    paused.issues[0],
  );
  await sql("alter role still_qa_sandbox_writer login");

  let receipt = applied;
  if (plan.mode === "rotate") {
    const before = new Map(api.store);
    receipt = await operate(plan);
    const after = QA_ROLE_LOGINS.map((r) => api.store.get(r.secret));
    const checks = [];
    for (const [i, url] of after.entries()) {
      const old = before.get(QA_ROLE_LOGINS[i].secret);
      checks.push(
        [url !== old, await signsIn(url), !(await signsIn(old))].every(Boolean),
      );
    }
    prove(
      "rotate: every password changed; the new URLs sign in and the old ones no longer do",
      receipt.status === "verified" && checks.every(Boolean),
      [receipt.status, ...receipt.issues, ...checks.map(String)].join(" "),
    );
  }
  if (plan.mode === "disable") {
    receipt = await operate(plan);
    const left = [...api.store.keys()].sort();
    const roles = await logins();
    prove(
      "disable: only the QA-prefixed names are removed; the shared URLs and their logins stay; the QA writer cannot sign in",
      receipt.status === "verified" &&
        DISABLE_SECRETS.every((name) => !api.store.has(name)) &&
        canonical(left) ===
          canonical(
            QA_ROLE_LOGINS.map((r) => r.secret)
              .filter((name) => !DISABLE_SECRETS.includes(name))
              .sort(),
          ) &&
        roles.still_qa_sandbox_writer === "false" &&
        roles.still_policy_reader === "true" &&
        roles.still_settings_writer === "true",
      receipt.status,
    );
  }
  const printed = JSON.stringify([applied, again, paused, receipt]);
  prove(
    "no value, password or URL appears in any receipt",
    [...api.store.values(), ...Object.values(staged)].every(
      (value) => !printed.includes(value),
    ),
  );
  return {
    kind: QA_SECRETS_KIND,
    status: proofs.every((p) => p.ok) ? "verified" : "rehearsal-failed",
    mode: plan.mode,
    proofs,
  };
}

export function renderSecretsReplay(result) {
  return [
    `## Rehearsal of \`${QA_SECRETS_OPERATION}\` (${result.mode}) on a throwaway database (no production access, Management API stubbed): ${result.status}`,
    "",
    ...result.proofs.map(
      (p) =>
        `- ${p.ok ? "✅" : "❌"} ${p.name}${p.detail ? ` — ${p.detail}` : ""}`,
    ),
    "",
  ].join("\n");
}
