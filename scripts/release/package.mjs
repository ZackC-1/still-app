#!/usr/bin/env node
// Reproducible release packages and their hashes. Local only: this never contacts a store.
//
//   node scripts/release/package.mjs --out <dir> [--env VITE_X=value]... [--allow-dirty]
//
// Writes into <dir>:
//   still-chrome-<extension version>.zip       Chrome Web Store package
//   still-firefox-<extension version>.zip      Firefox (AMO) package
//   still-source-<extension version>.zip       the complete source AMO requires, with build instructions
//   SHA256SUMS.json / SHA256SUMS.txt           a hash for every file above
//
// --env     a public build value (see PUBLIC_ENV_KEYS). Every other VITE_* variable in your shell is
//           removed first, and the values given are recorded in the AMO build instructions so a
//           reviewer can rebuild the same bytes. Never pass a secret.
//
// Packages are always built fresh from `git archive HEAD` exported into a temporary directory, never
// from your working tree. An untracked file, a stray .env, a symlink or a stale dist/ in your checkout
// therefore cannot reach a zip, and the Chrome/Firefox zips contain exactly what the source zip
// can rebuild. Uncommitted edits to tracked files are refused (they would be silently ignored);
// --allow-dirty overrides that refusal for tests.
//
// Reproducibility: archives have sorted entries, fixed timestamps, fixed permissions and no machine
// paths (see zip.mjs). Building twice from the same commit in the same directory with the same
// toolchain gives byte-identical zips. Svelte's scoped-CSS hash is made path-independent in
// packages/ext-chromium/wxt.config.ts, so the Chrome and Firefox bundles also rebuild identically
// in a reviewer's own directory.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readVersions, findMismatches, ROOT } from "./version.mjs";
import { createZip } from "./zip.mjs";

export const PUBLIC_ENV_KEYS = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_POSTHOG_KEY", "VITE_POSTHOG_HOST", "VITE_MODERN_SETTINGS_SYNC_ENABLED"];

// VITE_* names the shipped web code mentions on purpose but that must never reach a store package.
// Any other name found in the source that is not in PUBLIC_ENV_KEYS stops the build until someone
// decides which list it belongs to.
export const DELIBERATELY_UNPACKAGED = {
  VITE_APPLE_ATOMIC_SETTINGS: "developer opt-in for the Apple settings screens; store packages leave it unset",
  VITE_ACCESS_ENVIRONMENT: "scoped access QA trust opt-in; store packages retain production empty-key defaults",
  VITE_ACCESS_PUBLIC_KEYS: "scoped access QA trust material; supplied only by the separate paid-sandbox profile",
  VITE_REVIEW_SIGNIN_EMAIL: "store-review sign-in helper; must not ship in a public package",
};
const ENV_SCAN_DIRS = ["packages/ext-chromium", "packages/core/src", "packages/shared-types/src"];

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
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`${path} is a symlink; packages never contain symlinks`);
      if (info.isDirectory()) walk(path);
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
    const [mode, type, sha] = meta.split(" ");
    if (type !== "blob") continue;
    if (mode === "120000" && (SOURCE_ROOT_FILES.includes(path) || SOURCE_PREFIXES.some((p) => path.startsWith(p)))) throw new Error(`${path} is a tracked symlink; packages never contain symlinks`);
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

export function cleanEnv(extra) {
  // Vite reads VITE_*, WXT reads WXT_*; neither may leak in from the shell.
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VITE|WXT)_/.test(key)));
  return { ...base, ...extra };
}

/**
 * VITE_* and WXT_* names written literally in shipped source (including the `%VITE_X%` placeholder in
 * html) that are neither packaged nor deliberately excluded. Limitation: a name assembled at runtime,
 * such as import.meta.env[prefix + "KEY"], cannot be seen by a text scan; do not write code that way.
 */
export function unlistedViteReferences(root = ROOT) {
  const found = new Set();
  const skip = new Set(["node_modules", "dist", ".wxt", ".output", "__tests__"]);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile() && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|svelte|html)$/.test(name) && !/\.test\.|\.spec\./.test(name))
        for (const m of readFileSync(path, "utf8").matchAll(/\b(?:VITE|WXT)_[A-Z0-9_]*[A-Z0-9]/g)) found.add(m[0]);
    }
  };
  for (const dir of ENV_SCAN_DIRS) if (existsSync(join(root, dir))) walk(join(root, dir));
  return [...found].filter((name) => !PUBLIC_ENV_KEYS.includes(name) && !(name in DELIBERATELY_UNPACKAGED)).sort();
}

