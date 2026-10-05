// Protected exact-change deploy for the hosted Supabase database (CP-033, owner decision 9).
//
// One workflow run deploys ONE exact change: a commit on main plus the exact list of pending
// migration files. The plan job (no secrets) binds commit, file hashes, tooling and expected
// migration history into a digest and replays the change on a throwaway database inside the
// runner. The apply job (GitHub environment `supabase-production`, owner approval required)
// re-derives the same digest, refuses unexpected hosted history, applies only the listed
// migrations with the pinned Supabase CLI and then runs read-only verification queries.
//
// No rollback: a failure stops, reports what is known, and requires a reviewed fix-forward.
// Dependency-free on purpose (node built-ins only): the secret-bearing job installs nothing.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ENVIRONMENT_NAME = "supabase-production";
export const OWNER_REVIEWER_ID = 257643931; // GitHub user ZackC-1
export const CLI_VERSION = "2.119.0";
export const CLI_TARBALL_SHA256 =
  "bf1c3ae93be98533eb8a3105dbf4564bd0b2d9dc24690d8a920f980ef975c1b4";
export const MIGRATIONS_DIR = "supabase/migrations";
export const VERIFY_DIR = "scripts/backend/deploy/verify";
export const CONFIG_PATH = "supabase/config.toml";
export const TOOLING_PATHS = Object.freeze([
  ".github/workflows/supabase-production-deploy.yml",
  "scripts/backend/deploy/deploy.mjs",
  "scripts/backend/deploy/replay.sh",
  "scripts/backend/deploy/sql/catalog-facts.sql",
  "scripts/backend/deploy/sql/migration-history.sql",
]);
const HISTORY_SQL = "scripts/backend/deploy/sql/migration-history.sql";
const FACTS_SQL = "scripts/backend/deploy/sql/catalog-facts.sql";
const MIGRATION_FILE = /^([0-9]{4,14})_([a-z0-9_]+)\.sql$/;
const FUNCTION_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A deliberate, explained stop. `category` is a fixed code that is safe to print publicly. */
export class Refusal extends Error {
  constructor(category, message) {
    super(message ?? category);
    this.category = category;
  }
}

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── Inputs ─────────────────────────────────────────────────────────────────────────────────────

export function parseList(text, pattern, label) {
  const items = String(text ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of items) {
    if (!pattern.test(item))
      throw new Refusal(
        "input-invalid",
        `Invalid ${label}: use bare file or function names`,
      );
  }
  if (new Set(items).size !== items.length)
    throw new Refusal("input-invalid", `Duplicate ${label}`);
  return items;
}

export function parseInputs({ sha, migrations, functions }) {
  if (!/^[0-9a-f]{40}$/.test(String(sha ?? ""))) {
    throw new Refusal(
      "input-invalid",
      "Commit must be a full 40-character lowercase SHA",
    );
  }
  const migrationList = parseList(
    migrations,
    MIGRATION_FILE,
    "migration file name",
  );
  if (migrationList.length === 0)
    throw new Refusal("input-invalid", "List at least one migration file");
  const functionList = parseList(functions, FUNCTION_NAME, "function name");
  if (functionList.length > 0) {
    // Deployed function bytes cannot be read back and verified the way migration history can,
    // so function deploys stay separate owner-approved operations (gate G7).
    throw new Refusal(
      "functions-unsupported",
      "Edge Function deploys are not supported by this workflow; leave the function list empty",
    );
  }
  return { sha, migrations: migrationList, functions: functionList };
}

export function migrationParts(file) {
  const match = MIGRATION_FILE.exec(file);
  if (!match)
    throw new Refusal(
      "migration-name-invalid",
      "Unexpected migration file name in repository",
    );
  return { file, version: match[1], name: match[2] };
}

// ── Git (read-only) ────────────────────────────────────────────────────────────────────────────

export function makeGit(exec, cwd) {
  const git = async (args, { allowFail = false } = {}) => {
    const result = await exec("git", args, { cwd, binary: true });
    if (result.code !== 0 && !allowFail)
      throw new Refusal("git-failed", `git ${args[0]} failed`);
    return result;
  };
  return {
    async commit(ref) {
      const result = await git(
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        {
          allowFail: true,
        },
      );
      if (result.code !== 0)
        throw new Refusal(
          "commit-unknown",
          "Commit not found in this checkout",
        );
      return result.stdout.toString("utf8").trim();
    },
    async isAncestor(ancestor, descendant) {
      const result = await git(
        ["merge-base", "--is-ancestor", ancestor, descendant],
        { allowFail: true },
      );
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new Refusal("git-failed", "Ancestry check failed");
    },
    async files(commit, dir) {
      const result = await git(
        ["ls-tree", "-z", "--name-only", `${commit}:${dir}`],
        { allowFail: true },
      );
      if (result.code !== 0) return [];
      return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
    },
    async blob(commit, path) {
      const result = await git(["cat-file", "blob", `${commit}:${path}`], {
        allowFail: true,
      });
      return result.code === 0 ? result.stdout : null;
    },
  };
}

