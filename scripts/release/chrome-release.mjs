#!/usr/bin/env node
// The privileged half of the Chrome release workflow (.github/workflows/release-chrome.yml).
// Every command here runs only after the owner has approved the run in the `chrome-release`
// environment. Nothing in this file creates, stores or reads a key: the Google token arrives in
// CWS_ACCESS_TOKEN from keyless sign-in, lives for minutes, and is never printed.
//
//   node scripts/release/chrome-release.mjs check-inputs
//   node scripts/release/chrome-release.mjs protection
//   node scripts/release/chrome-release.mjs verify-artifact --dir <work>
//   node scripts/release/chrome-release.mjs preflight      --dir <work>   (read-only token)
//   node scripts/release/chrome-release.mjs upload         --dir <work>   (write token)
//   node scripts/release/chrome-release.mjs submit         --dir <work>   (write token)
//   node scripts/release/chrome-release.mjs receipt        --dir <work>
//
// Inputs come only from environment variables (never from command-line text built by the workflow):
//   RELEASE_MODE, RELEASE_COMMIT, RELEASE_VERSION, RELEASE_ZIP_SHA256, RELEASE_CONFIRM_SUBMIT
//   PACKAGE_ZIP_SHA256            the fingerprint the unprivileged build job computed
//   CWS_PUBLISHER_ID, CWS_EXTENSION_ID, CWS_ACCESS_TOKEN, GH_TOKEN, and GitHub's own GITHUB_* values
//
// Node built-ins and ./chrome-store.mjs only: no npm package ever loads in the job holding the token.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStoreClient, decidePreflight, parseChromeVersion, redact, StoreRefusal, summarizeStatus } from "./chrome-store.mjs";