/** Export the committed tree (only what the web packages need) into `dir`. */
function exportHead(root, dir) {
  const archive = execFileSync("git", ["archive", "--format=tar", "HEAD", ...SOURCE_ROOT_FILES, "packages", "scripts/release"], { cwd: root, maxBuffer: 1 << 29 });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
}

function installAndBuild(dir, env) {
  for (const name of readdirSync(join(dir, "packages/ext-chromium")))
    if (name.startsWith(".env") && name !== ".env.example") throw new Error(`packages/ext-chromium/${name} exists in the export; refusing to build`);
  const run = (args) => {
    const result = spawnSync("pnpm", args, { cwd: dir, env: cleanEnv(env), stdio: ["ignore", "ignore", "inherit"] });
    if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed`);
  };
  process.stderr.write("installing the exported tree\n");
  run(["install", "--frozen-lockfile"]);
  for (const { script } of Object.values(WEB_TARGETS)) {
    process.stderr.write(`building ${script}\n`);
    run(["--filter", "@still/ext-chromium", script]);
  }
}

export function buildPackages({ out, root = ROOT, env = {}, allowDirty = false }) {
  for (const key of Object.keys(env)) if (!PUBLIC_ENV_KEYS.includes(key)) throw new Error(`--env ${key} is not an allowed public build value (${PUBLIC_ENV_KEYS.join(", ")})`);
  if (!allowDirty && git(["status", "--porcelain", "--untracked-files=no"], root).trim() !== "")
    throw new Error("tracked files have uncommitted changes, which a HEAD build would ignore; commit first (or pass --allow-dirty for a throwaway package)");
  if (!allowDirty) {
    const full = findMismatches(root);
    if (full.length) throw new Error(`version.json and its consumers disagree:\n${full.join("\n")}`);
  }
  const work = mkdtempSync(join(tmpdir(), "still-package-"));
  try {
    // Refuse tracked symlinks before anything is installed or built: WXT copies through a symlink,
    // so the target's contents would reach dist/. Reading the source set also validates it.
    const source = sourceEntries(root, { allowDirty: true });
    exportHead(root, work);
    const unlisted = unlistedViteReferences(work);
    if (unlisted.length)
      throw new Error(`shipped source reads ${unlisted.join(", ")}, which is neither a packaged public value nor deliberately excluded; add it to PUBLIC_ENV_KEYS or DELIBERATELY_UNPACKAGED in scripts/release/package.mjs`);
    const problems = findMismatches(work, { skipApple: true });
    if (problems.length) throw new Error(`version.json and its consumers disagree:\n${problems.join("\n")}`);
    const versions = readVersions(work);
    installAndBuild(work, env);

    // Staged in memory: nothing reaches --out until every check has passed.
    const staged = {};
    const files = {};
    const write = (name, bytes) => {
      staged[name] = bytes;
      files[name] = { sha256: sha256(bytes), bytes: bytes.length };
    };
    for (const [target, { dist }] of Object.entries(WEB_TARGETS)) {
      const dir = join(work, dist);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      if (manifest.version !== versions.extension) throw new Error(`${target} manifest version ${manifest.version} does not match version.json extension ${versions.extension}`);
      write(`still-${target}-${versions.extension}.zip`, createZip(treeEntries(dir)));
    }

    const rootPackage = JSON.parse(readFileSync(join(work, "package.json"), "utf8"));
    source.push({ name: "AMO-BUILD-INSTRUCTIONS.md", data: Buffer.from(amoInstructions(versions, rootPackage, env)) });
    write(`still-source-${versions.extension}.zip`, createZip(source));

    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
    const manifest = { version: versions.extension, appleVersion: versions.apple, appleBuild: versions.appleBuild, files: sorted };
    staged["SHA256SUMS.json"] = JSON.stringify(manifest, null, 2) + "\n";
    staged["SHA256SUMS.txt"] = Object.entries(sorted).map(([name, f]) => `${f.sha256}  ${name}\n`).join("");
    mkdirSync(out, { recursive: true });
    for (const [name, bytes] of Object.entries(staged)) writeFileSync(join(out, name), bytes);
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  let out;
  let allowDirty = false;
  const env = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = resolve(argv[++i] ?? "");
    else if (argv[i] === "--allow-dirty") allowDirty = true;
    else if (argv[i] === "--env") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`--env expects VITE_NAME=value, got "${pair}"`);
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out) {
    process.stderr.write("usage: package.mjs --out <dir> [--env VITE_X=v]... [--allow-dirty]\n");
    process.exitCode = 2;
    return;
  }
  const manifest = buildPackages({ out, env, allowDirty });
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
