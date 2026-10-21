// Offline tests for the purchase operations (purchase-operations.mjs): plan binding and refusals,
// the closed route and secret lists, every gate, the decisions and write order, the public records
// and the CLI wiring. The database is a small model of the history the gate reads; the Management
// API and GitHub are the module's own in-memory stub. The real-database rehearsal of the whole
// lifecycle runs in the operation rehearsal job, and the real bundles compile in the purchase
// function rehearsal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  checkFreshness,
  defaultExec,
  main,
  makeGit,
  parseDbUrl,
  Refusal,
  sha256,
} from "./deploy.mjs";
import {
  assertWritableSecret,
  createPurchasePlan,
  decideSecrets,
  FIXED_SECRETS,
  FUNCTIONS_OP,
  FUNCTIONS_TOKEN_ENV,
  PURCHASE_KIND,
  PURCHASE_OPERATIONS,
  PURCHASE_TOOLING,
  readStaged,
  rehearsalApi,
  REHEARSAL_REPOSITORY,
  renderPurchaseFinal,
  renderPurchasePlan,
  renderPurchaseReplay,
  ROUTE_SECRETS,
  runPurchaseOperation,
  runPurchaseReplay,
  SECRET_GROUPS,
  SECRETS_OP,
  SECRETS_TOKEN_ENV,
  SHARED_SECRETS,
  STAGE_PREFIX,
  STAGED_SECRETS,
  SYNC_GUARD_MIGRATION,
  SYNC_OP,
  syntheticStaged,
  validateStaged,
  WRITABLE_SECRETS,
} from "./purchase-operations.mjs";
import {
  PURCHASE_BUNDLE_SET,
  PURCHASE_FUNCTIONS,
  SYNC_SETTINGS_BUNDLE_SET,
} from "./qa-function-bundles.mjs";
import { REQUIRED_SECRETS as QA_REQUIRED_SECRETS } from "./qa-functions.mjs";

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

const MIGRATIONS = ["0023_qa_settings_notifications", "0024_legacy_settings_guard_non_retryable"];

/** A throwaway repository with the real tooling and placeholder migrations. */
async function repo(t, { migrations = MIGRATIONS } = {}) {
  const root = await mkdtemp(join(tmpdir(), "still-purchase-op-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  for (const path of PURCHASE_TOOLING) await put(root, path, await real(path));
  await put(root, "supabase/config.toml", 'project_id = "still-app"\n');
  for (const name of migrations) await put(root, `supabase/migrations/${name}.sql`, "select 1;\n");
  await put(root, "packages/core/src/index.ts", "export {};\n");
  await put(root, "packages/shared-types/src/index.ts", "export {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

/** Stand-in compiler: writes small bundles and returns their manifest. */
const fakeBundles = async (set, { artifactDir }) => {
  await mkdir(artifactDir, { recursive: true });
  const functions = [];
  for (const { name, verifyJwt } of set.routes) {
    const file = `${name}.js`;
    const bytes = Buffer.from(`// bundle ${name}\n`);
    await writeFile(join(artifactDir, file), bytes);
    functions.push({ name, verifyJwt, file, sha256: sha256(bytes), bytes: bytes.length });
  }
  return { protocol: 1, kind: set.kind, toolchain: {}, sources: [], functions };
};

async function plan(t, root, sha, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), "still-purchase-src-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const p = await createPurchasePlan({
    git: makeGit(defaultExec, root),
    sha,
    cwd: root,
    exec: defaultExec,
    sourceDir: join(base, "src"),
    artifactDir: join(base, "art"),
    projectRef: REF,
    operation: FUNCTIONS_OP,
    mode: "apply",
    buildBundles: fakeBundles,
    ...extra,
  });
  return { plan: p, sourceDir: join(base, "src"), artifactDir: join(base, "art") };
}

async function refuses(promise, category) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${error}`);
    assert.equal(error.category, category, error.message);
    return true;
  });
}

function refusesSync(fn, category, codes) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${error}`);
    assert.equal(error.category, category, error.message);
    if (codes) assert.deepEqual(error.codes, [...codes].sort());
    return true;
  });
}

/** The hosted history the read-only gate sees. */
function database({ history = ["0023", "0024"] } = {}) {
  const state = { history, files: [] };
  const exec = async (cmd, args, opts) => {
    if (cmd !== "psql") return defaultExec(cmd, args, opts);
    const file = args.includes("-f") ? basename(args[args.indexOf("-f") + 1]) : null;
    state.files.push(file);
    if (file === "migration-history.sql") {
      return { code: 0, stdout: `${JSON.stringify(state.history.map((version) => ({ version, name: "m" })))}\n`, stderr: "" };
    }
    return { code: 3, stdout: "", stderr: "ERROR:  42P01" };
  };
  return { state, exec };
}

