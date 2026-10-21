#!/usr/bin/env node
// Production access-proof trust for store builds: the PUBLIC Ed25519 keys that Chrome, Firefox and
// Apple store builds use to verify a Still Pro access proof. Public material only. The matching
// private key is generated offline by the owner and only ever set as a server secret; it never
// appears in this repository, in a build, or in this script's input or output.
//
// One pinned file, scripts/release/production-access-keys.json, is the only source:
//   • package.mjs (and so the Chrome release workflow, which calls it) turns it into
//     VITE_ACCESS_ENVIRONMENT=production and VITE_ACCESS_PUBLIC_KEYS=<rows as JSON>;
//   • apps/apple/scripts/archive.sh writes the same rows into the four Apple Info.plists
//     (StillAccessEnvironment, StillAccessTrustKeys) for the archive only, then restores them.
// Swapping in the real keys is a change to that one file.
//
//   node scripts/release/access-trust.mjs check                     validate the pinned file as a store build would
//   node scripts/release/access-trust.mjs env                       print the two public web build values
//   node scripts/release/access-trust.mjs apple-apply   --backup <dir>   write the rows into the Apple plists
//   node scripts/release/access-trust.mjs apple-restore --backup <dir>   put the plists back exactly
//   node scripts/release/access-trust.mjs compare-server --secrets-json <file>
//        compare the pinned keys with the digests `supabase secrets list -o json` prints
//
// Node built-ins only.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const TRUST_FILE = "scripts/release/production-access-keys.json";
/** Test fixture. Its keys are refused by every store build (see parseStoreTrust). */
export const TEST_ONLY_TRUST_FIXTURE = "tests/fixtures/access-trust/TEST-ONLY-production-access-keys.json";
/** A current key and one standby, so the server can rotate without a new store version. */
export const MAX_TRUST_KEYS = 2;
export const TRUST_ENV_KEYS = Object.freeze(["VITE_ACCESS_ENVIRONMENT", "VITE_ACCESS_PUBLIC_KEYS"]);
export const APPLE_PLISTS = Object.freeze(["iOS (App)", "iOS (Extension)", "macOS (App)", "macOS (Extension)"].map((part) => `apps/apple/Still/${part}/Info.plist`));
/** Native configuration a store plist must not already carry (the QA overlay owns the sandbox ones). */
const NATIVE_TRUST_FIELDS = ["StillAccessEnvironment", "StillAccessTrustKeys", "StillBackendRouteProfile", "StillAccessSupabaseURL", "StillAccessSupabasePublishableKey"];
const PAID_FLAGS = [
  { path: "packages/shared-types/src/entitlement.ts", pattern: /export const PAID_TIER_ENABLED\s*=\s*(true|false)\s*;/g },
  { path: "apps/apple/StillKit/Sources/StillKit/MonetizationConfig.swift", pattern: /public static let paidTierEnabled\s*=\s*(true|false)\b/g },
];

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export class TrustRefusal extends Error {}
const refuse = (message) => {
  throw new TrustRefusal(`store access trust: ${message}`);
};

function fixtureKeys(root = HERE_ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, TEST_ONLY_TRUST_FIXTURE), "utf8")).keys.map((row) => row.publicKeyHex);
  } catch {
    return [];
  }
}

/**
 * Validate the pinned file's text by the store rules and return its rows, frozen, in the field order
 * the QA tooling uses. Same closed row grammar as packagedAccessTrust and NativeAccessConfiguration,
 * plus the store rules: every row is production, at most a current and a standby key, no test-only
 * fixture key, and (once the release is paid) at least one key.
 */