async function migrationsAt(git, commit) {
  const entries = (await git.files(commit, MIGRATIONS_DIR)).filter((name) =>
    name.endsWith(".sql"),
  );
  const parsed = entries
    .map(migrationParts)
    .sort((a, b) => compareVersions(a.version, b.version));
  if (new Set(parsed.map((m) => m.version)).size !== parsed.length) {
    throw new Refusal(
      "migration-version-duplicate",
      "Two migration files share a version",
    );
  }
  return parsed;
}

function compareVersions(a, b) {
  return a.length === b.length
    ? a < b
      ? -1
      : a > b
        ? 1
        : 0
    : a.length - b.length;
}

// ── Verification SQL contract ──────────────────────────────────────────────────────────────────

/** Defense in depth only; the runner also forces a read-only session. */
export function lintVerificationSql(text) {
  const stripped = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim();
  if (!/^(with|select)\b/i.test(stripped)) {
    throw new Refusal(
      "verification-sql-invalid",
      "Verification must be a single SELECT",
    );
  }
  const semicolons = stripped.match(/;/g)?.length ?? 0;
  if (semicolons !== 1 || !stripped.endsWith(";")) {
    throw new Refusal(
      "verification-sql-invalid",
      "Verification must be exactly one statement ending in ;",
    );
  }
  const forbidden =
    /\b(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|copy|call|do|set|reset|begin|start|commit|rollback|savepoint|vacuum|analyze|refresh|lock|notify|listen|prepare|execute|comment|reindex|cluster|discard|security|into|set_config|nextval|setval|dblink\w*|lo_\w+|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_notify|pg_advisory\w*)\b/i;
  const hit = forbidden.exec(stripped);
  if (hit)
    throw new Refusal(
      "verification-sql-invalid",
      `Verification uses a forbidden keyword: ${hit[1].toLowerCase()}`,
    );
  return true;
}

// ── Plan ───────────────────────────────────────────────────────────────────────────────────────

export async function createDeployPlan({
  git,
  sha,
  migrations,
  functions = "",
  mainRef = "HEAD",
}) {
  const inputs = parseInputs({ sha, migrations, functions });
  const mainCommit = await git.commit(mainRef);
  if ((await git.commit(inputs.sha)) !== inputs.sha)
    throw new Refusal("commit-unknown", "Commit not found");
  if (!(await git.isAncestor(inputs.sha, mainCommit))) {
    throw new Refusal(
      "not-on-main",
      "The commit is not on main; only merged, reviewed commits can be deployed",
    );
  }

  const atSha = await migrationsAt(git, inputs.sha);
  const listed = inputs.migrations
    .map(migrationParts)
    .sort((a, b) => compareVersions(a.version, b.version));
  const atShaFiles = new Set(atSha.map((m) => m.file));
  for (const m of listed) {
    if (!atShaFiles.has(m.file))
      throw new Refusal(
        "migration-missing",
        `${m.file} does not exist at that commit`,
      );
  }
  const tail = atSha.slice(atSha.length - listed.length);
  if (
    canonical(tail.map((m) => m.file)) !== canonical(listed.map((m) => m.file))
  ) {
    throw new Refusal(
      "not-pending-tail",
      "The listed migrations must be exactly the newest migrations at that commit (no gaps, nothing left out)",
    );
  }
  const prior = atSha.slice(0, atSha.length - listed.length);
  if (prior.length === 0)
    throw new Refusal(
      "no-prior-history",
      "A first-ever migration is out of scope",
    );

  // Every migration at the target must be byte-identical on main, and main must not hold a
  // different set of migrations up to the newest listed version.
  const highest = listed[listed.length - 1].version;
  const atMain = await migrationsAt(git, mainCommit);
  const mainUpTo = atMain
    .filter((m) => compareVersions(m.version, highest) <= 0)
    .map((m) => m.file);
  if (canonical(mainUpTo) !== canonical(atSha.map((m) => m.file))) {
    throw new Refusal(
      "main-history-diverges",
      "Main's migrations up to this change differ from the commit's",
    );
  }
  const hashed = [];
  for (const m of atSha) {
    const path = `${MIGRATIONS_DIR}/${m.file}`;
    const bytes = await git.blob(inputs.sha, path);
    const onMain = await git.blob(mainCommit, path);
    if (!bytes || !onMain || sha256(bytes) !== sha256(onMain)) {
      throw new Refusal(
        "migration-changed-on-main",
        `${m.file} differs between the commit and main`,
      );
    }
    hashed.push({ ...m, sha256: sha256(bytes) });
  }
  const byFile = new Map(hashed.map((m) => [m.file, m]));

  const planned = [];
  for (const m of listed) {
    const path = `${VERIFY_DIR}/${m.file}`;
    const bytes = await git.blob(inputs.sha, path);
    if (!bytes) {
      throw new Refusal(
        "verification-missing",
        `No read-only verification query for ${m.file} at that commit`,
      );
    }
    lintVerificationSql(bytes.toString("utf8"));
    planned.push({
      ...byFile.get(m.file),
      verification: { path, sha256: sha256(bytes) },
    });
  }
  const config = await git.blob(inputs.sha, CONFIG_PATH);
  if (!config)
    throw new Refusal(
      "config-missing",
      "supabase/config.toml missing at that commit",
    );

  const tooling = [];
  for (const path of TOOLING_PATHS) {
    const bytes = await git.blob(mainCommit, path);
    if (!bytes) throw new Refusal("tooling-missing", `${path} missing on main`);
    tooling.push({ path, sha256: sha256(bytes) });
  }

  const history = (list) =>
    list.map(({ version, name }) => ({ version, name }));
  const manifest = {
    protocol: 1,
    kind: "supabase-exact-deploy",
    environment: ENVIRONMENT_NAME,
    revision: inputs.sha,
    workflowRevision: mainCommit,
    cli: { version: CLI_VERSION, tarballSha256: CLI_TARBALL_SHA256 },
    config: { path: CONFIG_PATH, sha256: sha256(config) },
    migrations: planned,
    functions: [],
    priorMigrations: hashed.filter(
      (m) => !planned.some((p) => p.file === m.file),
    ),
    expectedHistoryBefore: history(prior),
    expectedHistoryAfter: history(atSha),
    newerMigrationsOnMain: atMain.length - mainUpTo.length,
    tooling,
    recovery:
      "stop-and-fix-forward; never restore removed grants; no automatic rollback",
  };
  return { ...manifest, digest: sha256(canonical(manifest)) };
}

