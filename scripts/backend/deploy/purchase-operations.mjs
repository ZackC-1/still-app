// Three owner-approved operations that put Still's production purchase routes and their function
// secrets on the hosted project through the protected `Supabase production deploy` workflow. Nothing
// here is done with the Supabase CLI or by hand, and every write waits for the owner's approval.
//
//   1. purchase-functions                (mode apply)
//      Deploys exactly the routes in PURCHASE_FUNCTIONS (qa-function-bundles.mjs), in that order:
//      product-policy, export-user-data, verify-apple-access, link-apple-access,
//      reconcile-entitlement, create-web-checkout, complete-web-checkout, revenuecat-webhook,
//      then stripe-webhook. Each is a sealed
//      single-file bundle built from the planned commit and read back byte for byte; a route
//      already at that source is left alone.
//   2. purchase-functions-sync-settings  (mode apply)
//      The same, for sync-settings alone. It serves the released 2.x apps' free sync, so it is a
//      separate run with its own owner approval. Its gate also requires migration 0024 (the
//      released-app settings guard) in the hosted history.
//   3. purchase-secrets                  (mode apply; rotate to replace values)
//      Copies GitHub environment secrets named PROD_<NAME> to the function secrets <NAME> that the
//      routes read, and sets ACCESS_PROOF_ENVIRONMENT to the fixed value "production". apply never
//      replaces a different existing value; rotate replaces only names that already have a value.
//
// Hard gates, all checked read-only before the first write (any failure stops the run and names
// fixed codes only):
//   - functions: every migration in supabase/migrations at the planned commit is recorded in the
//     hosted history (no pending migration); for sync-settings that includes 0024. The secrets the
//     routes read must exist, including the configured production purchase credentials and
//     webhook secrets (names only). Runtime configuration still fails closed if values are invalid.
//   - secrets: the Secrets-only token must be refused by GET /functions; every PROD_* variable is a
//     known name; values have no stray whitespace; grouped values arrive together; the access-proof
//     private key matches its public key; the JSON product lists parse.
//
// Public records (plan, logs, step summary) carry names, counts, fixed codes and hashes of public
// code only: never a secret value, a digest of a secret, an email or an account id.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSamePlan,
  canonical,
  defaultExec,
  ENVIRONMENT_NAME,
  isLoopback,
  migrationsAt,
  OWNER_REVIEWER_ID,
  parseDbUrl,
  parseHistory,
  readProtection,
  Refusal,
  requireProductionContext,
  runReadOnlySql,
  sha256,
  TOOLING_PATHS,
} from "./deploy.mjs";
import { deployedMatches, secretsTokenProbe } from "./analytics-subjects.mjs";
import {
  buildFunctionBundles,
  PURCHASE_BUNDLE_SET,
  SYNC_SETTINGS_BUNDLE_SET,
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
import { cleanEdges, managementApi } from "./qa-secrets.mjs";

export const PURCHASE_KIND = "supabase-purchase-operations";
export const FUNCTIONS_OP = "purchase-functions";
export const SYNC_OP = "purchase-functions-sync-settings";
export const SECRETS_OP = "purchase-secrets";

/** The closed operations; apply purchase secrets before deploying purchase functions. */
export const PURCHASE_OPERATIONS = Object.freeze({
  [FUNCTIONS_OP]: Object.freeze({
    modes: Object.freeze(["plan-only", "apply"]),
    set: PURCHASE_BUNDLE_SET,
  }),
  [SYNC_OP]: Object.freeze({
    modes: Object.freeze(["plan-only", "apply"]),
    set: SYNC_SETTINGS_BUNDLE_SET,
  }),
  [SECRETS_OP]: Object.freeze({
    modes: Object.freeze(["plan-only", "apply", "rotate"]),
    set: null,
  }),
});
export const isPurchaseOperation = (name) =>
  Object.hasOwn(PURCHASE_OPERATIONS, String(name ?? ""));

/** The released-app settings guard sync-settings needs in the hosted history first. */
export const SYNC_GUARD_MIGRATION = "0024";

/**
 * Required secrets must exist before any route is deployed. Checked by name only; the runtime
 * validates values. Shared database sign-ins are provisioned by their own protected operations.
 */
export const ROUTE_SECRETS = Object.freeze({
  [FUNCTIONS_OP]: Object.freeze([
    "ENTITLEMENT_WRITER_DB_URL",
    "PRODUCT_POLICY_READER_DB_URL",
    "REVENUECAT_SECRET_API_KEY",
    "REVENUECAT_WEBHOOK_TOKEN",
    "ACCESS_PROOF_ENVIRONMENT",
    "ACCESS_PROOF_KEY_ID",
    "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64",
    "ACCESS_PROOF_PUBLIC_KEY_HEX",
    "ACCESS_APPLE_PRODUCTS_JSON",
    "ACCESS_PROVIDER_PRODUCTS_JSON",
    "APP_STORE_SERVER_ISSUER_ID",
    "APP_STORE_SERVER_KEY_ID",
    "APP_STORE_SERVER_PRIVATE_KEY",
    "REVENUECAT_PROJECT_ID",
    "REVENUECAT_ACCESS_SECRET_API_KEY",
    "STRIPE_SECRET_API_KEY",
    "STRIPE_ACCOUNT_ID",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_API_VERSION",
    "STRIPE_PRICE_ID",
    "STRIPE_PRODUCT_ID",
    "REVENUECAT_STRIPE_PUBLIC_API_KEY",
    "WEB_RETURN_ORIGIN",
    "WEB_RETURN_PATHS_JSON",
  ]),
  [SYNC_OP]: Object.freeze(["SETTINGS_WRITER_DB_URL"]),
});

/** Staged values: GitHub environment secret PROD_<NAME> becomes function secret <NAME>. */
export const STAGE_PREFIX = "PROD_";
const staged = (name, required) =>
  Object.freeze({ name, from: `${STAGE_PREFIX}${name}`, required });
/**
 * `required`: the name must hold a value after an apply (staged now, or already present).
 * Optional names are written only when staged.
 *
 * Live Managed Payments bindings are staged separately from every QA-prefixed value.
 * PRODUCT_POLICY_ADMIN_DB_URL is not here: it is a database sign-in (see SHARED_SECRETS) and is
 * needed only if decision D1 picks the owner page.
 */
export const STAGED_SECRETS = Object.freeze([
  staged("ACCESS_PROOF_KEY_ID", true),
  staged("ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", true),
  staged("ACCESS_PROOF_PUBLIC_KEY_HEX", true),
  staged("ACCESS_APPLE_PRODUCTS_JSON", true),
  staged("ACCESS_PROVIDER_PRODUCTS_JSON", true),
  staged("APP_STORE_SERVER_ISSUER_ID", true),
  staged("APP_STORE_SERVER_KEY_ID", true),
  staged("APP_STORE_SERVER_PRIVATE_KEY", true),
  staged("APPLE_SANDBOX_REVIEW_ENABLED", false),
  staged("REVENUECAT_PROJECT_ID", true),
  staged("REVENUECAT_ACCESS_SECRET_API_KEY", true),
  staged("REVENUECAT_SECRET_API_KEY", true),
  staged("REVENUECAT_WEBHOOK_TOKEN", true),
  staged("STRIPE_SECRET_API_KEY", true),
  staged("STRIPE_ACCOUNT_ID", true),
  staged("STRIPE_WEBHOOK_SECRET", true),
  staged("STRIPE_API_VERSION", true),
  staged("STRIPE_PRICE_ID", true),
  staged("STRIPE_PRODUCT_ID", true),
  staged("REVENUECAT_STRIPE_PUBLIC_API_KEY", true),
  staged("WEB_RETURN_ORIGIN", true),
  staged("WEB_RETURN_PATHS_JSON", true),
]);
/** Written by the operation itself with a fixed, nonsecret value; never staged. */
export const FIXED_SECRETS = Object.freeze([
  Object.freeze({ name: "ACCESS_PROOF_ENVIRONMENT", value: "production" }),
]);
/**
 * Database sign-ins the routes read. Each URL's password must match its role's stored verifier, so
 * it is never staged here: ENTITLEMENT_WRITER_DB_URL is live since 2.x, and the qa-sandbox-secrets
 * operation installs PRODUCT_POLICY_READER_DB_URL and SETTINGS_WRITER_DB_URL with their logins.
 * This operation only reports whether each name is present.
 */
export const SHARED_SECRETS = Object.freeze([
  "ENTITLEMENT_WRITER_DB_URL",
  "PRODUCT_POLICY_READER_DB_URL",
  "SETTINGS_WRITER_DB_URL",
]);
/** Values that only work together: stage all or none of each group. */
export const SECRET_GROUPS = Object.freeze([
  Object.freeze([
    "ACCESS_PROOF_KEY_ID",
    "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64",
    "ACCESS_PROOF_PUBLIC_KEY_HEX",
  ]),
  Object.freeze(["APP_STORE_SERVER_KEY_ID", "APP_STORE_SERVER_PRIVATE_KEY"]),
]);
const JSON_LISTS = ["ACCESS_APPLE_PRODUCTS_JSON", "ACCESS_PROVIDER_PRODUCTS_JSON"];
/** The only function secrets purchase-secrets ever writes. */
export const WRITABLE_SECRETS = Object.freeze(
  [...STAGED_SECRETS.map((item) => item.name), ...FIXED_SECRETS.map((item) => item.name)].sort(),
);
for (const name of WRITABLE_SECRETS) {
  if (/^SUPABASE_/i.test(name) || /^STILL_QA_SANDBOX_/.test(name) || SHARED_SECRETS.includes(name)) {
    throw new Error(`${name} must not be writable here`);
  }
}

/** The Secrets-only token (read and write project secrets; no database or function access). */
export const SECRETS_TOKEN_ENV = "SUPABASE_QA_SECRETS_ACCESS_TOKEN";
export const FUNCTIONS_TOKEN_ENV = "SUPABASE_PRODUCTION_ACCESS_TOKEN";
const HISTORY_SQL = "scripts/backend/deploy/sql/migration-history.sql";
export const PURCHASE_TOOLING = Object.freeze(
  [
    ...new Set([
      ...TOOLING_PATHS,
      "scripts/backend/deploy/analytics-subjects.mjs",
      "scripts/backend/deploy/purchase-operations.mjs",
      "scripts/backend/deploy/qa-function-bundles.mjs",
      "scripts/backend/deploy/qa-functions.mjs",
      "scripts/backend/deploy/qa-secrets.mjs",
      "scripts/backend/deploy/qa-secrets-operation.mjs",
      "scripts/backend/plan.mjs",
      HISTORY_SQL,
    ]),
  ].sort(),
);

const validRef = (ref) => /^[a-z]{20}$/.test(ref ?? "");
const same = (a, b) => canonical(a) === canonical(b);
const refuse = (category, codes) => {
  const refusal = new Refusal(category);
  if (codes?.length) refusal.codes = [...new Set(codes)].sort();
  throw refusal;
};

/** The closed secret names a purchase-secrets plan binds (a hand-edited plan cannot widen them). */
export function secretsManifest() {
  return {
    staged: STAGED_SECRETS.map(({ name, from, required }) => ({ name, from, required })),
    fixed: FIXED_SECRETS.map(({ name, value }) => ({ name, value })),
    shared: [...SHARED_SECRETS],
    groups: SECRET_GROUPS.map((group) => [...group]),
  };
}

/** Refuses any name outside the closed list; SUPABASE_* names are platform-reserved. */
export function assertWritableSecret(name) {
  if (
    typeof name !== "string" || /^SUPABASE_/i.test(name) ||
    !WRITABLE_SECRETS.includes(name)
  ) refuse("purchase-secret-name-refused");
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
  const spec = PURCHASE_OPERATIONS[operation];
  if (!spec) refuse("purchase-operation-unknown");
  if (
    String(migrations ?? "").trim() || String(functions ?? "").trim() ||
    String(expectedRevision ?? "").trim() ||
    String(subjectsSha256 ?? "").trim() || String(baselineSha256 ?? "").trim()
  ) refuse("purchase-input-invalid");
  const policy = String(policyMode ?? "").trim() || "none";
  if (
    !spec.modes.includes(mode) || policy !== "none" ||
    !/^[a-f0-9]{40}$/.test(sha ?? "") || !validRef(projectRef)
  ) refuse("purchase-input-invalid");
  return spec;
}

export async function createPurchasePlan({
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
  const spec = operationInputs({
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
    refuse("purchase-commit-not-on-main");
  }
  const versions = (await migrationsAt(git, revision)).map((item) => item.version);
  if (spec.set && !versions.includes(SYNC_GUARD_MIGRATION)) {
    refuse("purchase-prerequisite-history-missing");
  }
  if (!sourceDir || (spec.set && !artifactDir)) {
    refuse("purchase-artifact-directory-missing");
  }
  await prepareQaSource({ exec, cwd, revision, sourceDir });
  const bundles = spec.set
    ? await buildBundles(spec.set, { sourceDir, artifactDir, exec })
    : null;
  const paths = [
    ...new Set([
      ...PURCHASE_TOOLING,
      ...(bundles ? bundles.sources.map((item) => item.path) : []),
    ]),
  ].sort();
  const files = [];
  for (const path of paths) {
    const source = await git.blob(revision, path);
    const current = await git.blob(workflowRevision, path);
    if (!source || !current || sha256(source) !== sha256(current)) {
      refuse("purchase-bound-file-differs");
    }
    files.push({ path, sha256: sha256(source) });
  }
  const manifest = {
    protocol: 1,
    kind: PURCHASE_KIND,
    operation,
    policyMode: "none",
    mode,
    environment: ENVIRONMENT_NAME,
    revision,
    workflowRevision,
    onFirstParent: await git.onFirstParent(revision, workflowRevision),
    projectRef,
    files,
    bundles,
    // Every migration at the commit must already be in the hosted history (no pending migration).
    migrations: spec.set ? versions : [],
    requiredSecrets: spec.set ? [...ROUTE_SECRETS[operation]] : [],
    secrets: spec.set ? null : secretsManifest(),
    recovery:
      "stop; a run that began writing records outcome-unknown; recover with a reviewed fix-forward through the same operation; never blindly retry",
  };
  return { ...manifest, digest: sha256(canonical(manifest)) };
}

/** Every file the apply relies on, for the workflow's freshness check. */
export const purchaseBoundFiles = (plan) => plan.files;

/** Extracts the exact commit (supabase/, the deploy scripts, the bundled sources) and checks hashes. */
export async function preparePurchaseWorkdir({ exec, cwd, plan, dir }) {
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
    if (!bytes || sha256(bytes) !== file.sha256) refuse("purchase-source-differs");
  }
}

// ── Staged values (read only inside the apply step; never printed) ─────────────────────────────

/** Reads the PROD_* variables. Unknown names and stray whitespace refuse; values stay in memory. */
export function readStaged(env) {
  const known = new Set(STAGED_SECRETS.map((item) => item.from));
  const unexpected = Object.keys(env).filter(
    (key) => key.startsWith(STAGE_PREFIX) && !known.has(key),
  );
  if (unexpected.length) refuse("purchase-stage-unexpected", unexpected);
  const values = new Map();
  const padded = [];
  for (const { name, from } of STAGED_SECRETS) {
    const value = env[from];
    if (typeof value !== "string" || !value.trim()) continue;
    if (!cleanEdges(value)) padded.push(from);
    else values.set(name, value);
  }
  if (padded.length) refuse("purchase-stage-value-whitespace", padded);
  return values;
}

/** Raw 32-byte Ed25519 public key (hex) of a PKCS#8 private key, or null. */
function ed25519PublicHex(pkcs8Base64) {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pkcs8Base64)) return null;
    const key = createPrivateKey({
      key: Buffer.from(pkcs8Base64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (key.asymmetricKeyType !== "ed25519") return null;
    const spki = createPublicKey(key).export({ format: "der", type: "spki" });
    return Buffer.from(spki).subarray(-32).toString("hex");
  } catch {
    return null;
  }
}

/** Shape checks on staged values. Refusals name the PROD_ variable, never the value. */
export function validateStaged(values) {
  const from = (name) => `${STAGE_PREFIX}${name}`;
  const incomplete = [];
  for (const group of SECRET_GROUPS) {
    const present = group.filter((name) => values.has(name));
    if (present.length && present.length !== group.length) {
      incomplete.push(...group.filter((name) => !values.has(name)).map(from));
    }
  }
  if (incomplete.length) refuse("purchase-stage-group-incomplete", incomplete);
  const invalid = [];
  const publicHex = values.get("ACCESS_PROOF_PUBLIC_KEY_HEX");
  const publicOk = publicHex === undefined || /^[0-9a-f]{64}$/.test(publicHex);
  if (!publicOk) invalid.push(from("ACCESS_PROOF_PUBLIC_KEY_HEX"));
  const privateKey = values.get("ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64");
  let mismatch = false;
  if (privateKey !== undefined) {
    const derived = ed25519PublicHex(privateKey);
    if (!derived) invalid.push(from("ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64"));
    else if (publicOk && derived !== publicHex) mismatch = true;
  }
  for (const name of JSON_LISTS) {
    if (!values.has(name)) continue;
    let parsed;
    try {
      parsed = JSON.parse(values.get(name));
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed) || !parsed.length) invalid.push(from(name));
  }
  const shapes = {
    APPLE_SANDBOX_REVIEW_ENABLED: /^(?:true|false)$/,
    STRIPE_SECRET_API_KEY: /^(?:sk|rk)_live_[A-Za-z0-9]{8,240}$/,
    STRIPE_ACCOUNT_ID: /^acct_[A-Za-z0-9]{1,200}$/,
    STRIPE_WEBHOOK_SECRET: /^whsec_[A-Za-z0-9]{1,240}$/,
    STRIPE_API_VERSION: /^2026-09-30\.endive$/,
    STRIPE_PRICE_ID: /^price_[A-Za-z0-9]{1,200}$/,
    STRIPE_PRODUCT_ID: /^prod_[A-Za-z0-9]{1,200}$/,
    REVENUECAT_STRIPE_PUBLIC_API_KEY: /^(?!(?:appl_|goog_|amzn_|sk_|rk_|pk_))[A-Za-z0-9_-]{1,1024}$/,
  };
  for (const [name, shape] of Object.entries(shapes)) {
    if (values.has(name) && !shape.test(values.get(name))) invalid.push(from(name));
  }
  if (values.has("WEB_RETURN_ORIGIN")) {
    try {
      const origin = new URL(values.get("WEB_RETURN_ORIGIN"));
      if (origin.protocol !== "https:" || origin.origin !== values.get("WEB_RETURN_ORIGIN") ||
        origin.username || origin.password || origin.port || !origin.hostname.includes(".")) throw new Error();
    } catch { invalid.push(from("WEB_RETURN_ORIGIN")); }
  }
  if (values.has("WEB_RETURN_PATHS_JSON")) {
    try {
      const paths = JSON.parse(values.get("WEB_RETURN_PATHS_JSON"));
      if (!paths || Array.isArray(paths) || Object.keys(paths).length !== 2 ||
        typeof paths.success !== "string" || typeof paths.cancel !== "string" || paths.success === paths.cancel ||
        [paths.success, paths.cancel].some((path) => path.length > 512 || !/^\/[A-Za-z0-9/_-]*$/.test(path) || path.includes("//"))) throw new Error();
    } catch { invalid.push(from("WEB_RETURN_PATHS_JSON")); }
  }
  if (invalid.length) refuse("purchase-stage-value-invalid", invalid);
  // Names only: the private key's public half differs from the staged public key.
  if (mismatch) refuse("purchase-access-key-pair-mismatch");
}

/**
 * Decides every name before any write. apply installs absent names and refuses a different existing
 * value; rotate replaces only names that already hold a value. Returns the write list.
 */
export function decideSecrets(mode, digest, values) {
  const items = [];
  const conflicts = [];
  const noCurrent = [];
  const missing = [];
  const consider = (name, value, required) => {
    const present = digest.get(name);
    if (value === undefined) {
      if (present) items.push({ name, action: "keep" });
      else if (required) missing.push(name);
      else items.push({ name, action: "absent" });
      return;
    }
    if (!present) {
      if (mode === "rotate") noCurrent.push(name);
      else items.push({ name, action: "install", value });
    } else if (present === sha256(value)) items.push({ name, action: "none" });
    else if (mode === "apply") conflicts.push(name);
    else items.push({ name, action: "replace", value });
  };
  for (const { name, value } of FIXED_SECRETS) consider(name, value, true);
  for (const { name, required } of STAGED_SECRETS) consider(name, values.get(name), required);
  // A rotate with nothing staged may still correct the fixed value; otherwise it has nothing to do.
  if (mode === "rotate" && !values.size && !items.some((item) => item.action === "replace")) {
    refuse("purchase-rotate-nothing-staged");
  }
  if (noCurrent.length) refuse("purchase-rotate-needs-current-value", noCurrent);
  if (missing.length) {
    refuse(
      mode === "apply" ? "purchase-stage-value-missing" : "purchase-secrets-not-installed",
      missing.map((name) =>
        STAGED_SECRETS.some((item) => item.name === name) ? `${STAGE_PREFIX}${name}` : name
      ),
    );
  }
  if (conflicts.length) refuse("purchase-secret-exists", conflicts);
  for (const item of items) {
    if (["install", "replace"].includes(item.action)) assertWritableSecret(item.name);
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

const OUTCOME_UNKNOWN = "outcome-unknown";
const DONE = { install: "installed", replace: "replaced" };
const NOOP = { none: "unchanged", keep: "kept", absent: "absent" };

function recoveryFor(receipt) {
  if (!receipt.writeAttempted) {
    return "Nothing was written. Correct the named problem, then create a new plan and approve it again.";
  }
  if (receipt.operation === SECRETS_OP) {
    return "Stop; do not re-run apply. Names marked outcome-unknown may or may not have changed. Check them privately (names and dashboard only), then recover with a separately approved purchase-secrets rotate; a leaked value is rotated at its provider first.";
  }
  return "Stop; inspect only the attempted route privately. The earlier routes in this record were verified. Recover with a reviewed fix-forward (or the previous reviewed commit) through the same operation; never blindly retry, delete or roll back by hand.";
}

const tally = (steps) => {
  const counts = {};
  for (const { outcome } of steps) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
};

function assertPlanShape(plan) {
  const spec = PURCHASE_OPERATIONS[plan?.operation];
  if (
    plan?.kind !== PURCHASE_KIND || !spec ||
    plan.environment !== ENVIRONMENT_NAME ||
    !["apply", "rotate"].includes(plan.mode) || !spec.modes.includes(plan.mode) ||
    plan.policyMode !== "none" || !validRef(plan.projectRef) ||
    (spec.set !== null) !== (plan.bundles !== null) ||
    (spec.set
      ? plan.secrets !== null ||
        !same(plan.requiredSecrets, ROUTE_SECRETS[plan.operation]) ||
        !Array.isArray(plan.migrations) || !plan.migrations.includes(SYNC_GUARD_MIGRATION) ||
        plan.bundles.kind !== spec.set.kind
      : !same(plan.secrets, secretsManifest()) || !same(plan.migrations, []) ||
        !same(plan.requiredSecrets, []))
  ) refuse("purchase-plan-invalid");
  return spec;
}

export async function runPurchaseOperation({
  plan,
  env,
  platform = process.platform,
  cwd,
  sourceDir,
  artifactDir,
  exec = defaultExec,
  fetchImpl = fetch,
  verifyBundles = verifyFunctionBundles,
  onProgress = async () => {},
}) {
  const receipt = {
    protocol: 1,
    kind: PURCHASE_KIND,
    operation: plan?.operation ?? null,
    mode: plan?.mode ?? null,
    planDigest: plan?.digest ?? null,
    status: "not-started",
    writeAttempted: false,
    steps: [],
    counts: {},
    issues: [],
    recovery: "none needed",
  };
  let values = new Map();
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
    const spec = assertPlanShape(plan);
    assertSamePlan(plan, env.EXPECTED_PLAN_DIGEST);
    if (
      plan.projectRef !== env.SUPABASE_PRODUCTION_PROJECT_REF ||
      env.DEPLOY_MODE !== plan.mode || env.DEPLOY_OPERATION !== plan.operation ||
      (String(env.DEPLOY_POLICY_MODE ?? "").trim() || "none") !== plan.policyMode
    ) refuse("purchase-target-invalid");
    const protection = await readProtection({
      fetchImpl,
      repository: env.GITHUB_REPOSITORY,
      token: env.GH_TOKEN,
      runId: env.GITHUB_RUN_ID,
      includeApprovals: true,
    });
    if (!protection.ok) refuse("purchase-owner-approval-missing");
    await checkSource(plan, sourceDir);
    const conn = parseDbUrl(env.SUPABASE_DB_URL);
    assertQaTarget(plan.projectRef, conn);
    if (spec.set) {
      try {
        await verifyBundles(spec.set, { sourceDir, artifactDir, manifest: plan.bundles, exec });
      } catch {
        refuse("purchase-bundle-differs");
      }
      await deployFunctions({ plan, env, cwd, sourceDir, artifactDir, exec, fetchImpl, conn,
        receipt, step, progress });
    } else {
      values = readStaged(env);
      await writeSecrets({ plan, env, fetchImpl, receipt, step, progress, values });
    }
    if (receipt.status !== "no-change") receipt.status = "verified";
    await progress();
    return receipt;
  } catch (error) {
    receipt.status = receipt.writeAttempted ? OUTCOME_UNKNOWN : "stopped-before-write";
    receipt.issues = error instanceof Refusal
      ? [error.category, ...(error.codes ?? [])]
      : ["purchase-operation-failed"];
    for (const item of receipt.steps) {
      if (item.outcome.startsWith("pending")) item.outcome = "not-attempted";
    }
    receipt.recovery = recoveryFor(receipt);
    await progress().catch(() => {});
    return receipt;
  } finally {
    values.clear();
  }
}

async function deployFunctions({
  plan,
  env,
  cwd,
  sourceDir,
  artifactDir,
  exec,
  fetchImpl,
  conn,
  receipt,
  step,
  progress,
}) {
  const api = management({
    projectRef: plan.projectRef,
    token: env[FUNCTIONS_TOKEN_ENV],
    fetchImpl,
  });
  const listFunctions = async () => inventory(await api("/functions"));
  const listSecrets = async () => secretInventory(await api("/secrets"));
  const bundleBytes = async (upload) => {
    const bytes = await readFile(join(artifactDir, upload.file));
    if (sha256(bytes) !== upload.sha256 || bytes.length !== upload.bytes) {
      refuse("purchase-upload-bytes-differ");
    }
    return bytes;
  };
  // ── Every gate is decided before any write (read-only) ──
  const codes = [];
  const history = parseHistory(
    await runReadOnlySql({
      exec,
      conn,
      target: "production",
      cwd,
      file: join(sourceDir, HISTORY_SQL),
    }),
  );
  const applied = new Set(history.map((item) => item.version));
  for (const version of plan.migrations) {
    if (!applied.has(version)) codes.push(`history_missing:${version}`);
  }
  const secrets = new Set((await listSecrets()).map((item) => item.name));
  for (const name of plan.requiredSecrets) {
    if (!secrets.has(name)) codes.push(`missing_secret:${name}`);
  }
  if (codes.length) refuse("purchase-gate-failed", codes);

  for (const upload of plan.bundles.functions) step(upload.name, "pending");
  await progress();
  for (const upload of plan.bundles.functions) {
    const bytes = await bundleBytes(upload);
    const current = await listFunctions();
    const metadata = current.find((item) => item.slug === upload.name);
    if (await deployedMatches(api, upload, bytes, metadata)) {
      step(upload.name, "unchanged");
      await progress();
      continue;
    }
    await deployRoute({ api, upload, bytes, plan, receipt, step, progress, listFunctions,
      listSecrets, current });
  }
  if (receipt.steps.every((item) => item.outcome === "unchanged")) receipt.status = "no-change";
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
  ) refuse("purchase-deployed-version-differs");
  const expected = [...current.filter((item) => item.slug !== upload.name), metadata]
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (!same(await listFunctions(), expected)) refuse("purchase-preservation-failed");
  if (!same(await listSecrets(), secretsBefore)) refuse("purchase-preservation-failed");
  step(upload.name, previous ? "deployed" : "created");
  receipt.status = "upload-verified";
  await progress();
}

async function writeSecrets({ plan, env, fetchImpl, receipt, step, progress, values }) {
  // The Secrets-only token must not reach functions.
  const probe = await secretsTokenProbe({
    fetchImpl,
    projectRef: plan.projectRef,
    token: env[SECRETS_TOKEN_ENV],
  });
  if (probe) refuse("purchase-gate-failed", [probe]);
  const api = managementApi({ projectRef: plan.projectRef, token: env[SECRETS_TOKEN_ENV], fetchImpl });
  validateStaged(values);
  const before = await api.list();
  const digest = new Map(before.map((item) => [item.name, item.digest]));
  const items = decideSecrets(plan.mode, digest, values);
  for (const item of items) step(item.name, NOOP[item.action] ?? `pending-${item.action}`);
  for (const name of SHARED_SECRETS) {
    step(name, digest.has(name) ? "present-not-managed" : "absent-not-managed");
  }
  const writes = items.filter((item) => ["install", "replace"].includes(item.action));
  if (!writes.length) {
    receipt.status = "no-change";
    await progress();
    return;
  }
  const expected = new Map(digest);
  const body = writes.map(({ name, value }) => {
    assertWritableSecret(name);
    expected.set(name, sha256(value));
    return { name, value };
  });
  for (const item of writes) step(item.name, OUTCOME_UNKNOWN);
  receipt.status = "writing-secrets";
  receipt.writeAttempted = true;
  await progress(); // Durable attempt precedes the write.
  await api.write("POST", body);
  body.length = 0;
  // GET /secrets must show exactly the expected digests: every written name, nothing else moved.
  const observed = new Map((await api.list()).map((item) => [item.name, item.digest]));
  const moved = [...new Set([...expected.keys(), ...observed.keys()])].filter((name) =>
    expected.get(name) !== observed.get(name)
  );
  if (moved.length) refuse("purchase-secret-digest-mismatch", moved.map((name) => `secret:${name}`));
  for (const item of writes) step(item.name, DONE[item.action]);
  await progress();
}

// ── Public records (names, outcomes, counts and fixed codes only) ─────────────────────────────

const DESCRIPTIONS = {
  [FUNCTIONS_OP]:
    "Deploy exactly these routes, in this order, as sealed single-file bundles from this commit, each read back byte for byte. A route already at this source is left alone.",
  [SYNC_OP]:
    "Deploy `sync-settings` alone (it serves the released 2.x apps' free sync) as a sealed single-file bundle from this commit, read back byte for byte. Left alone if already at this source.",
  [SECRETS_OP]: {
    apply:
      "Copy each staged `PROD_<NAME>` environment secret to the function secret `<NAME>` and set `ACCESS_PROOF_ENVIRONMENT=production`. Installs absent names only; a different existing value refuses (use rotate).",
    rotate:
      "Replace each staged `PROD_<NAME>` value's function secret `<NAME>`. Only names that already hold a value; grouped keys move together.",
  },
};

export function renderPurchasePlan(plan) {
  const what = plan.operation === SECRETS_OP
    ? DESCRIPTIONS[SECRETS_OP][plan.mode === "rotate" ? "rotate" : "apply"]
    : DESCRIPTIONS[plan.operation];
  const lines = [
    `## Purchase ${plan.operation} (${plan.mode})`,
    "",
    `- Digest: \`${plan.digest}\`; commit \`${plan.revision}\` on main (workflow from \`${plan.workflowRevision}\`)${plan.onFirstParent ? "" : " ⚠️ reached main through a merged branch; allowed only because every bound file is identical"}; project ref bound.`,
    `- What it does: ${what}`,
  ];
  if (plan.bundles) {
    lines.push(
      `- Routes, in order: ${plan.bundles.functions.map((f) => `\`${f.name}\` (verify_jwt ${f.verifyJwt}) \`${f.sha256.slice(0, 12)}…\``).join(", ")} (${plan.bundles.sources.length} bound source files).`,
      `- Refuses before any write unless the hosted migration history holds all ${plan.migrations.length} migrations at this commit (last \`${plan.migrations.at(-1)}\`; sync-settings needs \`${SYNC_GUARD_MIGRATION}\`) and these secrets exist: ${plan.requiredSecrets.map((name) => `\`${name}\``).join(", ")}.`,
    );
  } else {
    lines.push(
      `- Staged names (\`${STAGE_PREFIX}<NAME>\` to \`<NAME>\`): ${plan.secrets.staged.map((s) => `\`${s.name}\`${s.required ? "" : " (optional)"}`).join(", ")}.`,
      `- Fixed: ${plan.secrets.fixed.map((s) => `\`${s.name}=${s.value}\``).join(", ")}. Reported, never written: ${plan.secrets.shared.map((name) => `\`${name}\``).join(", ")}.`,
      "- Refuses before any write if the Secrets-only token can reach functions, a staged name is unknown, a group is incomplete, the access-proof key pair does not match, or a product list does not parse.",
    );
  }
  lines.push(
    `- Approval environment \`${ENVIRONMENT_NAME}\`; ${plan.mode === "plan-only" ? "a plan-only run reads no secret and writes nothing" : "the plan job reads no secret"}.`,
    "- No value, digest of a secret, email or account id appears in this plan, the logs or the closing record.",
    "",
  );
  return lines.join("\n");
}

