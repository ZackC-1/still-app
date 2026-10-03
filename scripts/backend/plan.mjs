import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
    files.push(...await filesUnder(root, join(path, child)));
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
    paths.push(...await filesUnder(root, path));
  }
  const files = [];
  for (const path of paths.sort()) {
    files.push({
      path: relative(root, join(root, path)),
      sha256: hash(await readFile(join(root, path))),
    });
  }
  const migrations = files.filter((f) =>
    f.path.startsWith("supabase/migrations/")
  ).map((f) => {
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

if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
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