export function assertSamePlan(plan, expectedDigest) {
  if (!/^[0-9a-f]{64}$/.test(String(expectedDigest ?? ""))) {
    throw new Refusal(
      "plan-digest-missing",
      "No plan digest from the plan job",
    );
  }
  const { digest, ...manifest } = plan;
  if (sha256(canonical(manifest)) !== digest || digest !== expectedDigest) {
    throw new Refusal(
      "plan-differs",
      "The re-derived plan differs from the plan shown for approval",
    );
  }
}

// ── Exact deploy directory ─────────────────────────────────────────────────────────────────────

/** Extract supabase/ at the exact commit; `prior` stage omits the listed migrations. */
export async function prepareWorkdir({ exec, cwd, plan, dir, stage }) {
  if (!["prior", "full"].includes(stage))
    throw new Refusal("input-invalid", "Unknown workdir stage");
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
        VERIFY_DIR,
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
  if (stage === "prior") {
    for (const m of plan.migrations)
      await rm(join(dir, MIGRATIONS_DIR, m.file), { force: true });
  }
  await verifyWorkdir({ plan, dir, stage });
}

export async function addListedMigrations({ exec, cwd, plan, dir }) {
  for (const m of plan.migrations) {
    const result = await exec(
      "git",
      ["cat-file", "blob", `${plan.revision}:${MIGRATIONS_DIR}/${m.file}`],
      {
        cwd,
        binary: true,
      },
    );
    if (result.code !== 0)
      throw new Refusal("workdir-failed", "Could not read a listed migration");
    await writeFile(join(dir, MIGRATIONS_DIR, m.file), result.stdout);
  }
  await verifyWorkdir({ plan, dir, stage: "full" });
}

export async function verifyWorkdir({ plan, dir, stage }) {
  const expected = [
    ...plan.priorMigrations,
    ...(stage === "full" ? plan.migrations : []),
  ];
  const present = (await readdir(join(dir, MIGRATIONS_DIR)))
    .filter((f) => !f.startsWith("."))
    .sort();
  if (canonical(present) !== canonical(expected.map((m) => m.file).sort())) {
    throw new Refusal(
      "workdir-differs",
      "Deploy directory migrations differ from the plan",
    );
  }
  for (const m of expected) {
    if (
      sha256(await readFile(join(dir, MIGRATIONS_DIR, m.file))) !== m.sha256
    ) {
      throw new Refusal(
        "hash-mismatch",
        `${m.file} hash differs from the plan`,
      );
    }
  }
  if (sha256(await readFile(join(dir, CONFIG_PATH))) !== plan.config.sha256) {
    throw new Refusal(
      "hash-mismatch",
      "config.toml hash differs from the plan",
    );
  }
  for (const m of plan.migrations) {
    if (
      sha256(await readFile(join(dir, m.verification.path))) !==
      m.verification.sha256
    ) {
      throw new Refusal(
        "hash-mismatch",
        `${m.verification.path} hash differs from the plan`,
      );
    }
  }
}

// ── Database connection (never printed) ────────────────────────────────────────────────────────

