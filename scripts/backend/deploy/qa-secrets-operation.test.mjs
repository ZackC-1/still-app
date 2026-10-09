// Offline tests for wiring the secrets module into the protected workflow (qa-secrets-operation.mjs):
// plan binding, refusals, freshness, the CLI and the closing record. The module's own behaviour is
// tested in qa-secrets.test.mjs; its real-database rehearsal runs in the operation rehearsal job.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  Refusal,
  assertSamePlan,
  checkFreshness,
  defaultExec,
  main,
  makeGit,
  parseDbUrl,
  sha256,
} from "./deploy.mjs";
import {
  QA_SECRETS_KIND,
  SECRETS_TOOLING,
  createSecretsOperationPlan,
  prepareSecretsWorkdir,
  renderSecretsOperationPlan,
  runSecretsReplay,
  secretsBoundFiles,
} from "./qa-secrets-operation.mjs";
import { QA_SECRETS_SQL, ROLE_FACTS } from "./qa-secrets.mjs";

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

/** A throwaway repository with the real tooling, pinned SQL and role facts. */
async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), "still-qa-secrets-op-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  for (const path of [
    ...SECRETS_TOOLING,
    ...Object.values(QA_SECRETS_SQL).map((pin) => pin.path),
    ROLE_FACTS,
  ])
    await put(root, path, await real(path));
  await put(root, "supabase/config.toml", 'project_id = "still-app"\n');
  await put(root, "supabase/migrations/0001_init.sql", "select 1;\n");
  await put(root, "packages/core/src/index.ts", "export {};\n");
  await put(root, "packages/shared-types/src/index.ts", "export {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

const plan = async (root, sha, extra = {}) =>
  createSecretsOperationPlan({
    git: makeGit(defaultExec, root),
    sha,
    cwd: root,
    exec: defaultExec,
    sourceDir: await mkdtemp(join(tmpdir(), "still-qa-secrets-src-")),
    projectRef: REF,
    mode: "apply",
    ...extra,
  });

async function refuses(promise, category) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${error}`);
    assert.equal(error.category, category, error.message);
    return true;
  });
}

const sink = () => ({
  text: "",
  write(s) {
    this.text += s;
  },
});

test("the plan binds the module's plan, the commit on main and the tooling under one digest", async (t) => {
  const { root, head } = await repo(t);
  const p = await plan(root, head);
  assert.equal(p.kind, QA_SECRETS_KIND);
  assert.equal(p.operation, "qa-sandbox-secrets");
  assert.equal(p.mode, "apply");
  assert.equal(p.revision, head);
  assert.equal(p.workflowRevision, head);
  assert.equal(p.projectRef, REF);
  assert.deepEqual(
    p.tooling.map((f) => f.path),
    [...SECRETS_TOOLING],
  );
  for (const pin of Object.values(QA_SECRETS_SQL))
    assert.ok(
      p.files.some((f) => f.path === pin.path && f.sha256 === pin.sha256),
    );
  assert.equal(secretsBoundFiles(p).length, p.files.length + p.tooling.length);
  // The digest survives the JSON round trip the workflow makes and is deterministic.
  assertSamePlan(JSON.parse(JSON.stringify(p)), p.digest);
  assert.equal((await plan(root, head)).digest, p.digest);
  assert.notEqual(
    (await plan(root, head, { mode: "rotate" })).digest,
    p.digest,
  );
  const shown = renderSecretsOperationPlan(p);
  for (const needle of [
    p.digest,
    head,
    "SUPABASE_QA_SECRETS_ACCESS_TOKEN",
    "19 `QA_STAGE_*` values",
    "the plan job reads no secret",
  ])
    assert.ok(shown.includes(needle), needle);
  assert.match(
    renderSecretsOperationPlan(await plan(root, head, { mode: "plan-only" })),
    /a plan-only run reads no secret and writes nothing/,
  );
});

test("the bound tooling covers the whole import closure of the apply process", async () => {
  // Static `from "./x.mjs"` and dynamic `import("./x.mjs")`, starting from both entry points.
  const dir = "scripts/backend/deploy/";
  const seen = new Set();
  const queue = [`${dir}deploy.mjs`, `${dir}qa-secrets-operation.mjs`];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = (await real(path)).toString("utf8");
    for (const m of text.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*)["'](\.\/[^"']+)["']/g,
    ))
      queue.push(`${dir}${m[1].slice(2)}`);
  }
  assert.ok(seen.has(`${dir}qa-function-bundles.mjs`));
  for (const path of seen) assert.ok(SECRETS_TOOLING.includes(path), path);
});

test("the plan refuses a bad mode, a migration list, a commit off main and drifted files", async (t) => {
  const { root, head } = await repo(t);
  await refuses(plan(root, head, { mode: "baseline-only" }), "mode-invalid");
  await refuses(
    plan(root, head, { migrations: "0001_init.sql" }),
    "operation-with-migrations",
  );
  await refuses(plan(root, "main"), "input-invalid");
  await refuses(
    plan(root, head, { projectRef: "short" }),
    "qa-secrets-input-invalid",
  );
  // Edited pinned SQL is not the reviewed bytes.
  await put(
    root,
    QA_SECRETS_SQL.login.path,
    "alter role postgres superuser;\n",
  );
  git(root, "commit", "-q", "-am", "edit sql");
  await refuses(
    plan(root, git(root, "rev-parse", "HEAD")),
    "qa-secrets-sql-unpinned",
  );
  // Tooling that differs between the commit and main is refused.
  await refuses(plan(root, head), "file-changed-on-main");
  // A commit that main does not contain is refused.
  git(root, "checkout", "-q", "-b", "feature", head);
  await put(root, "notes.txt", "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "unmerged");
  await refuses(
    createSecretsOperationPlan({
      git: makeGit(defaultExec, root),
      sha: git(root, "rev-parse", "HEAD"),
      mainRef: "main",
      cwd: root,
      exec: defaultExec,
      sourceDir: await mkdtemp(join(tmpdir(), "still-qa-secrets-src-")),
      projectRef: REF,
      mode: "apply",
    }),
    "not-on-main",
  );
});

test("freshness: an unrelated change on main is fine; a changed bound file refuses", async (t) => {
  const { root, head } = await repo(t);
  const p = await plan(root, head);
  const gitApi = makeGit(defaultExec, root);
  await put(root, "notes.txt", "unrelated\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "unrelated");
  assert.equal(
    (await checkFreshness({ git: gitApi, plan: p, tipRef: "main" })).mode,
    "files-identical",
  );
  await put(
    root,
    "scripts/backend/deploy/qa-secrets.mjs",
    `${await real("scripts/backend/deploy/qa-secrets.mjs")}// edited\n`,
  );
  git(root, "commit", "-q", "-am", "edit module");
  await refuses(
    checkFreshness({ git: gitApi, plan: p, tipRef: "main" }),
    "main-moved",
  );
});

