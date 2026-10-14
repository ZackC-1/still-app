// The dedicated QA checker has two owner-configured authorization modes. This module never
// changes GitHub settings. Production deployment protection remains in deploy/deploy.mjs.
import { appendFile } from "node:fs/promises";
import { readProtection } from "../deploy/deploy.mjs";

export const READONLY_ENVIRONMENT = "supabase-readonly-checks";
const WORKFLOW_PATH = ".github/workflows/supabase-readonly-checks.yml";

async function verify(env, fetchImpl) {
  const mode = env.STILL_QA_READONLY_AUTHORIZATION || "per-run";
  if (mode !== "per-run" && mode !== "standing-v1") return refusal("authorization-mode-invalid");
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_WORKFLOW_REF !== `${repository}/${WORKFLOW_PATH}@refs/heads/main`) {
    return refusal("dedicated-main-workflow-required");
  }
  const get = async (path) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method: "GET", redirect: "error",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(env.GH_TOKEN ? { Authorization: `Bearer ${env.GH_TOKEN}` } : {}) },
    });
    if (!response.ok) throw new Error("github-settings-unreadable");
    return response.json();
  };
  const run = await get(`/actions/runs/${env.GITHUB_RUN_ID}`);
  if (run.path !== WORKFLOW_PATH || run.head_branch !== "main" || run.head_sha !== env.GITHUB_SHA ||
    run.event !== "workflow_dispatch" || run.run_attempt !== Number(env.GITHUB_RUN_ATTEMPT) ||
    run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    return refusal("run-identity-mismatch");
  }
  if (mode === "per-run") {
    return readProtection({ fetchImpl, repository, token: env.GH_TOKEN,
      runId: env.GITHUB_RUN_ID, includeApprovals: true, name: READONLY_ENVIRONMENT });
  }
  // No synthetic approval or relaxed production checker: standing mode has its own narrow proof.
  const environment = await get(`/environments/${READONLY_ENVIRONMENT}`);
  if (environment.name !== READONLY_ENVIRONMENT || !Number.isSafeInteger(environment.id))
    return refusal("environment-missing");
  // GitHub includes branch_policy here even without reviewer/wait/custom gates.
  // Its exact main-only configuration is independently checked below.
  if (!Array.isArray(environment.protection_rules) || environment.protection_rules.some(rule => rule.type !== "branch_policy"))
    return refusal("standing-environment-still-gated");
  if (environment.can_admins_bypass !== false) return refusal("admin-bypass-not-disabled");
  const branches = await get(`/environments/${READONLY_ENVIRONMENT}/deployment-branch-policies?per_page=100`);
  if (environment.deployment_branch_policy?.custom_branch_policies !== true ||
    environment.deployment_branch_policy?.protected_branches !== false ||
    branches.total_count !== 1 || !Array.isArray(branches.branch_policies) || branches.branch_policies.length !== 1 ||
    branches.branch_policies[0].name !== "main" || branches.branch_policies[0].type !== "branch") {
    return refusal("deployment-branches-not-main-only");
  }
  return { ok: true, issues: [], warnings: [] };
}
function refusal(issue) { return { ok: false, issues: [issue], warnings: [] }; }

export async function main(env = process.env, fetchImpl = fetch) {
  let result;
  try { result = await verify(env, fetchImpl); }
  catch { result = refusal("github-settings-unreadable"); }
  const mode = env.STILL_QA_READONLY_AUTHORIZATION === "standing-v1" ? "standing-v1" : "per-run";
  const text = [
    `## GitHub protection for \`${READONLY_ENVIRONMENT}\`: ${result.ok ? "verified" : "NOT verified"}`,
    `Authorization: ${mode}. Initiator and QA input scope are recorded in this GitHub run.`,
    ...result.issues.map((i) => `- ${i}`),
    ...result.warnings.map((w) => `- warning: ${w}`), "",
  ].join("\n");
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
