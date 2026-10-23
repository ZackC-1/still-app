#!/usr/bin/env node
// One version source for every Still package. version.json at the repository root holds:
//   extension   Chrome and Firefox manifest version (packages/ext-chromium/package.json; WXT reads it)
//   apple       Apple app MARKETING_VERSION (x.y or x.y.z, as App Store Connect shows it) and the Safari
//               extension version (packages/ext-safari/package.json, written as x.y.z: 3.0 becomes 3.0.0)
//   appleBuild  Apple CURRENT_PROJECT_VERSION. Only ever increases; never reset when `apple` changes.
//   paidTier    true|false: whether the Chrome and Firefox release line ships with the paid tier on.
//               The store packagers refuse a build whose PAID_TIER_ENABLED differs from it.
//
//   node scripts/release/version.mjs check              exit 1 if any consumer disagrees with version.json
//   node scripts/release/version.mjs sync               write version.json's values into every consumer
//   node scripts/release/version.mjs bump-build         appleBuild + 1, then sync
//   node scripts/release/version.mjs set extension <x.y.z>   refuses to go backwards, then sync
//   node scripts/release/version.mjs set apple <x.y[.z]>     refuses to go backwards, then sync
//
// The consumers are package.json files and the Xcode project. Nothing here talks to a store.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Apple marketing versions may be two parts (3.0), as App Store Connect allows; a missing patch is 0.
const APPLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(\.(0|[1-9]\d*))?$/;
const VERSION_FORMAT = { extension: { pattern: SEMVER, shape: "x.y.z" }, apple: { pattern: APPLE_VERSION, shape: "x.y or x.y.z" } };

/** The package.json form of a channel version: always x.y.z (an Apple 3.0 is written 3.0.0). */
export function packageVersion(version) {
  return version.split(".").length === 2 ? `${version}.0` : version;
}
const PBXPROJ = "apps/apple/Still/Still.xcodeproj/project.pbxproj";
const PACKAGE_CONSUMERS = { extension: ["packages/ext-chromium/package.json"], apple: ["packages/ext-safari/package.json"] };