export const EXPECTED = Object.freeze({
  repository: "ZackC-1/still-app",
  repositoryId: "1278502679",
  ownerId: 257643931,
  environment: "chrome-release",
  workflowPath: ".github/workflows/release-chrome.yml",
  ref: "refs/heads/main",
});
export const MODES = Object.freeze(["package-only", "status", "upload", "upload-and-submit"]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const zipName = (version) => `still-chrome-${version}.zip`;

/** Validate the dispatch inputs. Returns them normalized; throws StoreRefusal on anything off. */
export function checkInputs(env) {
  const mode = env.RELEASE_MODE ?? "";
  if (!MODES.includes(mode)) throw new StoreRefusal("input-invalid", `mode must be one of ${MODES.join(", ")}`);
  const commit = env.RELEASE_COMMIT ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new StoreRefusal("input-invalid", "commit must be a full 40-character lowercase commit SHA");
  const version = env.RELEASE_VERSION ?? "";
  if (!SEMVER.test(version)) throw new StoreRefusal("input-invalid", "version must look like 2.2.0");
  parseChromeVersion(version);
  const zipSha256 = env.RELEASE_ZIP_SHA256 ?? "";
  if (zipSha256 !== "" && !/^[0-9a-f]{64}$/.test(zipSha256)) throw new StoreRefusal("input-invalid", "chrome_zip_sha256 must be 64 lowercase hex characters");
  if (mode !== "package-only" && zipSha256 === "")
    throw new StoreRefusal("input-invalid", "chrome_zip_sha256 is required for this mode; run package-only first and copy the fingerprint it prints");
  const confirm = env.RELEASE_CONFIRM_SUBMIT ?? "";
  if (mode === "upload-and-submit" && confirm !== `submit ${version}`)
    throw new StoreRefusal("input-invalid", `To submit for review, type exactly: submit ${version}`);
  if (mode !== "upload-and-submit" && confirm !== "")
    throw new StoreRefusal("input-invalid", "confirm_submit is only used with upload-and-submit; leave it empty");
  return { mode, commit, version, zipSha256, confirm };
}

/** The run must be the real workflow, started by hand, on main, in this repository. */
export function checkRunContext(env) {
  const problems = [];
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") problems.push("not started by hand (workflow_dispatch)");
  if (env.GITHUB_REF !== EXPECTED.ref) problems.push("not running on main");
  if (env.GITHUB_REPOSITORY !== EXPECTED.repository || env.GITHUB_REPOSITORY_ID !== EXPECTED.repositoryId) problems.push("not the Still repository");
  if (env.GITHUB_REPOSITORY_OWNER_ID !== String(EXPECTED.ownerId)) problems.push("repository owner differs");
  if (env.GITHUB_WORKFLOW_REF !== `${EXPECTED.repository}/${EXPECTED.workflowPath}@${EXPECTED.ref}`) problems.push("not the release-chrome workflow on main");
  if (problems.length) throw new StoreRefusal("run-context", `Refusing to run: ${problems.join("; ")}`);
}

/**
 * The approval environment must still require exactly the owner, with no admin bypass, and only
 * main (or protected branches, which the Google trust narrows to main anyway) may deploy to it.
 * When approvals are given, every approval for this environment in this run must be the owner's.
 */
export function checkEnvironmentProtection({ environment, branches, approvals }) {
  const issues = [];
  if (!environment || environment.name !== EXPECTED.environment || !Number.isSafeInteger(environment.id)) return ["environment-missing"];
  const rules = Array.isArray(environment.protection_rules) ? environment.protection_rules : [];
  const reviewers = rules.filter((r) => r?.type === "required_reviewers");
  const people = reviewers[0]?.reviewers;
  if (reviewers.length !== 1 || !Array.isArray(people) || people.length !== 1 || people[0]?.type !== "User" || people[0]?.reviewer?.id !== EXPECTED.ownerId)
    issues.push("required-reviewer-not-exactly-owner");
  if (environment.can_admins_bypass !== false) issues.push("admin-bypass-not-disabled");
  const policy = environment.deployment_branch_policy;
  const protectedOnly = policy?.protected_branches === true && policy?.custom_branch_policies === false;
  const allowed = branches?.branch_policies;
  const mainOnly =
    policy?.protected_branches === false &&
    policy?.custom_branch_policies === true &&
    branches?.total_count === 1 &&
    Array.isArray(allowed) &&
    allowed.length === 1 &&
    allowed[0]?.name === "main" &&
    (allowed[0]?.type ?? "branch") === "branch";
  if (!protectedOnly && !mainOnly) issues.push("deployment-branches-not-restricted");
  if (approvals !== undefined) {
    const relevant = Array.isArray(approvals) ? approvals.filter((a) => a?.environments?.some((e) => e?.id === environment.id)) : [];
    if (relevant.length < 1 || relevant.some((a) => a.state !== "approved" || a.user?.id !== EXPECTED.ownerId)) issues.push("owner-approval-not-observed");
  }
  return issues;
}

/**
 * The Google trust accepts only the classic subject `repo:ZackC-1/still-app:environment:chrome-release`.
 * A repository rename or opting into GitHub's immutable subjects changes it and breaks sign-in.
 */
export function checkSubjectCustomization(sub) {
  if (!sub || sub.use_default !== true || sub.use_immutable_subject === true) return ["oidc-subject-changed"];
  if (sub.sub_claim_prefix !== undefined && sub.sub_claim_prefix !== `repo:${EXPECTED.repository}`) return ["oidc-subject-changed"];
  return [];
}

async function readProtection({ fetchImpl, env }) {
  const base = `https://api.github.com/repos/${EXPECTED.repository}`;
  const get = async (path) => {
    const response = await fetchImpl(`${base}${path}`, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(env.GH_TOKEN ? { Authorization: `Bearer ${env.GH_TOKEN}` } : {}) },
    });
    if (response.status === 404) return { missing: true };
    if (!response.ok) return { unavailable: response.status };
    return { json: await response.json() };
  };
  const environment = await get(`/environments/${EXPECTED.environment}`);
  if (environment.unavailable) throw new StoreRefusal("github-unavailable", "GitHub approval settings could not be read");
  const runId = Number(env.GITHUB_RUN_ID);
  if (!Number.isSafeInteger(runId) || runId < 1) throw new StoreRefusal("run-context", "No run id");
  let branches;
  const policy = environment.json?.deployment_branch_policy;
  if (policy?.custom_branch_policies === true) {
    const result = await get(`/environments/${EXPECTED.environment}/deployment-branch-policies?per_page=100`);
    if (result.unavailable) throw new StoreRefusal("github-unavailable", "GitHub branch rules could not be read");
    branches = result.json;
  }
  const approvals = await get(`/actions/runs/${runId}/approvals`);
  if (approvals.unavailable) throw new StoreRefusal("github-unavailable", "This run's approvals could not be read");
  const issues = checkEnvironmentProtection({ environment: environment.json ?? null, branches, approvals: approvals.json ?? [] });
  const warnings = [];
  const sub = await get("/actions/oidc/customization/sub");
  // Google enforces the subject itself; this read only turns a confusing sign-in failure into a clear
  // message. If GitHub will not show it, carry on and let Google decide.
  if (sub.json) issues.push(...checkSubjectCustomization(sub.json));
  else warnings.push("the OIDC subject setting could not be read; Google's own check still applies");
  return { issues, warnings };
}

