// One protected operation: deploy the eight sealed sandbox functions. No migrations,
// secrets, provider settings, registry rows or production function bodies are written.
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertSamePlan,
  canonical,
  checkFreshness,
  defaultExec,
  ENVIRONMENT_NAME,
  isLoopback,
  lintVerificationSql,
  makeGit,
  migrationsAt,
  parseDbUrl,
  parseJsonArray,
  readProtection,
  Refusal,
  requireProductionContext,
  runReadOnlySql,
  sha256,
  TOOLING_PATHS,
} from "./deploy.mjs";
import {
  buildQaFunctionBundles,
  verifyQaFunctionBundles,
} from "./qa-function-bundles.mjs";

export const QA_OPERATION = "qa-sandbox-functions";
export const QA_KIND = "supabase-exact-qa-functions";
export const QA_GATE =
  "scripts/backend/deploy/verify/0021_qa_sandbox_access.sql";
export const PREREQUISITES =
  "scripts/backend/deploy/verify/qa-function-prerequisites.sql";
const ROLE_FACTS = "scripts/backend/deploy/sql/role-facts.sql";
export const QA_TOOLING = Object.freeze([
  ...TOOLING_PATHS,
  "scripts/backend/deploy/qa-functions.mjs",
  "scripts/backend/deploy/qa-function-bundles.mjs",
  "scripts/backend/plan.mjs",
  QA_GATE,
  PREREQUISITES,
  ".github/workflows/supabase-qa-functions-rehearsal.yml",
]);
export const REQUIRED_SECRETS = Object.freeze([
  "PRODUCT_POLICY_READER_DB_URL",
  "SETTINGS_WRITER_DB_URL",
  ...[
    "ACCESS_PROOF_KEY_ID",
    "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64",
    "ACCESS_PROOF_PUBLIC_KEY_HEX",
    "ACCESS_APPLE_PRODUCTS_JSON",
    "APP_STORE_SERVER_PRIVATE_KEY",
    "APP_STORE_SERVER_KEY_ID",
    "APP_STORE_SERVER_ISSUER_ID",
    "ENTITLEMENT_WRITER_DB_URL",
    "REVENUECAT_PROJECT_ID",
    "REVENUECAT_ACCESS_SECRET_API_KEY",
    "ACCESS_PROVIDER_PRODUCTS_JSON",
    "STRIPE_SECRET_API_KEY",
    "STRIPE_ACCOUNT_ID",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_API_VERSION",
    "STRIPE_PRICE_ID",
    "STRIPE_PRODUCT_ID",
    "REVENUECAT_STRIPE_PUBLIC_API_KEY",
    "WEB_RETURN_ORIGIN",
    "WEB_RETURN_PATHS_JSON",
  ].map((suffix) => `STILL_QA_SANDBOX_${suffix}`),
]);
// Every issue-code prefix the two read-only gates can emit. Each suffix those SQL files append
// is drawn from a fixed list inside the SQL itself (signatures, role, table and setting names),
// never from row contents. A test keeps this list equal to the prefixes found in both files.
export const READINESS_ISSUE_PREFIXES = Object.freeze([
  "QA_account_defaults",
  "QA_client_RPC",
  "QA_database_role_setting",
  "QA_direct_table",
  "QA_extra_policy",
  "QA_internal_core",
  "QA_live_RPC",
  "QA_missing_role_setting",
  "QA_missing_table_or_RLS",
  "QA_new_column_ACL",
  "QA_new_table_ACL",
  "QA_owner_auth_mutation",
  "QA_owner_default_execute",
  "QA_owner_legacy_mutation",
  "QA_owner_schema_create",
  "QA_production_removal_default",
  "QA_retention_schedule",
  "QA_role_membership",
  "QA_shared_RLS",
  "QA_shared_trigger",
  "QA_wrong_RLS_policy",
  "client_private_grant",
  "direct_table_grant",
  "missing_QA_role",
  "missing_history",
  "missing_private_usage",
  "missing_relation",
  "missing_role",
  "missing_routine",
  "private_schema",
  "role_membership",
  "role_not_login",
  "routine_acl",
  "routine_body",
  "routine_definer",
  "routine_grant_option",
  "routine_grantable",
  "routine_owner",
  "routine_path",
  "sandbox_sales_policy_missing",
  "unsafe_QA_role",
  "unsafe_role",
]);
const ISSUE_CODE = /^([A-Za-z_]{1,48})(?::([a-z0-9_.,()=]{1,160}))?$/;
const MAX_READINESS_CODES = 200;
const same = (a, b) => canonical(a) === canonical(b);
const refuse = (category, codes) => {
  const refusal = new Refusal(category);
  if (codes) refusal.codes = codes;
  throw refusal;
};