export function parseDbUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new Refusal(
      "db-url-invalid",
      "Database URL secret is missing or malformed",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    !url.hostname ||
    url.hash
  ) {
    throw new Refusal(
      "db-url-invalid",
      "Database URL secret is missing or malformed",
    );
  }
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      throw new Refusal(
        "db-url-invalid",
        "Database URL secret is missing or malformed",
      );
    }
  };
  return {
    raw: String(raw),
    user: decode(url.username),
    password: decode(url.password),
    rawUser: url.username,
    rawPassword: url.password,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || "5432",
    database: decode(url.pathname.replace(/^\//, "")) || "postgres",
    sslmode: url.searchParams.get("sslmode"),
  };
}

export const isLoopback = (conn) =>
  ["127.0.0.1", "localhost", "::1"].includes(conn.host);

export function maskValues(conn) {
  const values = new Set([
    conn.raw,
    conn.password,
    conn.rawPassword,
    conn.user,
    conn.rawUser,
    conn.host,
  ]);
  for (const part of conn.user.split(/[.@]/)) values.add(part);
  return [...values]
    .filter((v) => typeof v === "string" && v.length >= 4 && v !== "postgres")
    .sort((a, b) => b.length - a.length);
}

export function redact(text, conn) {
  let out = String(text ?? "").replace(
    /postgres(?:ql)?:\/\/[^\s'"<>]+/gi,
    "[redacted-url]",
  );
  if (conn)
    for (const value of maskValues(conn)) out = out.split(value).join("***");
  return out;
}

function sslmodeFor(conn, target) {
  if (target === "production") {
    if (
      conn.sslmode &&
      !["require", "verify-ca", "verify-full"].includes(conn.sslmode)
    ) {
      throw new Refusal(
        "db-url-insecure",
        "Production database URL must not weaken TLS",
      );
    }
    return conn.sslmode ?? "require";
  }
  return "disable";
}

export function pgEnv(conn, target) {
  return {
    PGHOST: conn.host,
    PGPORT: conn.port,
    PGUSER: conn.user,
    PGPASSWORD: conn.password,
    PGDATABASE: conn.database,
    PGSSLMODE: sslmodeFor(conn, target),
    PGCONNECT_TIMEOUT: "20",
    PGAPPNAME: "still-exact-deploy",
  };
}

export function cliDbUrl(conn, target) {
  const host = conn.host.includes(":") ? `[${conn.host}]` : conn.host;
  return `postgresql://${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@${host}:${conn.port}/${encodeURIComponent(conn.database)}?sslmode=${sslmodeFor(conn, target)}`;
}

/** Runs one bound read-only query file; returns the last output line. */
export async function runReadOnlySql({ exec, conn, target, file, cwd }) {
  const result = await exec(
    "psql",
    [
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "set session characteristics as transaction read only",
      "-c",
      "set statement_timeout = '60s'",
      "-f",
      file,
    ],
    { cwd, env: pgEnv(conn, target) },
  );
  if (result.code !== 0) {
    throw new Refusal(
      "sql-failed",
      `Read-only query failed: ${redact(result.stderr, conn).slice(0, 2000)}`,
    );
  }
  const lines = result.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

export function parseJsonArray(line, category) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Refusal(category, "Query output was not the expected JSON array");
  }
  if (!Array.isArray(value))
    throw new Refusal(category, "Query output was not the expected JSON array");
  return value;
}

export function parseHistory(line) {
  const value = parseJsonArray(line, "history-unreadable");
  for (const entry of value) {
    if (
      !entry ||
      typeof entry.version !== "string" ||
      typeof entry.name !== "string" ||
      Object.keys(entry).length !== 2
    ) {
      throw new Refusal(
        "history-unreadable",
        "Migration history has an unexpected shape",
      );
    }
  }
  return value;
}

/** Compares migration history without ever returning its raw contents. */
export function compareHistory(observed, expected, { alreadyApplied } = {}) {
  const key = (e) => `${e.version}\u0000${e.name}`;
  const expectedKeys = new Set(expected.map(key));
  const observedKeys = new Set(observed.map(key));
  const unexpected = observed.filter((e) => !expectedKeys.has(key(e))).length;
  const missing = expected.filter((e) => !observedKeys.has(key(e))).length;
  const ok = canonical(observed) === canonical(expected);
  let category = "matches";
  if (!ok) {
    if (alreadyApplied && canonical(observed) === canonical(alreadyApplied))
      category = "already-applied";
    else if (unexpected > 0) category = "unexpected-entries";
    else if (missing > 0) category = "missing-entries";
    else category = "order-differs";
  }
  return {
    ok,
    category,
    observedCount: observed.length,
    expectedCount: expected.length,
    unexpected,
    missing,
  };
}

/** Extracts migration file names from `supabase db push --dry-run` output (text or JSON). */
export function parseDryRun(text) {
  const found = new Set();
  const source = String(text ?? "");
  for (const match of source.matchAll(/\b([0-9]{4,14}_[a-z0-9_]+\.sql)\b/g))
    found.add(match[1]);
  for (const candidate of source.match(/\{[\s\S]*\}/g) ?? []) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    for (const entry of Array.isArray(value?.migrations)
      ? value.migrations
      : []) {
      if (typeof entry === "string") {
        const base = entry.split("/").at(-1);
        found.add(base.endsWith(".sql") ? base : `${base}.sql`);
      } else if (
        entry &&
        typeof entry.version === "string" &&
        typeof entry.name === "string"
      ) {
        found.add(`${entry.version}_${entry.name}.sql`);
      }
    }
  }
  return [...found].sort();
}

// ── Orchestration ──────────────────────────────────────────────────────────────────────────────