export function renderPurchaseFinal(receipt, { applyOutcome, operation } = {}) {
  if (!receipt) {
    if (applyOutcome === "skipped") {
      return "## Purchase closing record\n\n- Status: stopped-before-write.\n- The apply step was skipped; nothing was written.\n";
    }
    return `## Purchase closing record\n\nOutcome unknown: no durable receipt for ${operation ? `\`${operation}\`` : "this run"}. Stop; check the purchase routes and secret names privately, then recover through the same operation. Never blindly retry.\n`;
  }
  if (receipt.writeAttempted && !["verified", "no-change", OUTCOME_UNKNOWN].includes(receipt.status)) {
    receipt = { ...receipt, status: OUTCOME_UNKNOWN, recovery: recoveryFor(receipt) };
  }
  const counts = Object.entries(receipt.counts ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => `${name} ${n}`).join(", ") || "none";
  return [
    "## Purchase closing record",
    "",
    `- Operation: ${receipt.operation ?? "unknown"}; mode ${receipt.mode ?? "unknown"}; status: ${receipt.status}.`,
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

/** In-memory Management API (secrets and functions) and GitHub reads. Synthetic values only. */
export function rehearsalApi(projectRef) {
  const secrets = new Map(
    ["ENTITLEMENT_WRITER_DB_URL", "REVENUECAT_SECRET_API_KEY", "REVENUECAT_WEBHOOK_TOKEN",
      "SETTINGS_WRITER_DB_URL"].map((name) => [name, `rehearsal-${name.toLowerCase()}-${randomBytes(4).toString("hex")}`]),
  );
  const functions = new Map();
  const bodies = new Map();
  const calls = { secretPosts: 0, deploys: 0 };
  let nextId = 1;
  const stamp = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  // Live production routes before this change: deployed long ago by the CLI, with other bytes.
  for (const [slug, version, verifyJwt] of [
    ["reconcile-entitlement", 5, true], ["create-web-checkout", 2, true],
    ["export-user-data", 4, true], ["revenuecat-webhook", 3, false], ["sync-settings", 7, true],
  ]) {
    functions.set(slug, {
      id: `rehearsal-${nextId++}`, slug, name: slug, status: "ACTIVE", version, verify_jwt: verifyJwt,
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
      const bytes = Buffer.from(await init.body.get("file").arrayBuffer());
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
    const envName = encodeURIComponent(ENVIRONMENT_NAME);
    if (url === `${github}/environments/${envName}`) {
      return json(200, {
        id: 1, name: ENVIRONMENT_NAME, can_admins_bypass: false,
        protection_rules: [{ type: "required_reviewers", prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { id: OWNER_REVIEWER_ID } }] }],
        deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
      });
    }
    if (url === `${github}/environments/${envName}/deployment-branch-policies?per_page=100`) {
      return json(200, { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] });
    }
    if (url === `${github}/actions/runs/1/approvals`) {
      return json(200, [{ state: "approved", user: { id: OWNER_REVIEWER_ID }, environments: [{ id: 1 }] }]);
    }
    return json(404, { message: "not found" });
  };
  return { secrets, functions, calls, fetchImpl };
}

/** Points the module's psql calls at the runner's own database. */
function localExec(exec, local, adminPassword) {
  return (cmd, args, opts = {}) => {
    if (cmd !== "psql" || !opts.env) return exec(cmd, args, opts);
    const env = { ...opts.env, PGHOST: local.host, PGPORT: local.port, PGSSLMODE: "disable" };
    if (env.PGUSER === "postgres" && env.PGPASSWORD === adminPassword) env.PGPASSWORD = local.password;
    return exec(cmd, args, { ...opts, env });
  };
}

/** A sibling plan of the same commit (rehearsal only), with a fresh digest. */
function siblingPlan(plan, changes) {
  const { digest: _old, ...rest } = plan;
  const next = { ...rest, ...changes };
  return { ...next, digest: sha256(canonical(next)) };
}

/** Synthetic staged values with a real, matching Ed25519 key pair (rehearsal and tests only). */
export function syntheticStaged() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const hex = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
  const tag = () => randomBytes(6).toString("hex");
  return {
    PROD_ACCESS_PROOF_KEY_ID: `rehearsal-kid-${tag()}`,
    PROD_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    PROD_ACCESS_PROOF_PUBLIC_KEY_HEX: hex,
    PROD_ACCESS_APPLE_PRODUCTS_JSON: JSON.stringify([{ rehearsal: tag() }]),
    PROD_ACCESS_PROVIDER_PRODUCTS_JSON: JSON.stringify([{ rehearsal: tag() }]),
    PROD_APP_STORE_SERVER_ISSUER_ID: `rehearsal-issuer-${tag()}`,
    PROD_APP_STORE_SERVER_KEY_ID: `rehearsal-key-${tag()}`,
    PROD_APP_STORE_SERVER_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\nrehearsal${tag()}\n-----END PRIVATE KEY-----\n`,
    PROD_REVENUECAT_PROJECT_ID: `rehearsal-project-${tag()}`,
    PROD_REVENUECAT_ACCESS_SECRET_API_KEY: `rehearsal-access-${tag()}`,
    PROD_STRIPE_SECRET_API_KEY: `rk_live_rehearsal${tag()}`,
    PROD_STRIPE_ACCOUNT_ID: `acct_rehearsal${tag()}`,
    PROD_STRIPE_WEBHOOK_SECRET: `whsec_rehearsal${tag()}`,
    PROD_STRIPE_API_VERSION: "2026-09-30.endive",
    PROD_STRIPE_PRICE_ID: `price_rehearsal${tag()}`,
    PROD_STRIPE_PRODUCT_ID: `prod_rehearsal${tag()}`,
    PROD_REVENUECAT_STRIPE_PUBLIC_API_KEY: `strp_rehearsal${tag()}`,
    PROD_WEB_RETURN_ORIGIN: "https://rehearsal.invalid",
    PROD_WEB_RETURN_PATHS_JSON: JSON.stringify({ success: "/purchase/success", cancel: "/purchase/cancel" }),
  };
}