export function compareSemver(a, b) {
  const [x, y] = [a, b].map((v) => packageVersion(v).split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Parse and validate version.json text. Throws on anything malformed. */
export function parseVersions(text) {
  const v = JSON.parse(text);
  for (const [key, { pattern, shape }] of Object.entries(VERSION_FORMAT))
    if (typeof v[key] !== "string" || !pattern.test(v[key])) throw new Error(`version.json: "${key}" must be ${shape}, got ${JSON.stringify(v[key])}`);
  if (!Number.isInteger(v.appleBuild) || v.appleBuild < 1) throw new Error(`version.json: "appleBuild" must be a positive integer, got ${JSON.stringify(v.appleBuild)}`);
  // A commit from before paidTier existed declares nothing, which means false (the old "must be off" rule).
  if (v.paidTier === undefined) v.paidTier = false;
  if (typeof v.paidTier !== "boolean") throw new Error(`version.json: "paidTier" must be true or false, got ${JSON.stringify(v.paidTier)}`);
  return v;
}

export function readVersions(root = ROOT) {
  return parseVersions(readFileSync(join(root, "version.json"), "utf8"));
}

/** Replace every `KEY = value;` build setting in a pbxproj; returns the new text and the count replaced. */
export function setBuildSettings(text, key, value) {
  let count = 0;
  const next = text.replace(new RegExp(`(\\b${key} = )[^;]+;`, "g"), (_, head) => (count++, `${head}${value};`));
  return { text: next, count };
}

function pbxValues(text, key) {
  return [...text.matchAll(new RegExp(`\\b${key} = ([^;]+);`, "g"))].map((m) => m[1].trim());
}

/** Every disagreement between version.json and its consumers, as readable lines. Empty means consistent. */
export function findMismatches(root = ROOT, { skipApple = false } = {}) {
  const v = readVersions(root);
  const problems = [];
  for (const [channel, files] of Object.entries(PACKAGE_CONSUMERS))
    for (const file of files) {
      const actual = JSON.parse(readFileSync(join(root, file), "utf8")).version;
      if (actual !== packageVersion(v[channel])) problems.push(`${file}: version ${actual}, version.json ${channel} is ${v[channel]}`);
    }
  if (skipApple) return problems;
  const pbx = readFileSync(join(root, PBXPROJ), "utf8");
  const marketing = pbxValues(pbx, "MARKETING_VERSION");
  const builds = pbxValues(pbx, "CURRENT_PROJECT_VERSION");
  if (marketing.length === 0 || builds.length === 0) problems.push(`${PBXPROJ}: no MARKETING_VERSION or CURRENT_PROJECT_VERSION found`);
  marketing.forEach((m) => m !== v.apple && problems.push(`${PBXPROJ}: MARKETING_VERSION ${m}, version.json apple is ${v.apple}`));
  builds.forEach((b) => b !== String(v.appleBuild) && problems.push(`${PBXPROJ}: CURRENT_PROJECT_VERSION ${b}, version.json appleBuild is ${v.appleBuild}`));
  return problems;
}

const gitText = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** True when the checkout's history is truncated, which makes any history check meaningless. */
export function isShallow(root = ROOT) {
  return gitText(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
}

/**
 * The build counter must never fall: not between any two committed revisions of version.json, not
 * below main when origin/main is known, not below the working copy's last commit. Throws when the
 * history cannot be trusted (a shallow clone), so a truncated CI checkout fails loudly instead of
 * passing on one revision.
 */
export function assertBuildHistory(root = ROOT) {
  if (isShallow(root)) throw new Error("this is a shallow clone, so the build-counter history cannot be checked; fetch full history (git fetch --unshallow, or fetch-depth: 0 in CI)");
  const read = (ref) => JSON.parse(gitText(root, ["show", `${ref}:version.json`])).appleBuild;
  let previous = 0;
  for (const hash of gitText(root, ["log", "--format=%H", "--reverse", "--", "version.json"]).split("\n").filter(Boolean)) {
    const value = read(hash);
    if (value < previous) throw new Error(`appleBuild fell from ${previous} to ${value} at ${hash}`);
    previous = value;
  }
  const current = readVersions(root).appleBuild;
  if (current < previous) throw new Error(`working copy appleBuild ${current} is below the last committed ${previous}`);
  try {
    const main = read("origin/main");
    if (current < main) throw new Error(`appleBuild ${current} is below origin/main's ${main}`);
  } catch (error) {
    if (/is below origin\/main/.test(error.message)) throw error; // origin/main absent or has no version.json yet
  }
  return current;
}

export function sync(root = ROOT) {
  const v = readVersions(root);
  for (const [channel, files] of Object.entries(PACKAGE_CONSUMERS))
    for (const file of files) {
      const path = join(root, file);
      const text = readFileSync(path, "utf8");
      const next = text.replace(/("version":\s*)"[^"]*"/, `$1"${packageVersion(v[channel])}"`);
      if (next !== text) writeFileSync(path, next);
    }
  const path = join(root, PBXPROJ);
  let text = readFileSync(path, "utf8");
  text = setBuildSettings(text, "MARKETING_VERSION", v.apple).text;
  text = setBuildSettings(text, "CURRENT_PROJECT_VERSION", v.appleBuild).text;
  writeFileSync(path, text);
}

function writeVersions(root, v) {
  const path = join(root, "version.json");
  const current = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...current, extension: v.extension, apple: v.apple, appleBuild: v.appleBuild }, null, 2) + "\n");
}

export function bumpBuild(root = ROOT) {
  const v = readVersions(root);
  writeVersions(root, { ...v, appleBuild: v.appleBuild + 1 });
  sync(root);
  return v.appleBuild + 1;
}

export function setVersion(channel, version, root = ROOT) {
  if (!(channel in PACKAGE_CONSUMERS)) throw new Error(`channel must be extension or apple, got "${channel}"`);
  const { pattern, shape } = VERSION_FORMAT[channel];
  if (!pattern.test(version ?? "")) throw new Error(`${channel} version must be ${shape}, got "${version}"`);
  const v = readVersions(root);
  if (compareSemver(version, v[channel]) < 0) throw new Error(`refusing to lower ${channel} from ${v[channel]} to ${version}`);
  writeVersions(root, { ...v, [channel]: version });
  sync(root);
}

function main([command, ...args]) {
  if (command === "check") {
    const problems = findMismatches();
    if (problems.length) {
      process.stderr.write(problems.join("\n") + "\nrun: node scripts/release/version.mjs sync\n");
      process.exitCode = 1;
    } else process.stdout.write("consistent\n");
  } else if (command === "sync") {
    sync();
    process.stdout.write("synced\n");
  } else if (command === "bump-build") process.stdout.write(`appleBuild is now ${bumpBuild()}\n`);
  else if (command === "set") {
    setVersion(args[0], args[1]);
    process.stdout.write(`${args[0]} is now ${args[1]}\n`);
  } else {
    process.stderr.write("usage: version.mjs check | sync | bump-build | set extension <x.y.z> | set apple <x.y[.z]>\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