async function supabasePush({ exec, conn, target, dir, dryRun }) {
  const args = [
    "db",
    "push",
    "--db-url",
    cliDbUrl(conn, target),
    "--workdir",
    dir,
    "--yes",
  ];
  if (dryRun) args.push("--dry-run");
  const result = await exec("supabase", args, {
    cwd: dir,
    env: { DO_NOT_TRACK: "1", SUPABASE_TELEMETRY_DISABLED: "1" },
  });
  return {
    code: result.code,
    output: redact(`${result.stdout}\n${result.stderr}`, conn).slice(0, 20000),
  };
}

/**
 * Applies exactly the planned migrations to `conn`. Never throws: always returns a receipt.
 * status: verified | refused (nothing written) | stopped (write attempted, needs review) |
 * verification-failed (write done, end state wrong).
 */
export async function runDeploy({
  exec,
  plan,
  dir,
  conn,
  target,
  cwd,
  log = () => {},
}) {
  const receipt = {
    status: "refused",
    target,
    digest: plan.digest,
    revision: plan.revision,
    migrations: plan.migrations.map((m) => m.file),
    writeAttempted: false,
    steps: [],
    issues: [],
    recovery: "none needed: nothing was written",
  };
  const step = (name, outcome, detail) => {
    receipt.steps.push(detail ? { name, outcome, detail } : { name, outcome });
    log(
      `${outcome === "ok" ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`,
    );
  };
  const history = async () =>
    parseHistory(
      await runReadOnlySql({
        exec,
        conn,
        target,
        cwd,
        file: join(cwd, HISTORY_SQL),
      }),
    );
  try {
    await verifyWorkdir({ plan, dir, stage: "full" });
    step("deploy directory matches plan hashes", "ok");

    const before = compareHistory(await history(), plan.expectedHistoryBefore, {
      alreadyApplied: plan.expectedHistoryAfter,
    });
    if (!before.ok) {
      step(
        "migration history before",
        "refused",
        `${before.category} (observed ${before.observedCount}, expected ${before.expectedCount}, unexpected ${before.unexpected}, missing ${before.missing})`,
      );
      throw new Refusal(`history-${before.category}`);
    }
    step(
      "migration history before",
      "ok",
      `${before.observedCount} entries, as expected`,
    );

    const dry = await supabasePush({ exec, conn, target, dir, dryRun: true });
    const pending = dry.code === 0 ? parseDryRun(dry.output) : null;
    const wanted = plan.migrations.map((m) => m.file).sort();
    if (!pending || canonical(pending) !== canonical(wanted)) {
      step(
        "dry run lists exactly the planned migrations",
        "refused",
        pending ? `dry run listed ${pending.length}` : "dry run failed",
      );
      if (!pending) log(dry.output);
      throw new Refusal("dry-run-differs");
    }
    step(
      "dry run lists exactly the planned migrations",
      "ok",
      wanted.join(", "),
    );

    const recheck = compareHistory(await history(), plan.expectedHistoryBefore);
    if (!recheck.ok) {
      step(
        "migration history unchanged before apply",
        "refused",
        recheck.category,
      );
      throw new Refusal(`history-${recheck.category}`);
    }
    step("migration history unchanged before apply", "ok");
  } catch (error) {
    receipt.issues.push(
      error instanceof Refusal ? error.category : "unexpected-error",
    );
    if (error instanceof Refusal && error.message !== error.category)
      log(error.message);
    return receipt;
  }

  receipt.writeAttempted = true;
  receipt.recovery =
    "fix-forward only: keep payments off, do not restore removed grants, inspect the recorded state, " +
    "write a new forward migration, and approve it as a new deploy";
  const pushed = await supabasePush({ exec, conn, target, dir, dryRun: false });
  log(pushed.output);
  if (pushed.code !== 0) {
    receipt.status = "stopped";
    step("apply", "failed", "supabase db push exited with an error");
    receipt.issues.push("apply-failed");
    try {
      const observed = await history();
      const recorded = new Set(
        observed.map((e) => `${e.version}_${e.name}.sql`),
      );
      const applied = plan.migrations.filter((m) =>
        recorded.has(m.file),
      ).length;
      receipt.appliedListed = `${applied} of ${plan.migrations.length}`;
      step(
        "history after failure",
        "ok",
        `${applied} of ${plan.migrations.length} planned migrations recorded`,
      );
    } catch {
      receipt.appliedListed = "unknown";
      step(
        "history after failure",
        "failed",
        "state unknown; inspect privately",
      );
    }
    return receipt;
  }
  step("apply", "ok");

  receipt.status = "verification-failed";
  try {
    const after = compareHistory(await history(), plan.expectedHistoryAfter);
    if (!after.ok) {
      step("migration history after", "failed", after.category);
      receipt.issues.push(`history-after-${after.category}`);
    } else
      step(
        "migration history after",
        "ok",
        `${after.observedCount} entries, as expected`,
      );
  } catch (error) {
    step("migration history after", "failed", "unreadable");
    receipt.issues.push(
      error instanceof Refusal ? error.category : "unexpected-error",
    );
  }
  for (const m of plan.migrations) {
    try {
      const file = join(dir, m.verification.path);
      if (sha256(await readFile(file)) !== m.verification.sha256)
        throw new Refusal("verification-hash-mismatch");
      const issues = parseJsonArray(
        await runReadOnlySql({ exec, conn, target, cwd, file }),
        "verification-output-invalid",
      );
      if (issues.length > 0 || issues.some((i) => typeof i !== "string")) {
        step(
          `verify ${m.file}`,
          "failed",
          issues
            .map((i) => String(i))
            .join(", ")
            .slice(0, 4000),
        );
        receipt.issues.push(`verification-issues:${m.file}`);
      } else step(`verify ${m.file}`, "ok", "no issues");
    } catch (error) {
      step(
        `verify ${m.file}`,
        "failed",
        error instanceof Refusal ? error.category : "unexpected-error",
      );
      receipt.issues.push(`verification-error:${m.file}`);
    }
  }
  if (receipt.issues.length === 0) {
    receipt.status = "verified";
    receipt.recovery = "none needed";
  }
  return receipt;
}