// Readable readiness: sorted, de-duplicated fixed identifiers only. Anything that is not a
// known prefix with a catalog-identifier suffix collapses to one marker, so free text, facts,
// digests or values can never reach the public closing record.
export function readinessCodes(...lists) {
  const codes = new Set();
  for (const list of lists) {
    for (const code of Array.isArray(list) ? list : [null]) {
      const match = typeof code === "string" ? ISSUE_CODE.exec(code) : null;
      codes.add(
        match && READINESS_ISSUE_PREFIXES.includes(match[1])
          ? code
          : "unrecognized_issue_code",
      );
    }
  }
  const sorted = [...codes].sort();
  return sorted.length > MAX_READINESS_CODES
    ? [
      ...sorted.slice(0, MAX_READINESS_CODES),
      `more_issue_codes:${sorted.length - MAX_READINESS_CODES}`,
    ]
    : sorted;
}

// Names come only from REQUIRED_SECRETS; presence is judged by name, never by value or digest.
export function missingSecretCodes(secrets) {
  return REQUIRED_SECRETS.filter((name) =>
    !secrets.some((item) => item.name === name)
  ).map((name) => `missing_secret:${name}`);
}
const validRef = (ref) => /^[a-z]{20}$/.test(ref ?? "");
const validHash = (hash) => /^[a-f0-9]{64}$/.test(hash ?? "");

export function qaInputs(
  { sha, projectRef, baselineSha256, mode, migrations, functions },
) {
  if (String(migrations ?? "").trim() || String(functions ?? "").trim()) {
    refuse("qa-input-invalid");
  }
  if (
    !/^[a-f0-9]{40}$/.test(sha ?? "") || !validRef(projectRef) ||
    !["plan-only", "apply", "baseline-only"].includes(mode)
  ) refuse("qa-input-invalid");
  if (
    (baselineSha256 && !validHash(baselineSha256)) ||
    (mode === "apply" && !validHash(baselineSha256))
  ) refuse("qa-baseline-missing");
}

export function assertQaTarget(projectRef, conn) {
  if (
    !validRef(projectRef) || isLoopback(conn) || conn.database !== "postgres"
  ) {
    refuse("qa-target-invalid");
  }
  const direct = conn.host === `db.${projectRef}.supabase.co` &&
    conn.user === "postgres";
  const pooler =
    /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(conn.host) &&
    conn.user === `postgres.${projectRef}`;
  if (!direct && !pooler) refuse("qa-target-invalid");
}

// The compiler sees a fresh immutable Git archive, never the invoking checkout.
export async function prepareQaSource(
  { exec = defaultExec, cwd, revision, sourceDir },
) {
  sourceDir = resolve(sourceDir);
  await mkdir(sourceDir, { recursive: true });
  if (
    (await lstat(sourceDir)).isSymbolicLink() ||
    (await readdir(sourceDir)).length
  ) {
    refuse("qa-source-directory-not-empty");
  }
  const archive = join(sourceDir, ".source.tar");
  for (
    const [command, args] of [
      ["git", [
        "archive",
        "--format=tar",
        `--output=${archive}`,
        revision,
        "supabase",
        "packages/core/src",
        "packages/shared-types/src",
        "scripts/backend",
        ".github/workflows",
      ]],
      ["tar", ["-xf", archive, "-C", sourceDir]],
    ]
  ) {
    const result = await exec(command, args, { cwd });
    if (result.code !== 0) refuse("qa-source-extraction-failed");
  }
  await rm(archive);
}

