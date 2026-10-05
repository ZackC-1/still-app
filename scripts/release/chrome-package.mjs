#!/usr/bin/env node
// The unprivileged half of the Chrome release workflow: build the Chrome package for one commit on
// main and fingerprint it. This job installs npm packages, so it never holds a Google credential:
// it has no id-token permission and never contacts the store.
//
//   node scripts/release/chrome-package.mjs --out <dir>
//
// Inputs (environment only): RELEASE_MODE, RELEASE_COMMIT, RELEASE_VERSION, RELEASE_ZIP_SHA256,
// RELEASE_CONFIRM_SUBMIT, the public build values named in PUBLIC_ENV_KEYS (by owner decision they
// are `chrome-release` environment variables; they ship inside every copy of the extension anyway),
// and GitHub's own GITHUB_* values.
//
// Writes <dir>/still-chrome-<version>.zip and <dir>/SHA256SUMS.json (the build's own manifest), and
// the step output zip-sha256. In every mode except package-only the fingerprint must equal the
// owner's chrome_zip_sha256, or nothing is handed to the store job.

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackages, PUBLIC_ENV_KEYS, sha256 } from "./package.mjs";
import { ROOT } from "./version.mjs";
import { checkInputs, checkRunContext, zipName } from "./chrome-release.mjs";
import { redact, StoreRefusal } from "./chrome-store.mjs";

// The four values a configured store build cannot do without. The modern-sync switch is optional:
// empty means the release leaves it unset.
export const REQUIRED_PUBLIC_KEYS = Object.freeze(["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_POSTHOG_KEY", "VITE_POSTHOG_HOST"]);
const PAID_FLAG_FILE = "packages/shared-types/src/entitlement.ts";

/** Store packages ship with the paid tier switched off (product rule: a paid-test package never goes to a store). */
export function assertPaidTierOff(sourceText) {
  const matches = [...String(sourceText).matchAll(/export const PAID_TIER_ENABLED\s*=\s*(true|false)\s*;/g)];
  if (matches.length !== 1) throw new StoreRefusal("paid-flag-unknown", `Could not find exactly one PAID_TIER_ENABLED in ${PAID_FLAG_FILE}`);
  if (matches[0][1] !== "false") throw new StoreRefusal("paid-flag-on", "PAID_TIER_ENABLED is true at this commit; a store package must have the paid tier off");
}

/** The public build values from the environment. Required ones must be present; empty optional ones are left unset. */
export function collectPublicEnv(env) {
  const values = {};
  const missing = [];
  for (const key of PUBLIC_ENV_KEYS) {
    const value = env[key] ?? "";
    if (value !== "") values[key] = value;
    else if (REQUIRED_PUBLIC_KEYS.includes(key)) missing.push(key);
  }
  if (missing.length) throw new StoreRefusal("build-values-missing", `The chrome-release environment is missing ${missing.join(", ")}; refusing to build an unconfigured store package`);
  return values;
}

/** Check what buildPackages produced against the inputs. Returns the zip fingerprint. */
export function verifyBuilt({ manifest, zipBytes, inputs }) {
  const name = zipName(inputs.version);
  if (manifest.version !== inputs.version) throw new StoreRefusal("version-mismatch", `version.json at this commit says ${manifest.version}, not ${inputs.version}`);
  const digest = sha256(zipBytes);
  if (manifest.files?.[name]?.sha256 !== digest) throw new StoreRefusal("package-mismatch", `${name} does not match the build's own fingerprint`);
  if (inputs.zipSha256 !== "" && inputs.zipSha256 !== digest)
    throw new StoreRefusal("package-mismatch", `The rebuilt package's fingerprint ${digest} is not the approved ${inputs.zipSha256}. Nothing goes to the store.`);
  return digest;
}

const gitIn = (root) => (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Build and verify. `build` and `git` are injectable so tests never install or build anything.
 * The candidate commit must already be on main (an ancestor of, or equal to, the checked-out main tip).
 */
export function runPackage({ env, out, root = ROOT, build = buildPackages, git = gitIn(root), log = (_line) => {} }) {
  const inputs = checkInputs(env);
  checkRunContext(env);
  try {
    git(["merge-base", "--is-ancestor", inputs.commit, "HEAD"]);
  } catch {
    throw new StoreRefusal("commit-not-on-main", "That commit is not on main");
  }
  const publicEnv = collectPublicEnv(env);
  const work = mkdtempSync(join(tmpdir(), "still-chrome-candidate-"));
  const stage = join(work, "out");
  const candidate = join(work, "tree");
  try {
    git(["worktree", "add", "--detach", candidate, inputs.commit]);
    assertPaidTierOff(readFileSync(join(candidate, PAID_FLAG_FILE), "utf8"));
    log(`Building ${inputs.version} from ${inputs.commit}`);
    const manifest = build({ out: stage, root: candidate, env: publicEnv });
    const name = zipName(inputs.version);
    const digest = verifyBuilt({ manifest, zipBytes: readFileSync(join(stage, name)), inputs });
    mkdirSync(out, { recursive: true });
    copyFileSync(join(stage, name), join(out, name));
    copyFileSync(join(stage, "SHA256SUMS.json"), join(out, "SHA256SUMS.json"));
    return { inputs, digest, name };
  } finally {
    try {
      git(["worktree", "remove", "--force", candidate]);
    } catch {
      // The worktree may not exist if `worktree add` itself failed.
    }
    rmSync(work, { recursive: true, force: true });
  }
}

export function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const err = deps.stderr ?? ((s) => process.stderr.write(s));
  try {
    if (argv.length !== 2 || argv[0] !== "--out" || !argv[1] || argv[1].startsWith("--")) throw new StoreRefusal("usage", "usage: chrome-package.mjs --out <dir>");
    const { inputs, digest, name } = runPackage({ env, out: resolve(argv[1]), ...(deps.runOptions ?? {}), log: (line) => out(line + "\n") });
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `zip-sha256=${digest}\n`);
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `## Chrome package\n\n| | |\n|---|---|\n| Mode | ${inputs.mode} |\n| Version | ${inputs.version} |\n| Commit | ${inputs.commit} |\n| File | ${name} |\n| Fingerprint (SHA-256) | \`${digest}\` |\n\nTo upload this exact package, start the workflow again with this commit, version and fingerprint.\n`,
      );
    out(`${digest}  ${name}\n`);
    return 0;
  } catch (error) {
    err(redact(`STOP (${error instanceof StoreRefusal ? error.code : "unexpected"}): ${error?.message ?? error}`) + "\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
