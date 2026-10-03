import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

// Exact shared-runtime closure imported by the settings endpoint and its maintained barrels.
export const settingsRuntimeSources = Object.freeze([
  "packages/shared-types/src/index.ts",
  ...[
    "rules",
    "settings",
    "entitlement",
    "feature-registry",
    "settings-v2",
    "settings-operation",
  ].map((name) => `packages/shared-types/src/${name}.ts`),
  "packages/core/src/storage/settings-v2.ts",
  "packages/core/src/sync/field-order.ts",
  "packages/core/src/rules/canonical.ts",
]);

// Use Deno's actual graph, including transitive imports, rather than fixtures
// created from this manifest. The CLI's pinned static walker matches raw keys.
export function assertSettingsRuntimeClosure(
  graph,
  root,
  imports,
  mapPath,
  sources = settingsRuntimeSources,
) {
  const actual = graph.modules
    .filter((m) => m.local && relative(root, m.local).startsWith("packages/"))
    .map((m) => relative(root, m.local))
    .sort();
  if (canonical(actual) !== canonical([...sources].sort()))
    throw new Error("Settings runtime manifest differs from resolved graph");
  for (const module of graph.modules) {
    if (!module.local) continue;
    for (const dep of module.dependencies ?? []) {
      const resolved = dep.code?.specifier ?? dep.type?.specifier;
      if (!resolved?.startsWith("file:")) continue;
      const target = new URL(resolved).pathname;
      const mapped = imports[dep.specifier];
      const cliTarget = mapped
        ? resolve(dirname(mapPath), mapped)
        : resolve(dirname(module.local), dep.specifier);
      if (cliTarget !== target)
        throw new Error(`CLI raw import does not resolve: ${dep.specifier}`);
    }
  }
  return actual;
}

export const syntheticOperationIds = Object.freeze([
  "retain-security-boundary",
  "record-verification",
]);

export function validateSyntheticBaseline(baseline) {
  if (
    !baseline ||
    JSON.stringify(Object.keys(baseline).sort()) !==
      JSON.stringify([
        "completed",
        "generation",
        "kind",
        "runId",
        "securityBoundary",
        "target",
      ]) ||
    baseline.kind !== "synthetic-sql-fixture" ||
    baseline.target !== "synthetic-github-runner" ||
    !/^[1-9][0-9]*:[1-9][0-9]*$/.test(baseline.runId) ||
    baseline.securityBoundary !== true ||
    !Number.isInteger(baseline.generation) ||
    baseline.generation < 0 ||
    baseline.generation > syntheticOperationIds.length ||
    canonical(baseline.completed) !==
      canonical(syntheticOperationIds.slice(0, baseline.generation))
  ) {
    throw new Error("Missing, unverified or inconsistent synthetic baseline");
  }
}

async function filesUnder(root, path) {
  const full = join(root, path);
  const stat = await lstat(full);
  if (stat.isSymbolicLink()) throw new Error("Symlinked backend input");
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw new Error("Unsupported backend input");
  const children = (await readdir(full)).sort();
  const files = [];
  for (const child of children) {
    // Tool caches are never source or deployment inputs.
    if (["node_modules", ".temp", ".branches", "__pycache__"].includes(child)) {
      continue;
    }
    files.push(...(await filesUnder(root, join(path, child))));
  }
  return files;
}

export async function createPlan(root, { revision, target }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("Immutable Git revision required");
  }
  if (target !== "synthetic-github-runner") {
    throw new Error(
      "Production apply unavailable pending actual baseline and approval evidence",
    );
  }
  const paths = [];
  for (
    const path of [
      "supabase/migrations",
      "supabase/functions",
      "supabase/config.toml",
      "scripts/backend",
      "supabase/tests",
      ".github/workflows/supabase-security-rehearsal.yml",
      ".github/workflows/security-audit.yml",
    ]
  ) {
    paths.push(...(await filesUnder(root, path)));
  }
  // Older rehearsal callers retain their protocol. Once present, the apply source is bound too.
  const deploymentWorkflow = ".github/workflows/supabase-deploy.yml";
  try {
    paths.push(...(await filesUnder(root, deploymentWorkflow)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (paths.includes("supabase/functions/sync-settings/index.ts")) {
    for (const path of settingsRuntimeSources) {
      paths.push(...await filesUnder(root, path));
    }
    paths.push(
      ...await filesUnder(
        root,
        ".github/workflows/supabase-settings-rehearsal.yml",
      ),
    );
  }
  const files = [];
  for (const path of paths.sort()) {
    files.push({
      path: relative(root, join(root, path)),
      sha256: hash(await readFile(join(root, path))),
    });
  }
  const migrations = files
    .filter((f) => f.path.startsWith("supabase/migrations/"))
    .map((f) => {
      const match = /^supabase\/migrations\/([0-9]+)_[^/]+\.sql$/.exec(f.path);
      if (!match) throw new Error("Unexpected migration input");
      return { id: match[1], ...f };
    });
  if (new Set(migrations.map((m) => m.id)).size !== migrations.length) {
    throw new Error("Duplicate migration ID");
  }
  const manifest = {
    protocol: 1,
    kind: "rehearsal",
    revision,
    target,
    productionApplyAvailable: false,
    operations: [
      "clean migrations",
      "synthetic upgrade",
      "hardening candidate",
      "role and server assertions",
      "post-hardening injected-grant rejection",
      "destroy runtime",
    ],
    files,
    migrations,
  };
  return { ...manifest, digest: hash(JSON.stringify(manifest)) };
}

export async function verifyPlan(root, plan, expected) {
  const actual = await createPlan(root, expected);
  if (
    actual.digest !== expected.digest ||
    JSON.stringify(actual) !== JSON.stringify(plan)
  ) {
    throw new Error(
      "Plan, target, revision or source changed; new review required",
    );
  }
}

export async function createOperationPlan(
  root,
  { revision, target, baseline },
) {
  const artifact = await createPlan(root, { revision, target });
  validateSyntheticBaseline(baseline);
  if (baseline.generation === syntheticOperationIds.length) {
    throw new Error("No remaining reviewed operation");
  }
  const manifest = {
    protocol: 1,
    kind: "synthetic-exact-operation",
    sourceRevision: revision,
    target,
    productionApplyAvailable: false,
    artifactDigest: artifact.digest,
    expectedBaseline: structuredClone(baseline),
    expectedBaselineDigest: hash(canonical(baseline)),
    operations: syntheticOperationIds
      .slice(baseline.generation)
      .map((id) => ({ id })),
    recovery: "stop-and-review-forward-repair-preserving-security",
  };
  return { ...manifest, digest: hash(canonical(manifest)) };
}

export async function verifyOperationPlan(root, plan, expected) {
  const actual = await createOperationPlan(root, expected);
  if (
    actual.digest !== expected.digest ||
    canonical(actual) !== canonical(plan)
  ) {
    throw new Error(
      "Operation, artifact, target, revision or baseline changed; new review required",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [operation, revision, target, path, digest] = process.argv.slice(2);
  if (operation === "create") {
    const plan = await createPlan(process.cwd(), { revision, target });
    await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(`${plan.digest}\n`);
  } else if (operation === "verify") {
    await verifyPlan(process.cwd(), JSON.parse(await readFile(path, "utf8")), {
      revision,
      target,
      digest,
    });
  } else throw new Error("Use create or verify");
}