export async function createQaFunctionPlan({
  git,
  sha,
  mainRef = "HEAD",
  cwd,
  sourceDir,
  artifactDir,
  projectRef,
  baselineSha256 = "",
  mode = "plan-only",
  migrations,
  functions,
  exec = defaultExec,
}) {
  qaInputs({ sha, projectRef, baselineSha256, mode, migrations, functions });
  const revision = await git.commit(sha);
  const workflowRevision = await git.commit(mainRef);
  if (revision !== sha || !(await git.isAncestor(revision, workflowRevision))) {
    refuse("qa-commit-not-on-main");
  }
  const history = await migrationsAt(git, revision);
  if (!same(history, await migrationsAt(git, workflowRevision))) {
    refuse("qa-history-differs");
  }
  for (const version of ["0015", "0016", "0019", "0020", "0021"]) {
    if (!history.some((item) => item.version === version)) {
      refuse("qa-prerequisite-history-missing");
    }
  }
  if (!sourceDir || !artifactDir) refuse("qa-artifact-directory-missing");
  await prepareQaSource({ exec, cwd, revision, sourceDir });
  const bundles = await buildQaFunctionBundles({
    sourceDir,
    artifactDir,
    exec,
  });
  const paths = [
    ...new Set([
      ...QA_TOOLING,
      ...bundles.sources.map((item) => item.path),
      ...history.map(({ file }) => `supabase/migrations/${file}`),
    ]),
  ].sort();
  const files = [];
  for (const path of paths) {
    const source = await git.blob(revision, path);
    const current = await git.blob(workflowRevision, path);
    if (!source || !current || sha256(source) !== sha256(current)) {
      refuse("qa-bound-file-differs");
    }
    if (path === QA_GATE || path === PREREQUISITES) {
      lintVerificationSql(source.toString());
    }
    files.push({ path, sha256: sha256(source) });
  }
  const manifest = {
    protocol: 1,
    kind: QA_KIND,
    operation: QA_OPERATION,
    environment: ENVIRONMENT_NAME,
    revision,
    workflowRevision,
    projectRef,
    baselineSha256: baselineSha256 || null,
    mode,
    bundles,
    files,
    expectedHistoryAfter: history.map(({ version, name }) => ({
      version,
      name,
    })),
    recovery:
      "stop; reviewed fix-forward or separately approved QA disable; no automatic rollback or retry",
  };
  return { ...manifest, digest: sha256(canonical(manifest)) };
}

// Keep the complete private inventory in memory. Public records contain its hash only.
function inventory(value) {
  if (!Array.isArray(value)) refuse("qa-function-inventory-invalid");
  const fields = [
    "id",
    "slug",
    "name",
    "status",
    "version",
    "verify_jwt",
    "import_map",
    "import_map_path",
    "entrypoint_path",
    "ezbr_sha256",
    "created_at",
    "updated_at",
  ];
  const seen = new Set();
  return value.map((item) => {
    if (
      !item || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(item.slug ?? "") ||
      typeof item.id !== "string" || !item.id || seen.has(item.slug) ||
      !Number.isInteger(item.version) || item.version < 1 ||
      typeof item.verify_jwt !== "boolean" || typeof item.status !== "string"
    ) {
      refuse("qa-function-inventory-invalid");
    }
    seen.add(item.slug);
    return Object.fromEntries(
      fields.map((field) => [field, item[field] ?? null]),
    );
  }).sort((a, b) => a.slug.localeCompare(b.slug));
}

// Management GET /secrets calls the SHA256 digest "value" (also the pinned CLI
// DIGEST column). Normalize only validated hashes; never retain a secret plaintext.
// https://supabase.com/docs/reference/api/v1-list-all-secrets
function secretInventory(value) {
  if (!Array.isArray(value)) refuse("qa-secret-inventory-invalid");
  const seen = new Set();
  return value.map((item) => {
    if (
      !item || typeof item.name !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/.test(item.name) ||
      seen.has(item.name) || !validHash(item.value) || "digest" in item
    ) {
      refuse("qa-secret-inventory-invalid");
    }
    seen.add(item.name);
    return { name: item.name, digest: item.value };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function management({ projectRef, token, fetchImpl }) {
  if (
    !validRef(projectRef) || typeof token !== "string" || !token.trim() ||
    /[\r\n]/.test(token)
  ) {
    refuse("qa-management-configuration-missing");
  }
  const root = `https://api.supabase.com/v1/projects/${projectRef}`;
  return async (path, { body, multipart = false } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method: body ? "POST" : "GET",
        body,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(multipart
            ? { Accept: "multipart/form-data" }
            : { Accept: "application/json" }),
        },
      });
    } catch {
      refuse(body ? "qa-upload-outcome-unknown" : "qa-management-read-failed");
    }
    if (!response.ok) {
      refuse(body ? "qa-upload-outcome-unknown" : "qa-management-read-failed");
    }
    try {
      return multipart ? await response.formData() : await response.json();
    } catch {
      refuse(
        body ? "qa-upload-outcome-unknown" : "qa-management-response-invalid",
      );
    }
  };
}

