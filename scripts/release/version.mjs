#!/usr/bin/env node
// One version source for every Still package. version.json at the repository root holds:
//   extension   Chrome and Firefox manifest version (packages/ext-chromium/package.json; WXT reads it)
//   apple       Apple app MARKETING_VERSION and the Safari extension version (packages/ext-safari/package.json)
//   appleBuild  Apple CURRENT_PROJECT_VERSION. Only ever increases; never reset when `apple` changes.
//
//   node scripts/release/version.mjs check              exit 1 if any consumer disagrees with version.json
//   node scripts/release/version.mjs sync               write version.json's values into every consumer
//   node scripts/release/version.mjs bump-build         appleBuild + 1, then sync
//   node scripts/release/version.mjs set <extension|apple> <x.y.z>   refuses to go backwards, then sync
//
// The consumers are package.json files and the Xcode project. Nothing here talks to a store.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PBXPROJ = "apps/apple/Still/Still.xcodeproj/project.pbxproj";
const PACKAGE_CONSUMERS = { extension: ["packages/ext-chromium/package.json"], apple: ["packages/ext-safari/package.json"] };

export function compareSemver(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Parse and validate version.json text. Throws on anything malformed. */
export function parseVersions(text) {
  const v = JSON.parse(text);
  for (const key of ["extension", "apple"])
    if (typeof v[key] !== "string" || !SEMVER.test(v[key])) throw new Error(`version.json: "${key}" must be x.y.z, got ${JSON.stringify(v[key])}`);
  if (!Number.isInteger(v.appleBuild) || v.appleBuild < 1) throw new Error(`version.json: "appleBuild" must be a positive integer, got ${JSON.stringify(v.appleBuild)}`);
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
export function findMismatches(root = ROOT) {
  const v = readVersions(root);
  const problems = [];
  for (const [channel, files] of Object.entries(PACKAGE_CONSUMERS))
    for (const file of files) {
      const actual = JSON.parse(readFileSync(join(root, file), "utf8")).version;
      if (actual !== v[channel]) problems.push(`${file}: version ${actual}, version.json ${channel} is ${v[channel]}`);
    }
  const pbx = readFileSync(join(root, PBXPROJ), "utf8");
  const marketing = pbxValues(pbx, "MARKETING_VERSION");
  const builds = pbxValues(pbx, "CURRENT_PROJECT_VERSION");
  if (marketing.length === 0 || builds.length === 0) problems.push(`${PBXPROJ}: no MARKETING_VERSION or CURRENT_PROJECT_VERSION found`);
  marketing.forEach((m) => m !== v.apple && problems.push(`${PBXPROJ}: MARKETING_VERSION ${m}, version.json apple is ${v.apple}`));
  builds.forEach((b) => b !== String(v.appleBuild) && problems.push(`${PBXPROJ}: CURRENT_PROJECT_VERSION ${b}, version.json appleBuild is ${v.appleBuild}`));
  return problems;
}

export function sync(root = ROOT) {
  const v = readVersions(root);
  for (const [channel, files] of Object.entries(PACKAGE_CONSUMERS))
    for (const file of files) {
      const path = join(root, file);
      const text = readFileSync(path, "utf8");
      const next = text.replace(/("version":\s*)"[^"]*"/, `$1"${v[channel]}"`);
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
  if (!SEMVER.test(version ?? "")) throw new Error(`version must be x.y.z, got "${version}"`);
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
    process.stderr.write("usage: version.mjs check | sync | bump-build | set <extension|apple> <x.y.z>\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