test("the rehearsal workdir holds the exact commit's database and module files; drift and production are refused", async (t) => {
  const { root, head } = await repo(t);
  const p = await plan(root, head);
  const dir = join(root, ".replay");
  await prepareSecretsWorkdir({ exec: defaultExec, cwd: root, plan: p, dir });
  assert.equal(
    sha256(await readFile(join(dir, QA_SECRETS_SQL.login.path))),
    QA_SECRETS_SQL.login.sha256,
  );
  await readFile(join(dir, "supabase/migrations/0001_init.sql"));
  const forged = {
    ...p,
    files: p.files.map((f) => ({ ...f, sha256: "0".repeat(64) })),
  };
  await refuses(
    prepareSecretsWorkdir({ exec: defaultExec, cwd: root, plan: forged, dir }),
    "hash-mismatch",
  );
  await refuses(
    runSecretsReplay({
      exec: async () => assert.fail("no database call"),
      plan: p,
      dir,
      conn: parseDbUrl(
        `postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`,
      ),
      cwd: root,
    }),
    "replay-not-local",
  );
});

test("the deploy CLI plans the secrets operation and keeps rotate/disable and its inputs to it", async (t) => {
  const { root, head } = await repo(t);
  const base = {
    DEPLOY_SHA: head,
    DEPLOY_MIGRATIONS: "",
    DEPLOY_FUNCTIONS: "",
    SUPABASE_PRODUCTION_PROJECT_REF: REF,
  };
  const out = join(root, ".plan.json");
  const sourceDir = join(root, ".qa-source");
  assert.equal(
    await main(
      ["plan", "--out", out, "--source-dir", sourceDir],
      {
        ...base,
        DEPLOY_OPERATION: "qa-sandbox-secrets",
        DEPLOY_MODE: "rotate",
      },
      { cwd: root, out: sink() },
    ),
    0,
  );
  const p = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual([p.kind, p.mode], [QA_SECRETS_KIND, "rotate"]);
  for (const [env, category] of [
    [
      { DEPLOY_OPERATION: "pause-qa-sandbox", DEPLOY_MODE: "rotate" },
      "mode-invalid",
    ],
    [
      { DEPLOY_OPERATION: "migrations", DEPLOY_MODE: "disable" },
      "mode-invalid",
    ],
    [
      { DEPLOY_OPERATION: "qa-sandbox-secrets", DEPLOY_MODE: "baseline-only" },
      "mode-invalid",
    ],
    [
      {
        DEPLOY_OPERATION: "qa-sandbox-secrets",
        DEPLOY_MODE: "apply",
        DEPLOY_BASELINE_SHA256: "0".repeat(64),
      },
      "operation-input-invalid",
    ],
    [
      {
        DEPLOY_OPERATION: "qa-sandbox-secrets",
        DEPLOY_MODE: "apply",
        DEPLOY_POLICY_MODE: "on",
      },
      "operation-input-invalid",
    ],
  ])
    await assert.rejects(
      main(
        ["plan", "--source-dir", join(root, `.src-${Math.random()}`)],
        { ...base, ...env },
        { cwd: root, out: sink() },
      ),
      (e) => e.category === category,
    );
  // The workdir step prepares the rehearsal database for this plan kind.
  const said = sink();
  assert.equal(
    await main(
      [
        "workdir",
        "--plan",
        out,
        "--dir",
        join(root, ".wd"),
        "--stage",
        "prior",
      ],
      {},
      { cwd: root, out: said },
    ),
    0,
  );
  assert.match(said.text, /deploy directory ready/);
});