async function baseline({ api, exec, cwd, sourceDir, conn, plan }) {
  const query = async (path) =>
    parseJsonArray(
      await runReadOnlySql({
        exec,
        conn,
        target: "production",
        cwd,
        file: join(sourceDir, path),
      }),
      "qa-catalog-unreadable",
    );
  const gates = await query(QA_GATE);
  const prerequisite = await query(PREREQUISITES);
  if (
    gates.length || prerequisite.length !== 1 ||
    !Array.isArray(prerequisite[0]?.issues) ||
    prerequisite[0].issues.length || !Array.isArray(prerequisite[0]?.facts) ||
    !Array.isArray(prerequisite[0]?.history) ||
    typeof prerequisite[0]?.policyDigest !== "string"
  ) {
    const lists = [];
    if (gates.length) lists.push(gates);
    if (prerequisite.length !== 1 || !Array.isArray(prerequisite[0]?.issues)) {
      lists.push(null);
    } else if (prerequisite[0].issues.length) {
      lists.push(prerequisite[0].issues);
    }
    let secrets;
    try {
      secrets = missingSecretCodes(secretInventory(await api("/secrets")));
    } catch {
      secrets = ["secret_inventory_unreadable"];
    }
    refuse("qa-prerequisite-gate-failed", [
      ...secrets,
      ...(lists.length ? readinessCodes(...lists) : []),
    ]);
  }
  if (!same(prerequisite[0].history, plan.expectedHistoryAfter)) {
    refuse("qa-hosted-history-differs");
  }
  const roles = await query(ROLE_FACTS);
  if (
    !roles.length || roles.some((fact) => typeof fact !== "string") ||
    prerequisite[0].facts.some((fact) => typeof fact !== "string")
  ) refuse("qa-catalog-unreadable");
  const functions = inventory(await api("/functions"));
  const secrets = secretInventory(await api("/secrets"));
  const state = { functions, secrets, roles, catalog: prerequisite[0] };
  return { state, digest: sha256(canonical(state)) };
}

function qaMetadata(item, upload) {
  if (
    item.slug !== upload.name || item.name !== upload.name ||
    item.status !== "ACTIVE" ||
    item.verify_jwt !== upload.verifyJwt || item.import_map !== false ||
    item.import_map_path !== null || !validHash(item.ezbr_sha256) ||
    typeof item.entrypoint_path !== "string" ||
    !item.entrypoint_path.endsWith(`/${upload.file}`)
  ) refuse("qa-deployed-metadata-differs");
}

async function readback({ api, upload, posted, bytes }) {
  const metadata = async () =>
    inventory([await api(`/functions/${upload.name}`)])[0];
  const before = await metadata();
  qaMetadata(before, upload);
  const post = inventory([posted])[0];
  if (!same(post, before)) refuse("qa-upload-readback-differs");
  const body = await api(`/functions/${upload.name}/body`, { multipart: true });
  let file = null;
  let metadataPart = null;
  for (const [name, value] of body) {
    if (typeof value === "string") {
      if (name !== "metadata" || metadataPart !== null) {
        refuse("qa-deployed-source-differs");
      }
      try {
        metadataPart = JSON.parse(value);
      } catch {
        refuse("qa-deployed-source-differs");
      }
    } else {
      if (file || value.name.split("/").at(-1) !== upload.file) {
        refuse("qa-deployed-source-differs");
      }
      file = Buffer.from(await value.arrayBuffer());
    }
  }
  if (
    !file || !file.equals(bytes) || sha256(file) !== upload.sha256 ||
    (metadataPart &&
      (Object.keys(metadataPart).some((key) =>
        key !== "deno2_entrypoint_path"
      ) ||
        typeof metadataPart.deno2_entrypoint_path !== "string" ||
        !metadataPart.deno2_entrypoint_path.endsWith(`/${upload.file}`)))
  ) refuse("qa-deployed-source-differs");
  const after = await metadata();
  if (!same(before, after)) refuse("qa-deployed-version-moved");
  return after;
}

