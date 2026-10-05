#!/usr/bin/env node
// Reproducible release packages and their hashes. Local only: this never contacts a store.
//
//   node scripts/release/package.mjs --out <dir> [--build] [--env VITE_X=value]... [--allow-dirty]
//
// Writes into <dir>:
//   still-chrome-<extension version>.zip       Chrome Web Store package
//   still-firefox-<extension version>.zip      Firefox (AMO) package
//   still-source-<extension version>.zip       the complete source AMO requires, with build instructions
//   SHA256SUMS.json / SHA256SUMS.txt           a hash for every file above
//
// --build   build the Chrome and Firefox bundles first (otherwise the existing dist/ folders are zipped)
// --env     a public build value (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_POSTHOG_KEY,
//           VITE_POSTHOG_HOST). Every other VITE_* variable in your shell is removed first, and the
//           values given are recorded in the AMO build instructions so a reviewer can rebuild the
//           same bytes. Never pass a secret.
//
// The packages must come from a committed tree: the source bundle is read from HEAD, so a dirty
// tracked file would make the package and its source disagree. --allow-dirty overrides that for tests.
//
// Reproducibility: archives have sorted entries, fixed timestamps, fixed permissions and no machine
// paths (see zip.mjs). Building twice from the same commit in the same directory with the same
// toolchain gives byte-identical zips. Svelte's scoped-CSS hash is made path-independent in
// packages/ext-chromium/wxt.config.ts, so the Chrome and Firefox bundles also rebuild identically
// in a reviewer's own directory.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readVersions, findMismatches, ROOT } from "./version.mjs";
import { createZip } from "./zip.mjs";

export const PUBLIC_ENV_KEYS = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_POSTHOG_KEY", "VITE_POSTHOG_HOST"];

export const WEB_TARGETS = {
  chrome: { script: "build", dist: "packages/ext-chromium/dist/chrome-mv3" },
  firefox: { script: "build:firefox", dist: "packages/ext-chromium/dist/firefox-mv3" },
};

// What a reviewer needs to rebuild the web packages. Everything else (Apple project, backend,
// documentation, tests) is not an input to the Chrome or Firefox bundle.
const SOURCE_ROOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "version.json", "LICENSE", "README.md", ".editorconfig", ".prettierrc.json", ".env.example"];
const SOURCE_PREFIXES = ["packages/", "scripts/release/"];
const NEVER_IN_SOURCE = /(^|\/)\.env($|\.(?!example$))/;

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Every file under `dir` as zip entries with forward-slash names relative to `dir`. */
export function treeEntries(dir) {
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries.push({ name: relative(dir, path).split("\\").join("/"), data: readFileSync(path) });
    }
  };
  walk(dir);
  return entries;
}

function git(args, root, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 1 << 28 });
}

/** The tracked files that make up the source bundle, read from HEAD. */
export function sourceEntries(root = ROOT, { allowDirty = false } = {}) {
  if (!allowDirty && git(["status", "--porcelain", "--untracked-files=no"], root).trim() !== "")
    throw new Error("tracked files have uncommitted changes; commit first (or pass --allow-dirty for a throwaway package)");
  const listing = git(["ls-tree", "-r", "-z", "HEAD"], root).split("\0").filter(Boolean);
  const entries = [];
  for (const row of listing) {
    const [meta, path] = row.split("\t");
    const [, type, sha] = meta.split(" ");
    if (type !== "blob") continue;
    if (NEVER_IN_SOURCE.test(path)) continue;
    if (!SOURCE_ROOT_FILES.includes(path) && !SOURCE_PREFIXES.some((p) => path.startsWith(p))) continue;
    entries.push({ name: path, data: git(["cat-file", "blob", sha], root, "buffer") });
  }
  return entries;
}