function context(p, extra = {}) {
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: REHEARSAL_REPOSITORY,
    GITHUB_RUN_ID: "1",
    GH_TOKEN: "test",
    EXPECTED_PLAN_DIGEST: p.digest,
    DEPLOY_MODE: p.mode,
    DEPLOY_OPERATION: p.operation,
    DEPLOY_POLICY_MODE: "none",
    SUPABASE_PRODUCTION_PROJECT_REF: REF,
    SUPABASE_DB_URL: `postgresql://postgres.${REF}:admin-password@aws-0-us-west-2.pooler.supabase.com:5432/postgres`,
    [FUNCTIONS_TOKEN_ENV]: p.operation === SECRETS_OP ? "" : "functions-token",
    [SECRETS_TOKEN_ENV]: p.operation === SECRETS_OP ? "secrets-token" : "",
    ...extra,
  };
}

/** One harness: a plan of each operation from one commit, the history model and the stub API. */
async function harness(t, options = {}) {
  const { root, head } = await repo(t);
  const made = {};
  for (const operation of Object.keys(PURCHASE_OPERATIONS)) {
    made[operation] = await plan(t, root, head, { operation });
    if (operation === SECRETS_OP) {
      made.rotate = await plan(t, root, head, { operation, mode: "rotate" });
    }
  }
  const db = database(options);
  const api = rehearsalApi(REF);
  api.secrets.set("PRODUCT_POLICY_READER_DB_URL", "reader-url-value");
  const receipts = [];
  const run = async (key, extra = {}, overrides = {}) => {
    const { plan: p, sourceDir, artifactDir } = made[key];
    const receipt = await runPurchaseOperation({
      plan: p,
      env: context(p, extra),
      platform: "linux",
      cwd: root,
      sourceDir,
      artifactDir,
      exec: db.exec,
      fetchImpl: api.fetchImpl,
      verifyBundles: async () => true,
      ...overrides,
    });
    receipts.push(receipt);
    return receipt;
  };
  return { root, head, made, db, api, run, receipts };
}

// ── Closed lists ─────────────────────────────────────────────────────────────────────────────

test("the operations, secret names and groups are closed lists with no QA or platform name", () => {
  assert.deepEqual(Object.keys(PURCHASE_OPERATIONS), [FUNCTIONS_OP, SYNC_OP, SECRETS_OP]);
  assert.equal(PURCHASE_OPERATIONS[FUNCTIONS_OP].set, PURCHASE_BUNDLE_SET);
  assert.equal(PURCHASE_OPERATIONS[SYNC_OP].set, SYNC_SETTINGS_BUNDLE_SET);
  assert.equal(PURCHASE_OPERATIONS[SECRETS_OP].set, null);
  assert.deepEqual(PURCHASE_OPERATIONS[SECRETS_OP].modes, ["plan-only", "apply", "rotate"]);
  assert.deepEqual(
    STAGED_SECRETS.map(({ name, required }) => [name, required]),
    [
      ["ACCESS_PROOF_KEY_ID", true],
      ["ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", true],
      ["ACCESS_PROOF_PUBLIC_KEY_HEX", true],
      ["ACCESS_APPLE_PRODUCTS_JSON", true],
      ["ACCESS_PROVIDER_PRODUCTS_JSON", true],
      ["APP_STORE_SERVER_ISSUER_ID", true],
      ["APP_STORE_SERVER_KEY_ID", true],
      ["APP_STORE_SERVER_PRIVATE_KEY", true],
      ["REVENUECAT_PROJECT_ID", true],
      ["REVENUECAT_ACCESS_SECRET_API_KEY", true],
      ["REVENUECAT_SECRET_API_KEY", true],
      ["REVENUECAT_WEBHOOK_TOKEN", true],
      ["STRIPE_SECRET_API_KEY", true],
      ["STRIPE_ACCOUNT_ID", true],
      ["STRIPE_WEBHOOK_SECRET", true],
      ["STRIPE_API_VERSION", true],
      ["STRIPE_PRICE_ID", true],
      ["STRIPE_PRODUCT_ID", true],
      ["REVENUECAT_STRIPE_PUBLIC_API_KEY", true],
      ["WEB_RETURN_ORIGIN", true],
      ["WEB_RETURN_PATHS_JSON", true],
    ],
  );
  for (const { name, from } of STAGED_SECRETS) assert.equal(from, `${STAGE_PREFIX}${name}`);
  assert.deepEqual(FIXED_SECRETS, [{ name: "ACCESS_PROOF_ENVIRONMENT", value: "production" }]);
  assert.deepEqual(WRITABLE_SECRETS, [...STAGED_SECRETS.map((s) => s.name), "ACCESS_PROOF_ENVIRONMENT"].sort());
  for (const name of WRITABLE_SECRETS) {
    assert.doesNotMatch(name, /^(SUPABASE_|STILL_QA_SANDBOX_)/);
    assert.ok(!SHARED_SECRETS.includes(name));
    assert.ok(!/_DB_URL$/.test(name), `${name}: database sign-ins are never staged`);
    // The QA lane reads only STILL_QA_SANDBOX_* names; production names never collide with them.
    assert.ok(!QA_REQUIRED_SECRETS.includes(name), name);
  }
  // Every grouped and route-required name is a known name.
  for (const group of SECRET_GROUPS) for (const name of group) assert.ok(WRITABLE_SECRETS.includes(name));
  for (const names of Object.values(ROUTE_SECRETS)) {
    for (const name of names) assert.ok(WRITABLE_SECRETS.includes(name) || SHARED_SECRETS.includes(name), name);
  }
  assert.ok(WRITABLE_SECRETS.includes("STRIPE_SECRET_API_KEY"));
  assert.ok(ROUTE_SECRETS[FUNCTIONS_OP].includes("STRIPE_WEBHOOK_SECRET"));
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "STILL_QA_SANDBOX_ACCESS_PROOF_KEY_ID", "PRODUCT_POLICY_READER_DB_URL", "ANALYTICS_SUBJECTS_ENABLED"]) {
    refusesSync(() => assertWritableSecret(name), "purchase-secret-name-refused");
  }
});