export async function runQaFunctionOperation({
  plan,
  env,
  platform,
  cwd,
  sourceDir,
  artifactDir,
  exec = defaultExec,
  fetchImpl = fetch,
  onProgress = async () => {},
}) {
  const receipt = {
    protocol: 1,
    kind: QA_KIND,
    operation: QA_OPERATION,
    planDigest: plan?.digest ?? null,
    status: "not-started",
    writeAttempted: false,
    attemptedRoute: null,
    completed: [],
    issues: [],
    recovery: "none needed",
  };
  const progress = () => onProgress(structuredClone(receipt));
  try {
    await progress();
    requireProductionContext(env, platform);
    if (
      plan.kind !== QA_KIND || plan.operation !== QA_OPERATION ||
      plan.environment !== ENVIRONMENT_NAME
    ) {
      refuse("qa-plan-invalid");
    }
    assertSamePlan(plan, env.EXPECTED_PLAN_DIGEST);
    qaInputs({
      sha: plan.revision,
      projectRef: env.SUPABASE_PRODUCTION_PROJECT_REF,
      baselineSha256: plan.baselineSha256,
      mode: plan.mode,
      migrations: env.DEPLOY_MIGRATIONS,
      functions: env.DEPLOY_FUNCTIONS,
    });
    if (
      plan.projectRef !== env.SUPABASE_PRODUCTION_PROJECT_REF ||
      env.DEPLOY_MODE !== plan.mode ||
      !["apply", "baseline-only"].includes(plan.mode)
    ) {
      refuse("qa-target-invalid");
    }
    const protection = await readProtection({
      fetchImpl,
      repository: env.GITHUB_REPOSITORY,
      token: env.GH_TOKEN,
      runId: env.GITHUB_RUN_ID,
      includeApprovals: true,
    });
    if (!protection.ok) refuse("qa-owner-approval-missing");
    const git = makeGit(exec, cwd);
    await checkFreshness({ git, plan, tipRef: "refs/remotes/origin/main" });
    for (const file of plan.files) {
      const source = await git.blob(plan.revision, file.path);
      if (
        !source || sha256(source) !== file.sha256 ||
        sha256(await readFile(join(sourceDir, file.path))) !== file.sha256
      ) {
        refuse("qa-source-differs");
      }
    }
    await verifyQaFunctionBundles({
      sourceDir,
      artifactDir,
      manifest: plan.bundles,
      exec,
    });
    const conn = parseDbUrl(env.SUPABASE_DB_URL);
    assertQaTarget(plan.projectRef, conn);
    const api = management({
      projectRef: plan.projectRef,
      token: env.SUPABASE_PRODUCTION_ACCESS_TOKEN,
      fetchImpl,
    });
    const options = { api, exec, cwd, sourceDir, conn, plan };
    const initial = await baseline(options);
    receipt.baselineSha256 = initial.digest;
    receipt.functionCount = initial.state.functions.length;
    receipt.secretCount = initial.state.secrets.length;
    const missingSecrets = missingSecretCodes(initial.state.secrets);
    if (plan.mode === "baseline-only") {
      // Read-only readiness: the baseline still succeeds, and any absent required secret is
      // listed by name because an apply against this state would refuse.
      receipt.issues = missingSecrets;
      receipt.status = "baseline-read-only";
      await progress();
      return receipt;
    }
    if (initial.digest !== plan.baselineSha256) refuse("qa-baseline-drift");
    if (missingSecrets.length) {
      refuse("qa-required-secret-missing", missingSecrets);
    }
    let expected = initial.state;
    for (const upload of plan.bundles.functions) {
      const current = await baseline(options);
      if (!same(current.state, expected)) refuse("qa-baseline-drift");
      const bytes = await readFile(join(artifactDir, upload.file));
      if (sha256(bytes) !== upload.sha256 || bytes.length !== upload.bytes) {
        refuse("qa-upload-bytes-differ");
      }
      const body = new FormData();
      body.set(
        "metadata",
        JSON.stringify({
          name: upload.name,
          entrypoint_path: upload.file,
          verify_jwt: upload.verifyJwt,
        }),
      );
      body.append(
        "file",
        new Blob([bytes], { type: "application/javascript" }),
        upload.file,
      );
      receipt.status = "uploading";
      receipt.writeAttempted = true;
      receipt.attemptedRoute = upload.name;
      await progress(); // Durable attempt precedes the potentially ambiguous network write.
      const posted = await api(`/functions/deploy?slug=${upload.name}`, {
        body,
      });
      const metadata = await readback({ api, upload, posted, bytes });
      const previous = expected.functions.find((item) =>
        item.slug === upload.name
      );
      if (
        metadata.version !== (previous?.version ?? 0) + 1 ||
        (previous &&
          (metadata.id !== previous.id ||
            metadata.created_at !== previous.created_at))
      ) {
        refuse("qa-deployed-version-differs");
      }
      const functions = [
        ...expected.functions.filter((item) => item.slug !== upload.name),
        metadata,
      ]
        .sort((a, b) => a.slug.localeCompare(b.slug));
      expected = { ...expected, functions };
      const after = await baseline(options);
      if (!same(after.state, expected)) refuse("qa-preservation-failed");
      receipt.completed.push({
        name: upload.name,
        version: metadata.version,
        uploadSha256: upload.sha256,
        runtimeSha256: metadata.ezbr_sha256,
      });
      receipt.status = "upload-verified";
      await progress();
    }
    receipt.status = "verified";
    receipt.finalBaselineSha256 = sha256(canonical(expected));
    await progress();
    return receipt;
  } catch (error) {
    receipt.status = receipt.writeAttempted
      ? "function-outcome-unknown"
      : "stopped-before-write";
    receipt.issues = error instanceof Refusal
      ? [error.category, ...(error.codes ?? [])]
      : ["qa-operation-failed"];
    receipt.recovery = receipt.writeAttempted
      ? "Stop; inspect only the attempted QA routes privately; obtain a reviewed fix-forward or separately approved QA disable. Never blindly retry, delete or roll back."
      : "Correct the fixed readiness failure and create a new exact plan before approval.";
    await progress();
    return receipt;
  }
}