export function amoInstructions(versions, rootPackage, env) {
  const node = rootPackage.engines?.node ?? "see package.json";
  const envLines = PUBLIC_ENV_KEYS.map((key) => `${key}=${key in env ? env[key] : ""}`).join("\n");
  return `# Rebuilding Still for Firefox (version ${versions.extension})

This archive is the complete source of the submitted add-on. Chrome and Firefox are built from the same
package, packages/ext-chromium. Nothing is minified by a private tool and no file is generated from
anything outside this archive.

## Toolchain

- Node.js: ${node}
- pnpm: ${rootPackage.packageManager}  (\`corepack enable\` then \`corepack prepare ${rootPackage.packageManager} --activate\`)
- Dependencies are pinned by pnpm-lock.yaml; install with \`--frozen-lockfile\`.

## Build

1. Extract this archive into a clean directory.
2. \`pnpm install --frozen-lockfile\`
3. Put exactly these public build values in the environment. They are the values the submitted add-on was
   built with. They are public (a project URL, a publishable client key and an analytics key that ships in every
   copy of the add-on), not secrets. An empty value means it was unset.

\`\`\`
${envLines}
\`\`\`

   Remove every other VITE_* variable and any .env file from the environment before building.
4. \`pnpm --filter @still/ext-chromium build:firefox\`
5. The add-on is the folder packages/ext-chromium/dist/firefox-mv3. Compare it file by file with the submitted
   zip: the contents are identical. (The reproducible zip tool is scripts/release/package.mjs; it fixes
   timestamps and ordering, but zip timestamps are not part of the add-on payload.)

The manifest version is ${versions.extension}, taken from version.json through packages/ext-chromium/package.json.
`;
}

function cleanEnv(extra) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITE_")));
  return { ...base, ...extra };
}

function build(root, env) {
  for (const name of readdirSync(join(root, "packages/ext-chromium")))
    if (name.startsWith(".env") && name !== ".env.example") throw new Error(`packages/ext-chromium/${name} exists; move it aside so the build uses only the values given`);
  for (const { script } of Object.values(WEB_TARGETS)) {
    process.stderr.write(`building ${script}\n`);
    const run = spawnSync("pnpm", ["--filter", "@still/ext-chromium", script], { cwd: root, env: cleanEnv(env), stdio: ["ignore", "ignore", "inherit"] });
    if (run.status !== 0) throw new Error(`pnpm build step "${script}" failed`);
  }
}

export function buildPackages({ out, root = ROOT, env = {}, doBuild = false, allowDirty = false }) {
  for (const key of Object.keys(env)) if (!PUBLIC_ENV_KEYS.includes(key)) throw new Error(`--env ${key} is not an allowed public build value (${PUBLIC_ENV_KEYS.join(", ")})`);
  const problems = findMismatches(root);
  if (problems.length) throw new Error(`version.json and its consumers disagree:\n${problems.join("\n")}`);
  const versions = readVersions(root);
  if (doBuild) build(root, env);

  mkdirSync(out, { recursive: true });
  const files = {};
  const write = (name, bytes) => {
    writeFileSync(join(out, name), bytes);
    files[name] = { sha256: sha256(bytes), bytes: bytes.length };
  };

  for (const [target, { dist }] of Object.entries(WEB_TARGETS)) {
    const dir = join(root, dist);
    if (!existsSync(join(dir, "manifest.json"))) throw new Error(`${dist}/manifest.json is missing; build first (use --build)`);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    if (manifest.version !== versions.extension) throw new Error(`${target} manifest version ${manifest.version} does not match version.json extension ${versions.extension}`);
    write(`still-${target}-${versions.extension}.zip`, createZip(treeEntries(dir)));
  }

  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const source = sourceEntries(root, { allowDirty });
  source.push({ name: "AMO-BUILD-INSTRUCTIONS.md", data: Buffer.from(amoInstructions(versions, rootPackage, env)) });
  write(`still-source-${versions.extension}.zip`, createZip(source));

  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  const manifest = { version: versions.extension, appleVersion: versions.apple, appleBuild: versions.appleBuild, files: sorted };
  writeFileSync(join(out, "SHA256SUMS.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(out, "SHA256SUMS.txt"), Object.entries(sorted).map(([name, f]) => `${f.sha256}  ${name}\n`).join(""));
  return manifest;
}

function main(argv) {
  let out;
  let doBuild = false;
  let allowDirty = false;
  const env = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = resolve(argv[++i] ?? "");
    else if (argv[i] === "--build") doBuild = true;
    else if (argv[i] === "--allow-dirty") allowDirty = true;
    else if (argv[i] === "--env") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`--env expects VITE_NAME=value, got "${pair}"`);
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out) {
    process.stderr.write("usage: package.mjs --out <dir> [--build] [--env VITE_X=v]... [--allow-dirty]\n");
    process.exitCode = 2;
    return;
  }
  const manifest = buildPackages({ out, env, doBuild, allowDirty });
  for (const [name, f] of Object.entries(manifest.files)) process.stdout.write(`${f.sha256}  ${name}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
