#!/usr/bin/env node
// Bundle byte-identity check. Builds the shipped web bundles (Safari extension, Chrome extension,
// Firefox extension, Apple app web view) with exactly the public build values you pass, records a
// SHA-256 for every output file, and compares two such records.
//
// A change that is meant to exist only in an opted-in developer build (for example the Safari V3
// screens behind VITE_APPLE_ATOMIC_SETTINGS) must leave every default bundle byte-for-byte as it
// was. Take a snapshot on the base commit, another after the change, and diff them:
//
//   node scripts/bundles/identity.mjs snapshot /tmp/base.json
//   node scripts/bundles/identity.mjs snapshot /tmp/base-configured.json \
//     --env VITE_SUPABASE_URL=https://still-audit.invalid --env VITE_SUPABASE_ANON_KEY=public-audit-placeholder
//   ... apply the change ...
//   node scripts/bundles/identity.mjs snapshot /tmp/after.json
//   node scripts/bundles/identity.mjs diff /tmp/base.json /tmp/after.json
//
// Only public placeholder values belong on the command line. Every VITE_* variable already in the
// environment is removed first, and the script refuses to run while a package-level .env file
// exists, because Vite would silently read it and the result would no longer be what was asked.
// `--targets safari,chrome` limits the builds. `diff` exits 1 and lists every differing file.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const TARGETS = {
  safari: { filter: "@still/ext-safari", script: "build", out: "packages/ext-safari/dist/safari-mv3" },
  chrome: { filter: "@still/ext-chromium", script: "build", out: "packages/ext-chromium/dist/chrome-mv3" },
  firefox: { filter: "@still/ext-chromium", script: "build:firefox", out: "packages/ext-chromium/dist/firefox-mv3" },
  "app-webview": { filter: "@still/app-webview", script: "build", out: "packages/app-webview/dist" },
};

const ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];
const PACKAGES = ["packages/ext-safari", "packages/ext-chromium", "packages/app-webview"];

/** Every file under `dir`, sorted, as `{ "relative/path": "sha256" }`. */
export function hashTree(dir) {
  const files = {};
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path).split("\\").join("/")] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return files;
}

/** Differences between two snapshots, as readable lines; empty means byte-identical. */
export function diffSnapshots(a, b) {
  const lines = [];
  for (const target of [...new Set([...Object.keys(a.targets), ...Object.keys(b.targets)])].sort()) {
    const left = a.targets[target];
    const right = b.targets[target];
    if (!left || !right) {
      lines.push(`${target}: only in ${left ? "first" : "second"} snapshot`);
      continue;
    }
    for (const file of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!(file in left)) lines.push(`${target}: added ${file}`);
      else if (!(file in right)) lines.push(`${target}: removed ${file}`);
      else if (left[file] !== right[file]) lines.push(`${target}: changed ${file}`);
    }
  }
  return lines;
}

function parseArgs(argv) {
  const env = {};
  let targets = Object.keys(TARGETS);
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0 || !pair.startsWith("VITE_")) throw new Error(`--env expects VITE_NAME=value, got "${pair}"`);
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (argv[i] === "--targets") {
      targets = (argv[++i] ?? "").split(",").filter(Boolean);
      for (const t of targets) if (!(t in TARGETS)) throw new Error(`unknown target "${t}"`);
    } else rest.push(argv[i]);
  }
  return { env, targets, rest };
}

function snapshot(outFile, env, targets) {
  for (const pkg of PACKAGES)
    for (const name of ENV_FILES)
      if (existsSync(join(ROOT, pkg, name)))
        throw new Error(`${pkg}/${name} exists; remove or move it so the build uses only the values given`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITE_")));
  const result = { env, targets: {} };
  for (const target of targets) {
    const { filter, script, out } = TARGETS[target];
    process.stderr.write(`building ${target}\n`);
    const run = spawnSync("pnpm", ["--filter", filter, script], { cwd: ROOT, env: { ...clean, ...env }, stdio: ["ignore", "ignore", "inherit"] });
    if (run.status !== 0) throw new Error(`${target} build failed`);
    result.targets[target] = hashTree(join(ROOT, out));
  }
  writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  for (const [target, files] of Object.entries(result.targets))
    process.stdout.write(`${target}: ${Object.keys(files).length} files\n`);
}

function main(argv) {
  const { env, targets, rest } = parseArgs(argv);
  const [command, ...paths] = rest;
  if (command === "snapshot" && paths.length === 1) return snapshot(resolve(paths[0]), env, targets);
  if (command === "diff" && paths.length === 2) {
    const [a, b] = paths.map((p) => JSON.parse(readFileSync(resolve(p), "utf8")));
    const lines = diffSnapshots(a, b);
    if (lines.length === 0) {
      process.stdout.write("byte-identical\n");
      return;
    }
    process.stdout.write(lines.join("\n") + "\n");
    process.exitCode = 1;
    return;
  }
  process.stderr.write("usage: identity.mjs snapshot <out.json> [--env VITE_X=v]... [--targets a,b]\n       identity.mjs diff <a.json> <b.json>\n");
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