test("the closing record is the secrets record, with or without a receipt, and holds no value", async (t) => {
  const { root } = await repo(t);
  const withoutReceipt = sink();
  await main(
    ["final-summary", "--receipt", join(root, "missing.json")],
    { DEPLOY_OPERATION: "qa-sandbox-secrets", APPLY_OUTCOME: "failure" },
    { cwd: root, out: withoutReceipt },
  );
  assert.match(
    withoutReceipt.text,
    /## QA secrets closing record[\s\S]*Outcome unknown/,
  );
  const receiptFile = join(root, "receipt.json");
  await writeFile(
    receiptFile,
    JSON.stringify({
      protocol: 1,
      kind: QA_SECRETS_KIND,
      operation: "qa-sandbox-secrets",
      mode: "apply",
      status: "verified",
      writeAttempted: true,
      secrets: [
        { name: "STILL_QA_SANDBOX_STRIPE_ACCOUNT_ID", outcome: "installed" },
      ],
      roles: [{ role: "still_qa_sandbox_writer", outcome: "login-set" }],
      counts: { secrets: { installed: 1 }, roles: { "login-set": 1 } },
      issues: [],
      recovery: "none needed",
    }),
  );
  const withReceipt = sink();
  await main(
    ["final-summary", "--receipt", receiptFile],
    { DEPLOY_OPERATION: "qa-sandbox-secrets", APPLY_OUTCOME: "success" },
    { cwd: root, out: withReceipt },
  );
  assert.match(withReceipt.text, /Mode: apply; status: verified/);
  assert.match(
    withReceipt.text,
    /STILL_QA_SANDBOX_STRIPE_ACCOUNT_ID` \| installed/,
  );
});