/** Plan-job rehearsal: the same runDeploy against a throwaway database, plus a before/after diff. */
export async function runReplay({
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
  const facts = async () =>
    parseJsonArray(
      await runReadOnlySql({
        exec,
        conn,
        target: "local-replay",
        cwd,
        file: join(cwd, FACTS_SQL),
      }),
      "facts-unreadable",
    );
  const before = await facts();
  // Negative control: verification must NOT pass before the change, or it proves nothing.
  const vacuous = [];
  for (const m of plan.migrations) {
    // An error or any reported issue both count as "not passing" here.
    const passes = await runReadOnlySql({
      exec,
      conn,
      target: "local-replay",
      cwd,
      file: join(dir, m.verification.path),
    })
      .then(
        (out) =>
          canonical(parseJsonArray(out, "verification-output-invalid")) ===
          "[]",
      )
      .catch(() => false);
    if (passes) vacuous.push(m.file);
  }
  if (vacuous.length) {
    throw new Refusal(
      "verification-vacuous",
      `Verification already passes before the change: ${vacuous.join(", ")}`,
    );
  }
  await addListedMigrations({ exec, cwd, plan, dir });
  const receipt = await runDeploy({
    exec,
    plan,
    dir,
    conn,
    target: "local-replay",
    cwd,
    log,
  });
  const after = receipt.status === "verified" ? await facts() : null;
  return { receipt, diff: after ? diffFacts(before, after) : null };
}

export function diffFacts(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    removed: before.filter((f) => !a.has(f)).sort(),
    added: after.filter((f) => !b.has(f)).sort(),
  };
}

// ── GitHub environment protection (read-only REST) ─────────────────────────────────────────────

export function checkProtection({
  environment,
  branches,
  approvals,
  ownerId = OWNER_REVIEWER_ID,
  name = ENVIRONMENT_NAME,
}) {
  const issues = [];
  const warnings = [];
  if (
    !environment ||
    environment.name !== name ||
    !Number.isSafeInteger(environment.id)
  ) {
    return { ok: false, issues: ["environment-missing"], warnings };
  }
  const rules = Array.isArray(environment.protection_rules)
    ? environment.protection_rules
    : [];
  const reviewers = rules.filter((r) => r.type === "required_reviewers");
  if (
    reviewers.length !== 1 ||
    reviewers[0].reviewers?.length !== 1 ||
    reviewers[0].reviewers[0].type !== "User" ||
    reviewers[0].reviewers[0].reviewer?.id !== ownerId
  ) {
    issues.push("required-reviewer-not-exactly-owner");
  } else if (reviewers[0].prevent_self_review === true) {
    warnings.push(
      "prevent-self-review-on: the owner cannot approve a run they started",
    );
  }
  if (environment.can_admins_bypass !== false)
    issues.push("admin-bypass-not-disabled");
  const policy = environment.deployment_branch_policy;
  const allowed = branches?.branch_policies;
  if (
    policy?.custom_branch_policies !== true ||
    policy?.protected_branches !== false ||
    branches?.total_count !== 1 ||
    !Array.isArray(allowed) ||
    allowed.length !== 1 ||
    allowed[0].name !== "main" ||
    (allowed[0].type ?? "branch") !== "branch"
  ) {
    issues.push("deployment-branches-not-main-only");
  }
  if (approvals !== undefined) {
    const relevant = Array.isArray(approvals)
      ? approvals.filter((a) =>
          a.environments?.some((env) => env.id === environment.id),
        )
      : [];
    // A re-run attempt adds one approval per attempt; every one must be the owner's approval.
    if (
      relevant.length < 1 ||
      relevant.some((a) => a.state !== "approved" || a.user?.id !== ownerId)
    ) {
      issues.push("owner-approval-not-observed");
    }
  }
  return { ok: issues.length === 0, issues, warnings };
}