export function parseStoreTrust(text, { paid = false, testOnlyKeys = fixtureKeys() } = {}) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    refuse(`${TRUST_FILE} is not valid JSON`);
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) refuse(`${TRUST_FILE} must be an object with "about" and "keys"`);
  if (Object.keys(file).sort().join(",") !== "about,keys" || typeof file.about !== "string" || !Array.isArray(file.keys))
    refuse(`${TRUST_FILE} must have exactly a text "about" and a "keys" list`);
  if (file.keys.length > MAX_TRUST_KEYS) refuse(`at most ${MAX_TRUST_KEYS} keys (a current key and one standby), found ${file.keys.length}`);
  const kids = new Set();
  const hexes = new Set();
  const rows = file.keys.map((row, index) => {
    const where = `key ${index + 1}`;
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "environment,kid,publicKeyHex,purpose")
      refuse(`${where} must have exactly kid, publicKeyHex, environment and purpose (public material only)`);
    if (row.environment !== "production") refuse(`${where} says environment ${JSON.stringify(row.environment)}; a store build accepts only production keys`);
    if (row.purpose !== "access") refuse(`${where} must have purpose "access"`);
    if (typeof row.kid !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(row.kid)) refuse(`${where} has an invalid kid`);
    if (typeof row.publicKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(row.publicKeyHex)) refuse(`${where} publicKeyHex must be 64 lowercase hex characters (a 32-byte Ed25519 public key)`);
    if (row.kid.startsWith("test-only") || testOnlyKeys.includes(row.publicKeyHex)) refuse(`${where} is the TEST-ONLY fixture key, never a store key`);
    if (kids.has(row.kid) || hexes.has(row.publicKeyHex)) refuse(`${where} repeats a kid or public key`);
    kids.add(row.kid);
    hexes.add(row.publicKeyHex);
    return Object.freeze({ kid: row.kid, publicKeyHex: row.publicKeyHex, environment: "production", purpose: "access" });
  });
  if (paid && rows.length === 0) refuse("this release declares the paid tier, so it needs at least one production public key; Still Pro could never unlock without one");
  return Object.freeze(rows);
}

/**
 * Whether the release being built declares the paid tier. Today that is the paid constants in the
 * source (either one true).
 * TODO(PR-B, V3 release enablement G-plan): also return true when scripts/release/version.mjs declares
 * `paidTier` for this release line. That is the hook: once PR-B lands, OR its per-line value in here,
 * and every store build of a paid line refuses an empty key list.
 */
export function paidDeclared(root = HERE_ROOT) {
  return PAID_FLAGS.some(({ path, pattern }) => {
    const file = join(root, path);
    if (!existsSync(file)) return false;
    return [...readFileSync(file, "utf8").matchAll(pattern)].some((m) => m[1] === "true");
  });
}

/** The pinned trust for a store build from `root`. */
export function readStoreTrust(root = HERE_ROOT, { paid = paidDeclared(root) } = {}) {
  const path = join(root, TRUST_FILE);
  if (!existsSync(path)) refuse(`${TRUST_FILE} is missing`);
  const rows = parseStoreTrust(readFileSync(path, "utf8"), { paid });
  const json = JSON.stringify(rows);
  return Object.freeze({
    rows,
    json,
    sha256: sha256(json),
    paid,
    env: Object.freeze({ VITE_ACCESS_ENVIRONMENT: "production", VITE_ACCESS_PUBLIC_KEYS: json }),
  });
}

const xml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const valueXml = (value) =>
  Array.isArray(value)
    ? `<array>${value.map(valueXml).join("")}</array>`
    : typeof value === "object"
      ? `<dict>${Object.entries(value).map(([key, v]) => `<key>${xml(key)}</key>${valueXml(v)}`).join("")}</dict>`
      : `<string>${xml(value)}</string>`;

/** The native fields a store plist gets: production environment and the pinned rows. */
export function plistTrustFields(rows) {
  return { StillAccessEnvironment: "production", StillAccessTrustKeys: rows.map((row) => ({ ...row })) };
}

/** Add the store trust fields to one XML Info.plist's text. Same writer shape as the QA overlay. */
export function applyStoreTrustToPlist(text, rows) {
  if (!rows.length) refuse("no keys to write into a plist");
  if (!/^<\?xml/.test(text) || !/<plist\b/.test(text) || !/<\/dict>\s*<\/plist>\s*$/.test(text)) refuse("expected an XML Info.plist");
  if (NATIVE_TRUST_FIELDS.some((key) => text.includes(`<key>${key}</key>`))) refuse("the plist already carries native access configuration; restore it first");
  const fields = plistTrustFields(rows);
  return text.replace(/<\/dict>\s*<\/plist>\s*$/, `${Object.entries(fields).map(([key, v]) => `<key>${key}</key>${valueXml(v)}`).join("\n")}\n</dict>\n</plist>\n`);
}

/**
 * Write the pinned rows into the four Apple plists in `root`, keeping exact copies in `backup` first.
 * Does nothing (and returns null) when the pinned list is empty: a free release ships the plists unchanged.
 */