test("every staged name is one the production routes actually read", async () => {
  const sources = (await Promise.all([
    "supabase/functions/_shared/apple-access-runtime.ts",
    "supabase/functions/_shared/production-checkout-runtime.ts",
    "supabase/functions/_shared/production-stripe-webhook.ts",
    "supabase/functions/_shared/managed-checkout-config.ts",
    "supabase/functions/reconcile-entitlement/index.ts",
    "supabase/functions/create-web-checkout/index.ts",
    "supabase/functions/revenuecat-webhook/index.ts",
    "supabase/functions/product-policy/index.ts",
    "supabase/functions/sync-settings/index.ts",
  ].map(real))).join("\n");
  for (const name of [...WRITABLE_SECRETS, ...SHARED_SECRETS]) {
    assert.ok(sources.includes(`"${name}"`), `${name} is read by a production purchase route`);
  }
});

test("the bound tooling covers the whole import closure of the apply process", async () => {
  const dir = "scripts/backend/deploy/";
  const seen = new Set();
  const queue = [`${dir}deploy.mjs`, `${dir}purchase-operations.mjs`];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = (await real(path)).toString("utf8");
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["'](\.\.?\/[^"']+)["']/g)) {
      const target = m[1].startsWith("../") ? `scripts/backend/${m[1].slice(3)}` : `${dir}${m[1].slice(2)}`;
      queue.push(target);
    }
  }
  assert.ok(seen.has(`${dir}purchase-operations.mjs`));
  for (const path of seen) assert.ok(PURCHASE_TOOLING.includes(path), path);
});

// ── Plan ─────────────────────────────────────────────────────────────────────────────────────

test("the plan binds the operation, the commit on main, the routes or secret names under one digest", async (t) => {
  const { root, head } = await repo(t);
  const functions = (await plan(t, root, head)).plan;
  assert.equal(functions.kind, PURCHASE_KIND);
  assert.equal(functions.revision, head);
  assert.deepEqual(functions.bundles.functions.map((f) => [f.name, f.verifyJwt]), PURCHASE_FUNCTIONS.map((f) => [f.name, f.verifyJwt]));
  assert.deepEqual(functions.migrations, ["0023", "0024"]);
  assert.deepEqual(functions.requiredSecrets, [...ROUTE_SECRETS[FUNCTIONS_OP]]);
  assert.equal(functions.secrets, null);
  for (const path of PURCHASE_TOOLING) assert.ok(functions.files.some((f) => f.path === path), path);
  const sync = (await plan(t, root, head, { operation: SYNC_OP })).plan;
  assert.deepEqual(sync.bundles.functions.map((f) => f.name), ["sync-settings"]);
  assert.deepEqual(sync.requiredSecrets, ["SETTINGS_WRITER_DB_URL"]);
  const secrets = (await plan(t, root, head, { operation: SECRETS_OP, mode: "plan-only" })).plan;
  assert.equal(secrets.bundles, null);
  assert.deepEqual(secrets.migrations, []);
  assert.deepEqual(secrets.secrets.staged.map((s) => s.from), STAGED_SECRETS.map((s) => s.from));
  assert.notEqual(functions.digest, sync.digest);
  const again = (await plan(t, root, head)).plan;
  assert.equal(again.digest, functions.digest);
});