export async function readProtection({
  fetchImpl = fetch,
  repository,
  token,
  runId,
  includeApprovals,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository))) {
    throw new Refusal("input-invalid", "Bad repository name");
  }
  const base = `https://api.github.com/repos/${repository}`;
  const get = async (path) => {
    const response = await fetchImpl(`${base}${path}`, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Refusal(
        "github-unavailable",
        "GitHub settings could not be read",
      );
    return response.json();
  };
  const env = encodeURIComponent(ENVIRONMENT_NAME);
  const environment = await get(`/environments/${env}`);
  if (!environment) return checkProtection({ environment: null });
  const branches = await get(
    `/environments/${env}/deployment-branch-policies?per_page=100`,
  );
  let approvals;
  if (includeApprovals) {
    if (!Number.isSafeInteger(Number(runId)) || Number(runId) < 1)
      throw new Refusal("input-invalid", "Bad run id");
    approvals = (await get(`/actions/runs/${Number(runId)}/approvals`)) ?? [];
  }
  return checkProtection({ environment, branches, approvals });
}

// ── Rendering (public, privacy-safe) ───────────────────────────────────────────────────────────

export function renderPlan(plan) {
  const lines = [
    "## Supabase production deploy plan",
    "",
    `- Commit: \`${plan.revision}\` (on main; workflow from \`${plan.workflowRevision}\`)`,
    `- Plan digest: \`${plan.digest}\``,
    `- Approval environment: \`${plan.environment}\` (owner approval required before any secret is available)`,
    `- Edge Functions: none`,
    `- Supabase CLI ${plan.cli.version}, download SHA-256 \`${plan.cli.tarballSha256}\``,
    `- Hosted migration history must be exactly ${plan.expectedHistoryBefore.length} entries ending at \`${plan.expectedHistoryBefore.at(-1).version}\`; after the deploy, exactly ${plan.expectedHistoryAfter.length}.`,
    plan.newerMigrationsOnMain > 0
      ? `- Note: main has ${plan.newerMigrationsOnMain} newer migration(s) that this deploy does NOT include.`
      : "- Main has no newer migrations.",
    "",
    "| Migration to apply | SHA-256 | Read-only verification | SHA-256 |",
    "|---|---|---|---|",
    ...plan.migrations.map(
      (m) =>
        `| \`${m.file}\` | \`${m.sha256}\` | \`${m.verification.path}\` | \`${m.verification.sha256}\` |`,
    ),
    "",
    "**If anything fails:** nothing is rolled back automatically. The job stops, reports what it saw, and",
    "the fix is a new reviewed forward migration approved as a new deploy. Removed grants are never restored.",
    "",
  ];
  return lines.join("\n");
}