export function renderQaPlan(plan) {
  return `## Fixed sandbox function ${plan.mode} plan\n\n` +
    `- Commit: \`${plan.revision}\`; digest: \`${plan.digest}\`.\n` +
    `- Exactly eight sealed QA uploads; production functions, SQL, secrets and registry unchanged.\n` +
    `- Approved baseline: \`${
      plan.baselineSha256 ??
        "not supplied; read-only baseline operation required"
    }\`.\n` +
    `- Source preparation does not establish hosted or installed-device acceptance.\n`;
}

export function renderQaFinal(receipt, { applyOutcome } = {}) {
  if (!receipt) {
    if (applyOutcome === "skipped") {
      return "## QA function closing record\n\n- Status: stopped-before-write.\n- Apply step was skipped; no function upload was attempted.\n- Correct the prerequisite failure before creating a new plan.\n";
    }
    return "## QA function closing record\n\nFunction outcome unknown: no durable receipt. Stop and inspect the attempted QA routes privately before a reviewed fix-forward. Never blindly retry.\n";
  }
  if (
    receipt.writeAttempted &&
    !["verified", "function-outcome-unknown"].includes(receipt.status)
  ) {
    receipt = {
      ...receipt,
      status: "function-outcome-unknown",
      recovery:
        "Interrupted after a possible or partial upload. Stop and inspect attempted QA routes privately before a reviewed fix-forward; never blindly retry.",
    };
  }
  // Refusal categories are kebab-case `qa-…`; readiness codes are the fixed gate identifiers.
  const categories = receipt.issues.filter((issue) => issue.startsWith("qa-"));
  const readiness = receipt.issues.filter((issue) => !issue.startsWith("qa-"));
  return `## QA function closing record\n\n- Status: ${receipt.status}.\n` +
    `- Write attempted: ${receipt.writeAttempted}; completed routes: ${receipt.completed.length}.\n` +
    `- Baseline digest: ${receipt.baselineSha256 ?? "unavailable"}.\n` +
    `- Fixed issue codes: ${categories.join(", ") || "none"}.\n` +
    (readiness.length
      ? `- Readiness issues (${readiness.length}; fix these before an apply plan):\n` +
        readiness.map((code) => `  - \`${code}\`\n`).join("")
      : "") +
    `- Recovery: ${receipt.recovery}.\n`;
}