test("the plan refuses unknown operations, wrong modes and inputs, a commit off main and a missing 0024", async (t) => {
  const { root, head } = await repo(t);
  await refuses(plan(t, root, head, { operation: "purchase-other" }), "purchase-operation-unknown");
  await refuses(plan(t, root, head, { mode: "rotate" }), "purchase-input-invalid");
  await refuses(plan(t, root, head, { operation: SYNC_OP, mode: "disable" }), "purchase-input-invalid");
  await refuses(plan(t, root, head, { operation: SECRETS_OP, mode: "disable" }), "purchase-input-invalid");
  for (const extra of [
    { policyMode: "enable" }, { migrations: "0024_x.sql" }, { functions: "sync-settings" },
    { expectedRevision: "1" }, { subjectsSha256: "1:ab" }, { baselineSha256: "a".repeat(64) },
    { projectRef: "not-a-ref" }, { sha: "abc" },
  ]) {
    await refuses(plan(t, root, head, extra), "purchase-input-invalid");
  }
  git(root, "checkout", "-q", "-b", "side");
  await put(root, "side.txt", "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "side");
  const side = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  await refuses(plan(t, root, side), "purchase-commit-not-on-main");
  const old = await repo(t, { migrations: ["0023_qa_settings_notifications"] });
  await refuses(plan(t, old.root, old.head), "purchase-prerequisite-history-missing");
  await refuses(plan(t, old.root, old.head, { operation: SYNC_OP }), "purchase-prerequisite-history-missing");
});

test("freshness: an unrelated change or a new migration on main is fine; a changed bound file refuses", async (t) => {
  const { root, head } = await repo(t);
  const { plan: p } = await plan(t, root, head);
  await put(root, "README.md", "unrelated\n");
  await put(root, "supabase/migrations/0025_future.sql", "select 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "later");
  const fresh = await checkFreshness({ git: makeGit(defaultExec, root), plan: p, tipRef: "HEAD" });
  assert.equal(fresh.mode, "files-identical");
  await put(root, "scripts/backend/deploy/purchase-operations.mjs", "// changed\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "tooling");
  await refuses(checkFreshness({ git: makeGit(defaultExec, root), plan: p, tipRef: "HEAD" }), "main-moved");
});

// ── Functions ────────────────────────────────────────────────────────────────────────────────

test("purchase-functions deploys exactly its routes in order with their verify_jwt; a repeat changes nothing", async (t) => {
  const h = await harness(t);
  for (const name of ROUTE_SECRETS[FUNCTIONS_OP]) h.api.secrets.set(name, `rehearsal-${name}`);
  const deployed = await h.run(FUNCTIONS_OP);
  assert.equal(deployed.status, "verified", deployed.issues.join(" "));
  assert.deepEqual(deployed.steps.map((s) => [s.name, s.outcome]), [
    ["product-policy", "created"],
    ["export-user-data", "deployed"],
    ["verify-apple-access", "created"],
    ["link-apple-access", "created"],
    ["reconcile-entitlement", "deployed"],
    ["create-web-checkout", "deployed"],
    ["complete-web-checkout", "created"],
    ["revenuecat-webhook", "deployed"],
    ["stripe-webhook", "created"],
  ]);
  for (const { name, verifyJwt } of PURCHASE_FUNCTIONS) {
    assert.equal(h.api.functions.get(name).verify_jwt, verifyJwt, name);
    assert.equal(h.api.functions.get(name).import_map, false, name);
  }
  assert.equal(h.api.functions.get("sync-settings").version, 7, "sync-settings is a separate step");
  assert.equal(h.api.calls.secretPosts, 0);
  assert.deepEqual(h.db.state.files, ["migration-history.sql"]);
  const again = await h.run(FUNCTIONS_OP);
  assert.equal(again.status, "no-change");
  assert.equal(h.api.calls.deploys, PURCHASE_FUNCTIONS.length);
  const synced = await h.run(SYNC_OP);
  assert.equal(synced.status, "verified", synced.issues.join(" "));
  assert.deepEqual(synced.steps, [{ name: "sync-settings", outcome: "deployed" }]);
  assert.equal(h.api.functions.get("sync-settings").version, 8);
  assert.equal((await h.run(SYNC_OP)).status, "no-change");
});

test("every function step refuses before any write without its migrations, live secrets or approval", async (t) => {
  const h = await harness(t, { history: ["0023"] });
  const pending = await h.run(FUNCTIONS_OP);
  assert.equal(pending.status, "stopped-before-write");
  assert.ok(pending.issues.includes("purchase-gate-failed"));
  assert.ok(pending.issues.includes(`history_missing:${SYNC_GUARD_MIGRATION}`));
  const pendingSync = await h.run(SYNC_OP);
  assert.ok(pendingSync.issues.includes(`history_missing:${SYNC_GUARD_MIGRATION}`));
  h.db.state.history = ["0023", "0024"];
  h.api.secrets.delete("PRODUCT_POLICY_READER_DB_URL");
  h.api.secrets.delete("SETTINGS_WRITER_DB_URL");
  const noReader = await h.run(FUNCTIONS_OP);
  assert.ok(noReader.issues.includes("missing_secret:PRODUCT_POLICY_READER_DB_URL"));
  const noWriter = await h.run(SYNC_OP);
  assert.ok(noWriter.issues.includes("missing_secret:SETTINGS_WRITER_DB_URL"));
  const unapproved = await h.run(FUNCTIONS_OP, { EXPECTED_PLAN_DIGEST: "f".repeat(64) });
  assert.deepEqual(unapproved.issues, ["plan-differs"]);
  const wrongOp = await h.run(FUNCTIONS_OP, { DEPLOY_OPERATION: SYNC_OP });
  assert.deepEqual(wrongOp.issues, ["purchase-target-invalid"]);
  const badBundle = await h.run(FUNCTIONS_OP, {}, { verifyBundles: async () => { throw new Error("drift"); } });
  assert.deepEqual(badBundle.issues, ["purchase-bundle-differs"]);
  for (const r of [pending, pendingSync, noReader, noWriter, unapproved, wrongOp, badBundle]) {
    assert.equal(r.status, "stopped-before-write");
    assert.equal(r.writeAttempted, false);
  }
  assert.equal(h.api.calls.deploys, 0);
  // A hand-edited plan cannot widen or move the routes or secrets.
  const { plan: p } = h.made[FUNCTIONS_OP];
  for (const edit of [
    { requiredSecrets: [] },
    { migrations: ["0023"] },
    { secrets: {} },
    { bundles: { ...p.bundles, kind: SYNC_SETTINGS_BUNDLE_SET.kind } },
  ]) {
    const edited = { ...p, ...edit };
    const receipt = await runPurchaseOperation({ plan: edited, env: context(edited), platform: "linux",
      cwd: h.root, sourceDir: h.made[FUNCTIONS_OP].sourceDir, artifactDir: h.made[FUNCTIONS_OP].artifactDir,
      exec: h.db.exec, fetchImpl: h.api.fetchImpl, verifyBundles: async () => true });
    assert.deepEqual(receipt.issues, ["purchase-plan-invalid"], JSON.stringify(edit));
  }
});

test("a bad readback stops the run; later routes are never attempted and the record says outcome-unknown", async (t) => {
  const h = await harness(t);
  for (const name of ROUTE_SECRETS[FUNCTIONS_OP]) h.api.secrets.set(name, `rehearsal-${name}`);
  const original = h.api.fetchImpl;
  const broken = async (url, init) => {
    if (/\/functions\/verify-apple-access\/body$/.test(url)) {
      const form = new FormData();
      form.set("metadata", "{}");
      form.append("file", new Blob(["tampered"]), "source/verify-apple-access.js");
      return new Response(form, { status: 200 });
    }
    return original(url, init);
  };
  const receipt = await h.run(FUNCTIONS_OP, {}, { fetchImpl: broken });
  assert.equal(receipt.status, "outcome-unknown");
  assert.deepEqual(receipt.steps.map((s) => s.outcome), [
    "created", "deployed", "outcome-unknown", ...Array(6).fill("not-attempted"),
  ]);
  assert.equal(h.api.functions.get("revenuecat-webhook").version, 3);
  assert.match(receipt.recovery, /never blindly retry/);
  assert.match(renderPurchaseFinal(receipt), /status: outcome-unknown/);
});

// ── Secrets ──────────────────────────────────────────────────────────────────────────────────

test("staged values: unknown PROD_ names, stray whitespace, incomplete groups and bad shapes refuse by name", () => {
  const values = syntheticStaged();
  refusesSync(() => readStaged({ ...values, PROD_SUPABASE_SERVICE_ROLE_KEY: "x" }), "purchase-stage-unexpected", ["PROD_SUPABASE_SERVICE_ROLE_KEY"]);
  refusesSync(() => readStaged({ ...values, PROD_REVENUECAT_PROJECT_ID: " padded" }), "purchase-stage-value-whitespace", ["PROD_REVENUECAT_PROJECT_ID"]);
  // A PEM private key may end with one newline.
  assert.equal(readStaged(values).get("APP_STORE_SERVER_PRIVATE_KEY"), values.PROD_APP_STORE_SERVER_PRIVATE_KEY);
  const map = (env) => readStaged(env);
  refusesSync(() => validateStaged(map({ ...values, PROD_ACCESS_PROOF_KEY_ID: "" })), "purchase-stage-group-incomplete", ["PROD_ACCESS_PROOF_KEY_ID"]);
  refusesSync(() => validateStaged(map({ ...values, PROD_APP_STORE_SERVER_PRIVATE_KEY: "" })), "purchase-stage-group-incomplete", ["PROD_APP_STORE_SERVER_PRIVATE_KEY"]);
  refusesSync(() => validateStaged(map({ ...values, PROD_ACCESS_PROOF_PUBLIC_KEY_HEX: syntheticStaged().PROD_ACCESS_PROOF_PUBLIC_KEY_HEX })), "purchase-access-key-pair-mismatch");
  refusesSync(() => validateStaged(map({ ...values, PROD_ACCESS_PROOF_PUBLIC_KEY_HEX: "ABC" })), "purchase-stage-value-invalid", ["PROD_ACCESS_PROOF_PUBLIC_KEY_HEX"]);
  refusesSync(() => validateStaged(map({ ...values, PROD_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64: "bm90LWEta2V5" })), "purchase-stage-value-invalid", ["PROD_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64"]);
  refusesSync(() => validateStaged(map({ ...values, PROD_ACCESS_APPLE_PRODUCTS_JSON: "{" })), "purchase-stage-value-invalid", ["PROD_ACCESS_APPLE_PRODUCTS_JSON"]);
  refusesSync(() => validateStaged(map({ ...values, PROD_ACCESS_PROVIDER_PRODUCTS_JSON: "[]" })), "purchase-stage-value-invalid", ["PROD_ACCESS_PROVIDER_PRODUCTS_JSON"]);
  refusesSync(() => validateStaged(map({ ...values, PROD_WEB_RETURN_ORIGIN: "http://example.invalid" })), "purchase-stage-value-invalid", ["PROD_WEB_RETURN_ORIGIN"]);
  assert.equal(validateStaged(map(values)), undefined);
});

test("production staging rejects test keys, wrong provider keys, unsafe return locations and unpinned versions", () => {
  const values = syntheticStaged();
  for (const [name, value] of [
    ["STRIPE_SECRET_API_KEY", "sk_test_wrongenvironment"],
    ["STRIPE_SECRET_API_KEY", "pk_live_publickeyonly"],
    ["STRIPE_API_VERSION", "2026-01-01"],
    ["STRIPE_WEBHOOK_SECRET", "not-a-webhook-secret"],
    ["REVENUECAT_STRIPE_PUBLIC_API_KEY", "appl_wrongstore"],
    ["WEB_RETURN_ORIGIN", "https://user@example.invalid"],
    ["WEB_RETURN_ORIGIN", "https://example.invalid/path"],
    ["WEB_RETURN_ORIGIN", "https://example.invalid:8443"],
    ["WEB_RETURN_PATHS_JSON", JSON.stringify({ success: "//other.invalid", cancel: "/cancel" })],
    ["WEB_RETURN_PATHS_JSON", JSON.stringify({ success: "/same", cancel: "/same" })],
    ["WEB_RETURN_PATHS_JSON", JSON.stringify({ success: "/ok", cancel: "/cancel", extra: "/bad" })],
  ]) {
    refusesSync(() => validateStaged(readStaged({ ...values, [`PROD_${name}`]: value })),
      "purchase-stage-value-invalid", [`PROD_${name}`]);
  }
  assert.equal(validateStaged(readStaged({ ...values, PROD_STRIPE_SECRET_API_KEY: "sk_live_syntheticvalidkey" })), undefined);
});

test("apply installs absent names and never replaces a different value; rotate needs a current value", () => {
  const values = new Map([["REVENUECAT_PROJECT_ID", "new"], ["REVENUECAT_SECRET_API_KEY", "kept-equal"]]);
  const every = new Map(STAGED_SECRETS.filter((s) => s.required).map((s) => [s.name, sha256(`old-${s.name}`)]));
  every.set("ACCESS_PROOF_ENVIRONMENT", sha256("production"));
  every.set("REVENUECAT_SECRET_API_KEY", sha256("kept-equal"));
  const absentProject = new Map(every);
  absentProject.delete("REVENUECAT_PROJECT_ID");
  const applied = decideSecrets("apply", absentProject, values);
  assert.deepEqual(applied.find((i) => i.name === "REVENUECAT_PROJECT_ID").action, "install");
  assert.deepEqual(applied.find((i) => i.name === "REVENUECAT_SECRET_API_KEY").action, "none");
  assert.deepEqual(applied.find((i) => i.name === "ACCESS_PROOF_KEY_ID").action, "keep");
  refusesSync(() => decideSecrets("apply", every, values), "purchase-secret-exists", ["REVENUECAT_PROJECT_ID"]);
  refusesSync(() => decideSecrets("apply", new Map(), new Map()), "purchase-stage-value-missing",
    STAGED_SECRETS.filter((s) => s.required).map((s) => s.from));
  // The fixed environment value replaces only through rotate.
  const sandbox = new Map(every);
  sandbox.set("ACCESS_PROOF_ENVIRONMENT", sha256("sandbox"));
  refusesSync(() => decideSecrets("apply", sandbox, new Map()), "purchase-secret-exists", ["ACCESS_PROOF_ENVIRONMENT"]);
  const corrected = decideSecrets("rotate", sandbox, new Map());
  assert.deepEqual(corrected.find((i) => i.name === "ACCESS_PROOF_ENVIRONMENT"),
    { name: "ACCESS_PROOF_ENVIRONMENT", action: "replace", value: "production" });
  const rotated = decideSecrets("rotate", every, values);
  assert.equal(rotated.find((i) => i.name === "REVENUECAT_PROJECT_ID").action, "replace");
  assert.equal(rotated.find((i) => i.name === "ACCESS_PROOF_KEY_ID").action, "keep");
  refusesSync(() => decideSecrets("rotate", every, new Map()), "purchase-rotate-nothing-staged");
  refusesSync(() => decideSecrets("rotate", absentProject, values), "purchase-rotate-needs-current-value", ["REVENUECAT_PROJECT_ID"]);
  refusesSync(() => decideSecrets("rotate", new Map(), new Map([["ACCESS_PROOF_KEY_ID", "x"]])), "purchase-rotate-needs-current-value");
});

test("purchase-secrets apply writes once, verifies digests, and no value or digest reaches any output", async (t) => {
  const h = await harness(t);
  const values = syntheticStaged();
  const out = [];
  const installed = await h.run(SECRETS_OP, values, { onProgress: async (r) => out.push(JSON.stringify(r)) });
  assert.equal(installed.status, "verified", installed.issues.join(" "));
  assert.equal(h.api.calls.secretPosts, 1);
  assert.equal(h.api.secrets.get("ACCESS_PROOF_ENVIRONMENT"), "production");
  for (const { name, from } of STAGED_SECRETS) {
    if (values[from]) assert.equal(h.api.secrets.get(name), values[from], name);
  }
  const outcome = Object.fromEntries(installed.steps.map((s) => [s.name, s.outcome]));
  assert.equal(outcome.ACCESS_PROOF_KEY_ID, "installed");
  assert.equal(outcome.REVENUECAT_WEBHOOK_TOKEN, "kept");
  assert.equal(outcome.PRODUCT_POLICY_READER_DB_URL, "present-not-managed");
  assert.equal(outcome.ENTITLEMENT_WRITER_DB_URL, "present-not-managed");
  const again = await h.run(SECRETS_OP, values);
  assert.equal(again.status, "no-change");
  assert.equal(h.api.calls.secretPosts, 1);
  const conflict = await h.run(SECRETS_OP, { ...values, PROD_REVENUECAT_PROJECT_ID: "different" });
  assert.deepEqual(conflict.issues, ["purchase-secret-exists", "REVENUECAT_PROJECT_ID"]);
  // Rotate: only the staged group changes; a missing current name refuses.
  const fresh = syntheticStaged();
  const blank = Object.fromEntries(Object.keys(values).map((key) => [key, ""]));
  h.api.secrets.delete("STRIPE_PRICE_ID");
  const absent = await h.run("rotate", { ...blank, PROD_STRIPE_PRICE_ID: values.PROD_STRIPE_PRICE_ID });
  assert.deepEqual(absent.issues, ["purchase-rotate-needs-current-value", "STRIPE_PRICE_ID"]);
  h.api.secrets.set("STRIPE_PRICE_ID", values.PROD_STRIPE_PRICE_ID);
  const before = new Map(h.api.secrets);
  const rotated = await h.run("rotate", {
    ...blank,
    PROD_APP_STORE_SERVER_KEY_ID: fresh.PROD_APP_STORE_SERVER_KEY_ID,
    PROD_APP_STORE_SERVER_PRIVATE_KEY: fresh.PROD_APP_STORE_SERVER_PRIVATE_KEY,
  });
  assert.equal(rotated.status, "verified", rotated.issues.join(" "));
  assert.deepEqual(
    [...h.api.secrets.keys()].filter((name) => h.api.secrets.get(name) !== before.get(name)).sort(),
    ["APP_STORE_SERVER_KEY_ID", "APP_STORE_SERVER_PRIVATE_KEY"],
  );
  const printed = [...out, JSON.stringify(h.receipts), ...h.receipts.map((r) => renderPurchaseFinal(r))].join("\n");
  for (const value of [...Object.values(values), ...Object.values(fresh), ...h.api.secrets.values()]) {
    if (!value || value === "production") continue;
    assert.ok(!printed.includes(value), "a value reached an output");
    assert.ok(!printed.includes(sha256(value)), "a digest of a value reached an output");
  }
});

test("purchase-secrets refuses before any write without a narrow token, a value, or owner approval", async (t) => {
  const h = await harness(t);
  const values = syntheticStaged();
  const broad = await h.run(SECRETS_OP, { ...values, [SECRETS_TOKEN_ENV]: "broad-token" });
  assert.deepEqual(broad.issues, ["purchase-gate-failed", "secrets_token_too_broad"]);
  const missing = await h.run(SECRETS_OP, { ...values, PROD_ACCESS_APPLE_PRODUCTS_JSON: "" });
  assert.deepEqual(missing.issues, ["purchase-stage-value-missing", "PROD_ACCESS_APPLE_PRODUCTS_JSON"]);
  const unapproved = await h.run(SECRETS_OP, { ...values, EXPECTED_PLAN_DIGEST: "f".repeat(64) });
  assert.deepEqual(unapproved.issues, ["plan-differs"]);
  const wrongMode = await h.run(SECRETS_OP, { ...values, DEPLOY_MODE: "rotate" });
  assert.deepEqual(wrongMode.issues, ["purchase-target-invalid"]);
  for (const r of [broad, missing, unapproved, wrongMode]) {
    assert.equal(r.status, "stopped-before-write");
    assert.equal(r.writeAttempted, false);
  }
  assert.equal(h.api.calls.secretPosts, 0);
  // A hand-edited plan cannot add a writable name.
  const { plan: p } = h.made[SECRETS_OP];
  const widened = { ...p, secrets: { ...p.secrets, staged: [...p.secrets.staged, { name: "X", from: "PROD_X", required: false }] } };
  const receipt = await runPurchaseOperation({ plan: widened, env: context(widened, values), platform: "linux",
    cwd: h.root, sourceDir: h.made[SECRETS_OP].sourceDir, exec: h.db.exec, fetchImpl: h.api.fetchImpl });
  assert.deepEqual(receipt.issues, ["purchase-plan-invalid"]);
});

// ── Records and CLI ──────────────────────────────────────────────────────────────────────────

test("plan and closing records name routes, secret names and fixed codes only", async (t) => {
  const { root, head } = await repo(t);
  const functions = renderPurchasePlan((await plan(t, root, head)).plan);
  for (const name of PURCHASE_FUNCTIONS.map((f) => f.name)) assert.ok(functions.includes(`\`${name}\``), name);
  assert.ok(!functions.includes(REF), "the project ref is bound, not printed");
  assert.match(functions, /sync-settings needs `0024`/);
  const secrets = renderPurchasePlan((await plan(t, root, head, { operation: SECRETS_OP, mode: "rotate" })).plan);
  assert.match(secrets, /ACCESS_PROOF_ENVIRONMENT=production/);
  assert.match(secrets, /STRIPE_SECRET_API_KEY/);
  assert.match(secrets, /Only names that already hold a value/);
  assert.match(renderPurchaseFinal(null, { applyOutcome: "skipped" }), /stopped-before-write/);
  assert.match(renderPurchaseFinal(null, { operation: SECRETS_OP }), /no durable receipt for `purchase-secrets`/);
  const interrupted = renderPurchaseFinal({
    kind: PURCHASE_KIND, operation: SECRETS_OP, mode: "apply", status: "writing-secrets",
    writeAttempted: true, steps: [{ name: "REVENUECAT_PROJECT_ID", outcome: "outcome-unknown" }],
    counts: { "outcome-unknown": 1 }, issues: [], recovery: "",
  });
  assert.match(interrupted, /status: outcome-unknown/);
  assert.match(interrupted, /purchase-secrets rotate/);
});

test("the CLI routes purchase operations to this module and keeps rotate and other inputs closed", async (t) => {
  const { root, head } = await repo(t);
  const out = { text: "", write(s) { this.text += s; } };
  const env = (extra) => ({ DEPLOY_SHA: head, SUPABASE_PRODUCTION_PROJECT_REF: REF, DEPLOY_MIGRATIONS: "", DEPLOY_FUNCTIONS: "", ...extra });
  const source = await mkdtemp(join(tmpdir(), "still-purchase-cli-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  assert.equal(
    await main(["plan", "--source-dir", join(source, "a")], env({ DEPLOY_OPERATION: SECRETS_OP, DEPLOY_MODE: "plan-only", DEPLOY_POLICY_MODE: "none" }), { cwd: root, out }),
    0,
  );
  assert.match(out.text.trim(), /^[a-f0-9]{64}$/);
  assert.equal(
    await main(["plan", "--source-dir", join(source, "b")], env({ DEPLOY_OPERATION: SECRETS_OP, DEPLOY_MODE: "rotate" }), { cwd: root, out }),
    0,
  );
  await refuses(main(["plan", "--source-dir", join(source, "c"), "--artifact-dir", join(source, "c-art")], env({ DEPLOY_OPERATION: FUNCTIONS_OP, DEPLOY_MODE: "rotate" }), { cwd: root, out }), "mode-invalid");
  await refuses(main(["plan", "--source-dir", join(source, "d")], env({ DEPLOY_OPERATION: SECRETS_OP, DEPLOY_MODE: "disable" }), { cwd: root, out }), "mode-invalid");
  await refuses(main(["plan", "--source-dir", join(source, "e")], env({ DEPLOY_OPERATION: "purchase-other", DEPLOY_MODE: "plan-only" }), { cwd: root, out }), "operation-unknown");
  await refuses(main(["plan", "--source-dir", join(source, "f")], env({ DEPLOY_OPERATION: SECRETS_OP, DEPLOY_MODE: "plan-only", DEPLOY_FUNCTIONS: "sync-settings" }), { cwd: root, out }), "purchase-input-invalid");
  const summary = { text: "", write(s) { this.text += s; } };
  assert.equal(await main(["final-summary", "--receipt", join(source, "missing.json")], { DEPLOY_OPERATION: SYNC_OP, APPLY_OUTCOME: "failure" }, { out: summary }), 0);
  assert.match(summary.text, /Purchase closing record/);
});

test("the plan-job rehearsal proves every step through the exact module path, and refuses a hosted target", async (t) => {
  const { root, head } = await repo(t);
  const { plan: p, sourceDir } = await plan(t, root, head, { operation: SECRETS_OP });
  const db = database();
  const lines = [];
  const conn = parseDbUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  const result = await runPurchaseReplay({ exec: db.exec, plan: p, dir: sourceDir, conn, cwd: root, log: (l) => lines.push(l) });
  assert.equal(result.status, "verified", lines.join("\n"));
  assert.equal(result.proofs.length, 8);
  assert.ok(result.proofs.every((proof) => proof.ok));
  assert.match(renderPurchaseReplay(result), /: verified/);
  await refuses(
    runPurchaseReplay({ exec: db.exec, plan: p, dir: sourceDir, cwd: root,
      conn: parseDbUrl(`postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`) }),
    "replay-not-local",
  );
});