/**
 * Plan-job rehearsal of all three operations through the exact module code path, against the
 * runner's throwaway database (every migration at the commit applied) with the Management API and
 * GitHub stubbed in memory. Synthetic bundles stand in for the real ones (the plan job has already
 * compiled the real ones through the bundle compiler, which has its own tests).
 */
export async function runPurchaseReplay({ exec, plan, dir, conn, cwd, log = () => {} }) {
  if (!isLoopback(conn)) {
    throw new Refusal("replay-not-local", "Replay only runs against the runner's own database");
  }
  const ref = plan.projectRef;
  const adminPassword = randomBytes(18).toString("hex");
  const api = rehearsalApi(ref);
  const run = localExec(exec, conn, adminPassword);
  const proofs = [];
  const prove = (name, ok, detail) => {
    proofs.push(detail ? { name, ok, detail } : { name, ok });
    log(`${ok ? "PROVED" : "NOT PROVED"} ${name}${detail ? `: ${detail}` : ""}`);
  };
  const artifactDir = join(dir, ".rehearsal-uploads");
  const bundlesFor = async (set) => {
    const functions = [];
    for (const { name, verifyJwt } of set.routes) {
      const file = `${name}.js`;
      const bytes = Buffer.from(`// rehearsal bundle ${name} ${randomBytes(8).toString("hex")}\n`);
      await writeFile(join(artifactDir, file), bytes);
      functions.push({ name, verifyJwt, file, sha256: sha256(bytes), bytes: bytes.length });
    }
    return { protocol: 1, kind: set.kind, toolchain: {}, sources: [], functions };
  };
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  const bundles = {
    [FUNCTIONS_OP]: await bundlesFor(PURCHASE_BUNDLE_SET),
    [SYNC_OP]: await bundlesFor(SYNC_SETTINGS_BUNDLE_SET),
  };
  const history = parseHistory(
    await runReadOnlySql({ exec, conn, target: "local-replay", cwd, file: join(dir, HISTORY_SQL) }),
  ).map((item) => item.version);
  const planFor = (operation, mode, changes = {}) =>
    siblingPlan(plan, {
      operation,
      mode,
      bundles: bundles[operation] ?? null,
      migrations: operation === SECRETS_OP ? [] : history,
      requiredSecrets: operation === SECRETS_OP ? [] : [...ROUTE_SECRETS[operation]],
      secrets: operation === SECRETS_OP ? secretsManifest() : null,
      ...changes,
    });
  const stagedValues = syntheticStaged();
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
    DEPLOY_POLICY_MODE: "none",
    SUPABASE_PRODUCTION_PROJECT_REF: ref,
    SUPABASE_DB_URL: `postgresql://postgres:${adminPassword}@db.${ref}.supabase.co:5432/postgres?sslmode=require`,
    [FUNCTIONS_TOKEN_ENV]: p.operation === SECRETS_OP ? "" : `rehearsal-functions-${randomBytes(8).toString("hex")}`,
    [SECRETS_TOKEN_ENV]: p.operation === SECRETS_OP ? `rehearsal-secrets-${randomBytes(8).toString("hex")}` : "",
    ...(p.operation === SECRETS_OP ? stagedValues : {}),
    ...extra,
  });
  const receipts = [];
  const operate = async (p, extra) => {
    const receipt = await runPurchaseOperation({
      plan: p, env: envFor(p, extra), platform: "linux", cwd, sourceDir: dir, artifactDir,
      exec: run, fetchImpl: api.fetchImpl, verifyBundles: async () => true,
    });
    receipts.push(receipt);
    return receipt;
  };
  const version = (slug) => api.functions.get(slug)?.version ?? 0;
  const issues = (r) => [r.status, ...r.issues].join(" ");

  // Secrets.
  const secretsPlan = planFor(SECRETS_OP, "apply");
  const broad = await operate(secretsPlan, { [SECRETS_TOKEN_ENV]: `rehearsal-broad-${randomBytes(8).toString("hex")}` });
  const noValue = await operate(secretsPlan, { PROD_REVENUECAT_PROJECT_ID: "" });
  const stray = await operate(secretsPlan, { PROD_SUPABASE_SERVICE_ROLE_KEY: "rehearsal" });
  const other = syntheticStaged();
  const mismatch = await operate(secretsPlan, { PROD_ACCESS_PROOF_PUBLIC_KEY_HEX: other.PROD_ACCESS_PROOF_PUBLIC_KEY_HEX });
  const partial = await operate(secretsPlan, { PROD_APP_STORE_SERVER_KEY_ID: "" });
  prove(
    "secrets negative controls: a token that reaches functions, a missing required value, an unknown PROD_ name, a mismatched access-proof key pair and an incomplete key group are refused before any write",
    [broad, noValue, stray, mismatch, partial].every((r) => r.status === "stopped-before-write" && !r.writeAttempted) &&
      broad.issues.includes("secrets_token_too_broad") &&
      noValue.issues.includes("PROD_REVENUECAT_PROJECT_ID") &&
      stray.issues.includes("PROD_SUPABASE_SERVICE_ROLE_KEY") &&
      mismatch.issues.includes("purchase-access-key-pair-mismatch") &&
      partial.issues.includes("PROD_APP_STORE_SERVER_KEY_ID") && api.calls.secretPosts === 0,
    `${noValue.issues.join(" ")}`,
  );

  const installed = await operate(secretsPlan);
  const writtenNames = [...FIXED_SECRETS.map((s) => s.name),
    ...STAGED_SECRETS.filter((s) => stagedValues[s.from]).map((s) => s.name)];
  prove(
    "secrets apply: one write installs every staged name and ACCESS_PROOF_ENVIRONMENT=production, each value matching its digest; live names are kept; database sign-ins are reported, never written",
    installed.status === "verified" && api.calls.secretPosts === 1 &&
      api.secrets.get("ACCESS_PROOF_ENVIRONMENT") === "production" &&
      STAGED_SECRETS.every((s) => !stagedValues[s.from] || api.secrets.get(s.name) === stagedValues[s.from]) &&
      installed.steps.filter((s) => s.outcome === "installed").length === writtenNames.length &&
      installed.steps.some((s) => s.name === "REVENUECAT_WEBHOOK_TOKEN" && s.outcome === "kept") &&
      installed.steps.some((s) => s.name === "SETTINGS_WRITER_DB_URL" && s.outcome === "present-not-managed"),
    issues(installed),
  );
  const again = await operate(secretsPlan);
  const conflict = await operate(secretsPlan, { PROD_REVENUECAT_PROJECT_ID: `rehearsal-other-${randomBytes(4).toString("hex")}` });
  prove(
    "secrets apply again: no change; a different value for an existing name is refused (rotate only)",
    again.status === "no-change" && conflict.status === "stopped-before-write" &&
      conflict.issues.includes("purchase-secret-exists") && conflict.issues.includes("REVENUECAT_PROJECT_ID") &&
      api.calls.secretPosts === 1,
    `${again.status}; ${conflict.issues.join(" ")}`,
  );

  const rotatePlan = planFor(SECRETS_OP, "rotate");
  const onlyKeys = Object.fromEntries(Object.keys(stagedValues).map((key) => [key, ""]));
  const priorPrice = api.secrets.get("STRIPE_PRICE_ID");
  api.secrets.delete("STRIPE_PRICE_ID");
  const absent = await operate(rotatePlan, { ...onlyKeys, PROD_STRIPE_PRICE_ID: stagedValues.PROD_STRIPE_PRICE_ID });
  api.secrets.set("STRIPE_PRICE_ID", priorPrice);
  const before = new Map(api.secrets);
  const fresh = syntheticStaged();
  const rotated = await operate(rotatePlan, {
    ...onlyKeys,
    PROD_ACCESS_PROOF_KEY_ID: fresh.PROD_ACCESS_PROOF_KEY_ID,
    PROD_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64: fresh.PROD_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64,
    PROD_ACCESS_PROOF_PUBLIC_KEY_HEX: fresh.PROD_ACCESS_PROOF_PUBLIC_KEY_HEX,
  });
  const changed = [...api.secrets.keys()].filter((name) => api.secrets.get(name) !== before.get(name)).sort();
  prove(
    "secrets rotate: a name with no current value is refused; the access-proof key group is replaced together and nothing else changes",
    absent.status === "stopped-before-write" && absent.issues.includes("purchase-rotate-needs-current-value") &&
      rotated.status === "verified" &&
      canonical(changed) === canonical(SECRET_GROUPS[0].slice().sort()),
    `${absent.issues.join(" ")}; ${issues(rotated)}`,
  );

  // Functions: negative controls first, refused before any write.
  const functionsPlan = planFor(FUNCTIONS_OP, "apply");
  const unapproved = await operate(functionsPlan, { EXPECTED_PLAN_DIGEST: "f".repeat(64) });
  const noReader = await operate(functionsPlan);
  api.secrets.set("PRODUCT_POLICY_READER_DB_URL", `rehearsal-reader-${randomBytes(4).toString("hex")}`);
  const pending = await operate(planFor(FUNCTIONS_OP, "apply", { migrations: [...history, "9999"] }));
  const pendingSync = await operate(planFor(SYNC_OP, "apply", { migrations: [...history, "9999"] }));
  prove(
    "negative controls: an unapproved plan, a missing live database sign-in, and a pending migration (functions and sync-settings) are refused before any write",
    [unapproved, noReader, pending, pendingSync].every((r) => r.status === "stopped-before-write" && !r.writeAttempted) &&
      unapproved.issues.includes("plan-differs") &&
      noReader.issues.includes("missing_secret:PRODUCT_POLICY_READER_DB_URL") &&
      pending.issues.includes("history_missing:9999") && pendingSync.issues.includes("history_missing:9999") &&
      api.calls.deploys === 0,
    `${unapproved.issues[0]}; ${noReader.issues.at(-1)}; ${pending.issues.at(-1)}`,
  );

  const deployed = await operate(functionsPlan);
  const order = PURCHASE_BUNDLE_SET.routes.map((route) => route.name);
  prove(
    "purchase-functions: exactly the purchase routes deploy in order with their verify_jwt and read back; sync-settings is untouched; a repeat changes nothing",
    deployed.status === "verified" && deployed.steps.map((s) => s.name).join(",") === order.join(",") &&
      api.calls.deploys === order.length && version("sync-settings") === 7 &&
      version("reconcile-entitlement") === 6 && version("product-policy") === 1 &&
      PURCHASE_BUNDLE_SET.routes.every((route) => api.functions.get(route.name)?.verify_jwt === route.verifyJwt) &&
      (await operate(functionsPlan)).status === "no-change",
    issues(deployed),
  );

  const syncPlan = planFor(SYNC_OP, "apply");
  const synced = await operate(syncPlan);
  const syncedAgain = await operate(syncPlan);
  prove(
    "purchase-functions-sync-settings: only sync-settings deploys (verify_jwt true); a repeat changes nothing",
    synced.status === "verified" && synced.steps.length === 1 && version("sync-settings") === 8 &&
      api.functions.get("sync-settings").verify_jwt === true && syncedAgain.status === "no-change" &&
      api.calls.deploys === order.length + 1,
    issues(synced),
  );

  const printed = JSON.stringify(receipts);
  const values = [...Object.values(stagedValues), ...Object.values(fresh), ...api.secrets.values()]
    .filter((value) => value && value !== "production");
  prove(
    "no value or digest of a secret appears in any receipt",
    values.every((value) => !printed.includes(value) && !printed.includes(sha256(value))),
  );
  return {
    kind: PURCHASE_KIND,
    status: proofs.every((p) => p.ok) ? "verified" : "rehearsal-failed",
    operation: plan.operation,
    proofs,
  };
}

export function renderPurchaseReplay(result) {
  return [
    `## Rehearsal of the purchase operations (planned: \`${result.operation}\`) on a throwaway database (no production access; Management API and GitHub stubbed): ${result.status}`,
    "",
    ...result.proofs.map((p) => `- ${p.ok ? "✅" : "❌"} ${p.name}${p.detail ? ` — ${p.detail}` : ""}`),
    "",
  ].join("\n");
}