/** The downloaded package must be byte-for-byte the one the build job fingerprinted and the owner named. */
export function verifyArtifact({ dir, inputs, packageSha256 }) {
  const name = zipName(inputs.version);
  const zipPath = join(dir, name);
  const sumsPath = join(dir, "SHA256SUMS.json");
  if (!existsSync(zipPath) || !existsSync(sumsPath)) throw new StoreRefusal("package-missing", `The build job's ${name} or SHA256SUMS.json is missing`);
  const bytes = readFileSync(zipPath);
  const actual = sha256(bytes);
  const sums = JSON.parse(readFileSync(sumsPath, "utf8"));
  if (sums.version !== inputs.version) throw new StoreRefusal("package-mismatch", `SHA256SUMS.json is for ${sums.version}, not ${inputs.version}`);
  if (sums.files?.[name]?.sha256 !== actual) throw new StoreRefusal("package-mismatch", "The package does not match its own SHA256SUMS.json");
  if (actual !== packageSha256) throw new StoreRefusal("package-mismatch", "The package changed between the build job and this job");
  if (actual !== inputs.zipSha256) throw new StoreRefusal("package-mismatch", "The package does not match the approved fingerprint (chrome_zip_sha256)");
  return { bytes, sha256: actual };
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** Read the store's status and decide. Writes preflight.json. Reads only. */
export async function runPreflight({ client, inputs, dir }) {
  const summary = summarizeStatus(await client.fetchStatus());
  const decision = decidePreflight(summary, inputs.version);
  const result = {
    action: decision.action,
    note: decision.note,
    publishedVersion: summary.published?.version ?? null,
    publishedState: summary.published?.state ?? null,
    submittedVersion: summary.submitted?.version ?? null,
    submittedState: summary.submitted?.state ?? null,
  };
  writeFileSync(join(dir, "preflight.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

/** Upload the verified bytes once, then wait (reading only) if the store is still processing them. */
export async function runUpload({ client, inputs, dir, bytes }) {
  if (inputs.mode !== "upload" && inputs.mode !== "upload-and-submit") throw new StoreRefusal("mode", "This mode does not upload");
  const preflight = readJson(join(dir, "preflight.json"));
  if (preflight?.action !== "proceed") throw new StoreRefusal("preflight-not-passed", "The store check did not clear this version for upload");
  const first = await client.upload(bytes);
  let state = first.state;
  if (state === "IN_PROGRESS") state = await client.waitForUpload();
  const result = { state, crxVersion: first.crxVersion, versionConfirmed: first.crxVersion === inputs.version };
  writeFileSync(join(dir, "upload.json"), JSON.stringify(result, null, 2) + "\n");
  if (first.crxVersion !== null && first.crxVersion !== inputs.version)
    throw new StoreRefusal("store-version-mismatch", `The store read version ${first.crxVersion} from the package, not ${inputs.version}. Nothing will be submitted.`);
  if (state === "IN_PROGRESS") throw new StoreRefusal("upload-still-processing", "The store is still processing the upload. Run status later; do not upload again.");
  if (state !== "SUCCEEDED") throw new StoreRefusal("upload-failed", `The upload did not succeed (${state ?? "no state"}).`);
  return result;
}

/** Submit for review, once, only with the typed confirmation, then read back what the store holds. */
export async function runSubmit({ client, inputs, dir }) {
  if (inputs.mode !== "upload-and-submit" || inputs.confirm !== `submit ${inputs.version}`) throw new StoreRefusal("mode", "Submitting needs upload-and-submit and the typed confirmation");
  const upload = readJson(join(dir, "upload.json"));
  if (upload?.state !== "SUCCEEDED") throw new StoreRefusal("upload-not-done", "There is no successful upload from this run to submit");
  const outcome = await client.submit();
  const after = summarizeStatus(await client.fetchStatus());
  const held = after.submitted?.version ?? after.published?.version ?? null;
  const result = { state: outcome.state, warnings: outcome.warnings, versionInStore: held };
  writeFileSync(join(dir, "submit.json"), JSON.stringify(result, null, 2) + "\n");
  if (outcome.state !== "PENDING_REVIEW" && outcome.state !== "PUBLISHED")
    throw new StoreRefusal("submit-unexpected-state", `After submitting, the store reports ${outcome.state}. The owner checks the dashboard.`);
  if (held !== inputs.version)
    throw new StoreRefusal("store-version-mismatch", `The store now holds ${held ?? "no version"} for review, not ${inputs.version}. The owner checks the dashboard and cancels the review there if needed.`);
  return result;
}

/** A closing record with an allowlist of fields. No token, no publisher ID, no raw store response. */
export function buildReceipt({ inputs, extensionId, dir, outcome }) {
  const preflight = readJson(join(dir, "preflight.json"));
  const upload = readJson(join(dir, "upload.json"));
  const submit = readJson(join(dir, "submit.json"));
  return {
    mode: inputs?.mode ?? null,
    commit: inputs?.commit ?? null,
    version: inputs?.version ?? null,
    chromeZipSha256: inputs?.zipSha256 || null,
    extensionId: typeof extensionId === "string" && /^[a-p]{32}$/.test(extensionId) ? extensionId : null,
    preflight: preflight && {
      action: preflight.action,
      publishedVersion: preflight.publishedVersion,
      publishedState: preflight.publishedState,
      submittedVersion: preflight.submittedVersion,
      submittedState: preflight.submittedState,
    },
    upload: upload && { state: upload.state, crxVersion: upload.crxVersion, versionConfirmed: upload.versionConfirmed },
    submit: submit && { state: submit.state, warnings: submit.warnings, versionInStore: submit.versionInStore },
    outcome: outcome || "unknown",
    finishedAt: new Date().toISOString(),
  };
}

function summaryMarkdown(receipt) {
  const rows = [
    ["Mode", receipt.mode],
    ["Version", receipt.version],
    ["Commit", receipt.commit],
    ["Package fingerprint (SHA-256)", receipt.chromeZipSha256],
    ["Store check", receipt.preflight ? `${receipt.preflight.action} (published ${receipt.preflight.publishedVersion ?? "none"}, in review ${receipt.preflight.submittedVersion ?? "none"})` : "not run"],
    ["Upload", receipt.upload ? `${receipt.upload.state}${receipt.upload.crxVersion ? `, store read ${receipt.upload.crxVersion}` : ""}` : "not run"],
    ["Submitted for review", receipt.submit ? `${receipt.submit.state}${receipt.submit.warnings?.length ? `, warnings: ${receipt.submit.warnings.join(", ")}` : ""}` : "no"],
    ["Job outcome", receipt.outcome],
  ];
  return `## Chrome Web Store release\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${String(v ?? "").replace(/\|/g, "/")} |`).join("\n")}\n`;
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Run one command. `deps` lets tests supply env, a fake fetch and output sinks; the real entry point
 * passes process values. Returns the exit code; never throws.
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const err = deps.stderr ?? ((s) => process.stderr.write(s));
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const secrets = [env.CWS_ACCESS_TOKEN, env.CWS_PUBLISHER_ID, env.GH_TOKEN];
  const say = (line) => out(redact(line, secrets).slice(0, 600) + "\n");
  const setOutput = (key, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  const [command, ...rest] = argv;
  const known = ["check-inputs", "protection", "verify-artifact", "preflight", "upload", "submit", "receipt"];
  try {
    if (!known.includes(command)) throw new StoreRefusal("usage", `usage: chrome-release.mjs <${known.join("|")}> [--dir <work>]`);
    const dirArg = argValue(rest, "--dir");
    if (!(rest.length === 0 || (rest.length === 2 && rest[0] === "--dir" && dirArg && !dirArg.startsWith("--")))) throw new StoreRefusal("usage", "Only --dir <work> is accepted");
    const dir = dirArg && resolve(dirArg);
    if (command !== "check-inputs" && command !== "protection" && !dir) throw new StoreRefusal("usage", "--dir is required");
    // Mask the publisher ID in what GitHub prints AFTER this line. Its first appearance, in the env
    // list GitHub shows at the top of the first step that receives it, is printed unmasked; that is
    // accepted because it is an identifier, not a credential (see docs/release/chrome-publish-workflow.md).
    if (env.GITHUB_ACTIONS === "true" && env.CWS_PUBLISHER_ID) out(`::add-mask::${env.CWS_PUBLISHER_ID}\n`);

    if (command === "receipt") {
      let inputs = null;
      try {
        inputs = checkInputs(env);
      } catch {
        // A receipt is still written for a run whose inputs were refused.
      }
      const receipt = buildReceipt({ inputs, extensionId: env.CWS_EXTENSION_ID, dir, outcome: env.JOB_STATUS });
      const text = JSON.stringify(receipt, null, 2) + "\n";
      const markdown = summaryMarkdown(receipt);
      // The receipt is built from an allowlist, so this cannot trigger; it is the last line of defence.
      for (const secret of secrets) if (typeof secret === "string" && secret.length >= 4 && (text.includes(secret) || markdown.includes(secret))) throw new StoreRefusal("receipt-leak", "The receipt would contain a secret value; not written");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "receipt.json"), text);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
      say(`Receipt written: ${receipt.outcome}`);
      return 0;
    }

    const inputs = checkInputs(env);
    if (command === "check-inputs") {
      checkRunContext(env);
      say(`Inputs accepted: ${inputs.mode} ${inputs.version} at ${inputs.commit}`);
      return 0;
    }
    checkRunContext(env);
    if (inputs.mode === "package-only") throw new StoreRefusal("mode", "package-only never reaches the store job");

    if (command === "protection") {
      const { issues, warnings } = await readProtection({ fetchImpl, env });
      for (const w of warnings) say(`Note: ${w}`);
      if (issues.length) throw new StoreRefusal("protection", `Release safeguards differ from what was approved: ${issues.join(", ")}`);
      say("Approval safeguards verified: owner-only review, no admin bypass, restricted branches, owner approved this run.");
      return 0;
    }
    if (command === "verify-artifact") {
      const { sha256: digest } = verifyArtifact({ dir: join(dir, "package"), inputs, packageSha256: env.PACKAGE_ZIP_SHA256 ?? "" });
      say(`Package verified: ${zipName(inputs.version)} ${digest}`);
      return 0;
    }

    const client = createStoreClient({ fetchImpl, token: env.CWS_ACCESS_TOKEN, publisherId: env.CWS_PUBLISHER_ID, itemId: env.CWS_EXTENSION_ID, ...(deps.clientOptions ?? {}) });
    if (command === "preflight") {
      const result = await runPreflight({ client, inputs, dir });
      setOutput("action", result.action);
      say(`Store check: ${result.action}. ${result.note}`);
      return 0;
    }
    if (command === "upload") {
      const { bytes } = verifyArtifact({ dir: join(dir, "package"), inputs, packageSha256: env.PACKAGE_ZIP_SHA256 ?? "" });
      const result = await runUpload({ client, inputs, dir, bytes });
      setOutput("uploaded", "true");
      say(`Uploaded as a draft: ${result.state}${result.versionConfirmed ? `, store read ${result.crxVersion}` : ", the store did not echo a version (bytes are bound by the fingerprint)"}.`);
      return 0;
    }
    const result = await runSubmit({ client, inputs, dir });
    say(`Submitted for review: ${result.state}. The store holds ${result.versionInStore}.`);
    return 0;
  } catch (error) {
    const code = error instanceof StoreRefusal ? error.code : "unexpected";
    err(redact(`STOP (${code}): ${error?.message ?? error}`, secrets) + "\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
