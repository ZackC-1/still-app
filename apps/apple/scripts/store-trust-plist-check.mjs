#!/usr/bin/env node
// store-trust-plist-check.mjs — refuse a Release build of a Still app or Safari extension whose
// built Info.plist lacks the pinned production access trust.
//
// archive.sh (and, for a raw `xcodebuild archive`, `access-trust.mjs apple-apply`) writes
// StillAccessEnvironment = "production" and the rows of scripts/release/production-access-keys.json
// into the four Info.plists. An archive made without that step, for example from the Xcode GUI,
// would build cleanly and ship a Still that can never verify a Still Pro access proof. The run-script
// phase of each of the four targets runs this on Release builds against the BUILT plist
// (${TARGET_BUILD_DIR}/${INFOPLIST_PATH}), so such an archive fails instead.
//
// Exempt, because none of these can reach the App Store:
//   • simulator builds (PLATFORM_NAME ends in "simulator"), which qa-sim.sh verify-release makes;
//   • the QA builder's Release builds (paid-sandbox-qa.mjs buildAppleTarget), which pass the build
//     setting STILL_NON_STORE_BUILD=YES on the xcodebuild command line. They carry sandbox trust
//     or none, and their device exports are development-signed. archive.sh passes
//     STILL_NON_STORE_BUILD=NO so an exported variable cannot exempt a store archive.
// Debug builds never run it (the phase gates on CONFIGURATION = Release).
//
// Usage: node store-trust-plist-check.mjs <built Info.plist>
// Prints field names and verdicts only. Node built-ins and plutil only.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStoreTrust, TrustRefusal } from "../../../scripts/release/access-trust.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const QA_EXEMPTION_SETTING = "STILL_NON_STORE_BUILD";
const HOW = "Archive with apps/apple/scripts/archive.sh, or run `node scripts/release/access-trust.mjs apple-apply --backup <empty dir>` before a raw xcodebuild archive (docs/release/versioning-and-packages.md)";

/** Why this build is exempt, or null when it must carry the store trust. */
export function exemption(env) {
  if (/simulator$/.test(env.PLATFORM_NAME ?? "")) return "simulator build";
  if (env[QA_EXEMPTION_SETTING] === "YES") return `QA builder's non-store build (${QA_EXEMPTION_SETTING}=YES)`;
  return null;
}

/** Key order inside a plist dict is not meaningful; compare rows field by field. */
const canonical = (value) =>
  Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;

/**
 * Problems with a built plist's trust fields, given the pinned production rows. Empty means it
 * carries exactly what archive.sh writes. With nothing pinned (a free release) archive.sh leaves the
 * plists unchanged, so then the fields must be absent.
 */
export function checkStoreTrustFields({ StillAccessEnvironment: environment, StillAccessTrustKeys: keys }, pinnedRows) {
  if (pinnedRows.length === 0)
    return environment === undefined && keys === undefined ? [] : ["the plist carries access trust although none is pinned in scripts/release/production-access-keys.json"];
  const problems = [];
  if (environment !== "production") problems.push(`StillAccessEnvironment is ${environment === undefined ? "missing" : 'not "production"'}`);
  if (keys === undefined) problems.push("StillAccessTrustKeys is missing");
  else if (!Array.isArray(keys)) problems.push("StillAccessTrustKeys is not a list");
  else if (keys.length === 0) problems.push("StillAccessTrustKeys is empty");
  else if (JSON.stringify(canonical(keys)) !== JSON.stringify(canonical(pinnedRows)))
    problems.push("StillAccessTrustKeys does not match scripts/release/production-access-keys.json");
  return problems;
}

/** The two fields from a plist (XML or binary); a field plutil cannot extract reads as missing. */
export function readTrustFields(path) {
  if (!existsSync(path)) throw new TrustRefusal(`no built Info.plist at ${path}`);
  const plutil = (args) => {
    try {
      return execFileSync("/usr/bin/plutil", [...args, "-o", "-", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  };
  // plutil cannot write a bare string as JSON, so the environment is read raw (a non-string reads as missing).
  const environment = plutil(["-extract", "StillAccessEnvironment", "raw", "-expect", "string"]);
  const keys = plutil(["-extract", "StillAccessTrustKeys", "json"]);
  return { StillAccessEnvironment: environment?.replace(/\n$/, ""), StillAccessTrustKeys: keys === undefined ? undefined : JSON.parse(keys) };
}

function main([path, ...rest]) {
  if (!path || rest.length) {
    process.stderr.write("usage: store-trust-plist-check.mjs <built Info.plist>\n");
    return 2;
  }
  const exempt = exemption(process.env);
  if (exempt) {
    process.stdout.write(`note: store access trust check skipped: ${exempt}\n`);
    return 0;
  }
  const pinned = readStoreTrust(REPO).rows;
  const problems = checkStoreTrustFields(readTrustFields(path), pinned);
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`error: ${path}: ${problem}. A store build must carry the pinned production access trust.\n`);
    process.stderr.write(`error: ${HOW}.\n`);
    return 1;
  }
  process.stdout.write(`${path}: production access trust (${pinned.length ? pinned.map((row) => row.kid).join(", ") : "none pinned"})\n`);
  return 0;
}

// Compare real paths: Xcode's SRCROOT can reach this file through a symlink (/tmp is /private/tmp),
// and a plain path comparison would then skip main() and pass the build silently.
const realpath = (path) => { try { return realpathSync(path); } catch { return path; } };
if (process.argv[1] && realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof TrustRefusal ? error.message : `store access trust check failed (${error?.code ?? error?.name ?? "unknown"})`}\n`);
    process.exitCode = 1;
  }
}