export function applyApplePlists(root, backup, { paid } = {}) {
  const trust = readStoreTrust(root, paid === undefined ? {} : { paid });
  if (!trust.rows.length) return null;
  if (existsSync(join(backup, "manifest.json"))) refuse(`${backup} already holds a backup; restore it first`);
  const prepared = APPLE_PLISTS.map((path) => {
    const original = readFileSync(join(root, path), "utf8");
    return { path, original, next: applyStoreTrustToPlist(original, trust.rows) };
  });
  mkdirSync(backup, { recursive: true });
  prepared.forEach(({ path }, i) => copyFileSync(join(root, path), join(backup, `${i}.plist`)));
  const manifest = prepared.map(({ path, original, next }, i) => ({ path, backup: `${i}.plist`, originalSha256: sha256(original), appliedSha256: sha256(next) }));
  writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const { path, next } of prepared) writeFileSync(join(root, path), next);
  return { trustSha256: trust.sha256, kids: trust.rows.map((row) => row.kid), files: manifest };
}

/** Put every plist back from `backup` and confirm the bytes match what was saved. */
export function restoreApplePlists(root, backup) {
  const manifestPath = join(backup, "manifest.json");
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const { path, backup: name, originalSha256 } of manifest) {
    const saved = readFileSync(join(backup, name));
    if (sha256(saved) !== originalSha256) refuse(`the backup of ${path} changed; restore it from git`);
    writeFileSync(join(root, path), saved);
  }
  return true;
}

/**
 * The CI-side link between the pinned file and the server. `supabase secrets list -o json` prints
 * each secret's name with a SHA-256 digest of its value, never the value. The server refuses to start
 * signing unless its private key matches ACCESS_PROOF_PUBLIC_KEY_HEX, so if that secret's digest is
 * the digest of a pinned row's publicKeyHex (and the kid and environment digests agree), every proof the
 * server signs verifies in a store build. Returns PASS/FAIL per check; no value or digest is printed.
 */
export function compareServerDigests(rows, secretsList) {
  if (!Array.isArray(secretsList)) refuse("expected the JSON list printed by `supabase secrets list -o json`");
  const digest = (name) => {
    const entry = secretsList.find((item) => item && item.name === name);
    const value = entry?.digest ?? entry?.value;
    return typeof value === "string" ? value.trim().toLowerCase() : null;
  };
  const publicKey = digest("ACCESS_PROOF_PUBLIC_KEY_HEX");
  const kid = digest("ACCESS_PROOF_KEY_ID");
  const environment = digest("ACCESS_PROOF_ENVIRONMENT");
  const signing = rows.findIndex((row) => sha256(row.publicKeyHex) === publicKey);
  const checks = [
    { name: "server-public-key-is-pinned", pass: signing >= 0 },
    { name: "server-kid-matches-that-key", pass: signing >= 0 && sha256(rows[signing].kid) === kid },
    { name: "server-environment-is-production", pass: environment === sha256("production") },
  ];
  return { ok: checks.every((c) => c.pass), checks, signingRow: signing >= 0 ? (signing === 0 ? "current" : "standby") : null };
}

function main(argv, root = HERE_ROOT) {
  const [command, flag, value] = argv;
  const out = (line) => process.stdout.write(`${line}\n`);
  if (command === "check" && argv.length === 1) {
    const trust = readStoreTrust(root);
    out(`production access trust: ${trust.rows.length} key(s)${trust.rows.length ? ` (${trust.rows.map((r) => r.kid).join(", ")})` : ""}, paid ${trust.paid ? "declared" : "not declared"}, sha256 ${trust.sha256}`);
    return 0;
  }
  if (command === "env" && argv.length === 1) {
    for (const [key, v] of Object.entries(readStoreTrust(root).env)) out(`${key}=${v}`);
    return 0;
  }
  if ((command === "apple-apply" || command === "apple-restore") && flag === "--backup" && value && argv.length === 3) {
    if (command === "apple-restore") {
      out(restoreApplePlists(root, resolve(value)) ? "Apple plists restored" : "nothing to restore");
      return 0;
    }
    const applied = applyApplePlists(root, resolve(value));
    out(applied ? `Apple plists carry production trust ${applied.kids.join(", ")} (sha256 ${applied.trustSha256})` : "no production keys pinned; Apple plists left unchanged");
    return 0;
  }
  if (command === "compare-server" && flag === "--secrets-json" && value && argv.length === 3) {
    const result = compareServerDigests(readStoreTrust(root).rows, JSON.parse(readFileSync(resolve(value), "utf8")));
    for (const { name, pass } of result.checks) out(`${pass ? "PASS" : "FAIL"} ${name}`);
    if (result.signingRow) out(`server signs with the pinned ${result.signingRow} key`);
    return result.ok ? 0 : 1;
  }
  process.stderr.write("usage: access-trust.mjs check | env | apple-apply --backup <dir> | apple-restore --backup <dir> | compare-server --secrets-json <file>\n");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