export function renderReplay({ receipt, diff, sql }) {
  const lines = [
    "## Rehearsal on a throwaway database (no production access)",
    "",
  ];
  for (const s of receipt.steps)
    lines.push(
      `- ${s.outcome === "ok" ? "✅" : "❌"} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`,
    );
  lines.push("");
  if (diff) {
    const cap = (list) =>
      list.length > 400
        ? [...list.slice(0, 400), `… ${list.length - 400} more`]
        : list;
    lines.push(
      `### What changes (${diff.removed.length} removed, ${diff.added.length} added)`,
      "",
      "```diff",
    );
    for (const f of cap(diff.removed)) lines.push(`- ${f}`);
    for (const f of cap(diff.added)) lines.push(`+ ${f}`);
    lines.push("```", "");
  }
  for (const { file, text } of sql) {
    lines.push(
      `<details><summary>Exact SQL in <code>${file}</code></summary>`,
      "",
      "```sql",
      text.replace(/```/g, "``​`"),
      "```",
      "</details>",
      "",
    );
  }
  return lines.join("\n");
}

export function renderReceipt(receipt) {
  const icon = receipt.status === "verified" ? "✅" : "❌";
  const lines = [
    `## ${icon} Production deploy: ${receipt.status}`,
    "",
    `- Commit \`${receipt.revision}\`, plan digest \`${receipt.digest}\``,
    `- Migrations: ${receipt.migrations.map((m) => `\`${m}\``).join(", ")}`,
    `- Write attempted: ${receipt.writeAttempted ? "yes" : "no"}`,
    ...(receipt.appliedListed
      ? [
          `- Planned migrations recorded after the failure: ${receipt.appliedListed}`,
        ]
      : []),
    ...(receipt.issues.length
      ? [`- Issues: ${receipt.issues.join(", ")}`]
      : []),
    `- Recovery: ${receipt.recovery}`,
    "",
    ...receipt.steps.map(
      (s) =>
        `- ${s.outcome === "ok" ? "✅" : "❌"} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`,
    ),
    "",
  ];
  return lines.join("\n");
}

// ── Process plumbing ───────────────────────────────────────────────────────────────────────────

/** Spawns with a minimal environment: secrets reach a child only when passed explicitly. */
export function defaultExec(cmd, args, { cwd, env = {}, binary = false } = {}) {
  return new Promise((resolve, reject) => {
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
    child.on("error", () =>
      reject(new Refusal("tool-unavailable", `${cmd} is not available`)),
    );
    child.on("close", (code) => {
      const stdout = Buffer.concat(out);
      resolve({
        code: code ?? 1,
        stdout: binary ? stdout : stdout.toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

function requireRunner(env) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.platform !== "linux"
  ) {
    throw new Refusal(
      "runner-required",
      "Database steps run only on an ephemeral GitHub-hosted Linux runner",
    );
  }
}

function requireProductionContext(env) {
  requireRunner(env);
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Refusal(
      "context-invalid",
      "Production deploys run only from a manual dispatch on main",
    );
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function writeSummary(text, env) {
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

export async function main(
  argv,
  env = process.env,
  { exec = defaultExec, cwd = process.cwd(), out = process.stdout } = {},
) {
  const [command, ...args] = argv;
  const say = (text) => out.write(`${text}\n`);
  const readPlan = async () =>
    JSON.parse(await readFile(option(args, "--plan"), "utf8"));
  if (command === "plan") {
    const plan = await createDeployPlan({
      git: makeGit(exec, cwd),
      sha: env.DEPLOY_SHA,
      migrations: env.DEPLOY_MIGRATIONS,
      functions: env.DEPLOY_FUNCTIONS,
      mainRef: option(args, "--main-ref") ?? "HEAD",
    });
    const expect = option(args, "--expect-digest");
    if (expect !== undefined) assertSamePlan(plan, expect);
    if (option(args, "--out"))
      await writeFile(
        option(args, "--out"),
        `${JSON.stringify(plan, null, 2)}\n`,
      );
    if (args.includes("--summary")) await writeSummary(renderPlan(plan), env);
    if (env.GITHUB_OUTPUT)
      await appendFile(env.GITHUB_OUTPUT, `plan-digest=${plan.digest}\n`);
    say(args.includes("--print") ? renderPlan(plan) : plan.digest);
    return 0;
  }
  if (command === "protection") {
    const phase = option(args, "--phase");
    const result = await readProtection({
      repository: env.GITHUB_REPOSITORY,
      token: env.GH_TOKEN,
      runId: env.GITHUB_RUN_ID,
      includeApprovals: phase === "apply",
    });
    const text = [
      `## GitHub protection for \`${ENVIRONMENT_NAME}\`: ${result.ok ? "verified" : "NOT verified"}`,
      ...result.issues.map((i) => `- ❌ ${i}`),
      ...result.warnings.map((w) => `- ⚠️ ${w}`),
      "",
    ].join("\n");
    await writeSummary(text, env);
    say(text);
    if (env.GITHUB_OUTPUT)
      await appendFile(env.GITHUB_OUTPUT, `environment-ready=${result.ok}\n`);
    if (!result.ok && args.includes("--require")) return 1;
    return 0;
  }
  if (command === "workdir") {
    const plan = await readPlan();
    await prepareWorkdir({
      exec,
      cwd,
      plan,
      dir: option(args, "--dir"),
      stage: option(args, "--stage"),
    });
    say(`deploy directory ready (${option(args, "--stage")})`);
    return 0;
  }
  if (command === "apply") {
    requireProductionContext(env);
    const plan = await readPlan();
    assertSamePlan(plan, env.EXPECTED_PLAN_DIGEST);
    const conn = parseDbUrl(env.SUPABASE_DB_URL);
    if (isLoopback(conn))
      throw new Refusal(
        "target-invalid",
        "Production URL points at this runner",
      );
    for (const value of maskValues(conn)) say(`::add-mask::${value}`);
    const receipt = await runDeploy({
      exec,
      plan,
      dir: option(args, "--dir"),
      conn,
      target: "production",
      cwd,
      log: (l) => say(redact(l, conn)),
    });
    await writeSummary(renderReceipt(receipt), env);
    say(JSON.stringify(receipt));
    if (receipt.status !== "verified") {
      say(
        `::error title=Production deploy ${receipt.status}::${receipt.issues.join(", ")}. ${receipt.recovery}`,
      );
      return 1;
    }
    return 0;
  }
  if (command === "replay") {
    requireRunner(env);
    const plan = await readPlan();
    const conn = parseDbUrl(env.SUPABASE_DB_URL);
    const { receipt, diff } = await runReplay({
      exec,
      plan,
      dir: option(args, "--dir"),
      conn,
      cwd,
      log: say,
    });
    const sql = [];
    for (const m of plan.migrations) {
      sql.push({
        file: m.file,
        text: await readFile(
          join(option(args, "--dir"), MIGRATIONS_DIR, m.file),
          "utf8",
        ),
      });
    }
    await writeSummary(renderReplay({ receipt, diff, sql }), env);
    say(JSON.stringify({ receipt, diff }));
    return receipt.status === "verified" ? 0 : 1;
  }
  throw new Refusal(
    "input-invalid",
    "Use plan, protection, workdir, apply or replay",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // Only fixed categories and our own messages are printed; never driver or provider text.
    const category =
      error instanceof Refusal ? error.category : "unexpected-error";
    const message =
      error instanceof Refusal
        ? error.message
        : "Unexpected failure; no further detail is printed";
    process.stderr.write(`Refused (${category}): ${message}\n`);
    if (process.env.GITHUB_ACTIONS === "true")
      process.stdout.write(
        `::error title=Deploy refused::${category}: ${message}\n`,
      );
    process.exitCode = 1;
  }
}
