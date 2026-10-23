// Finds the newest DB-01 run of this workflow that still carries the keyed production baseline
// artifact, for DB-31 and DB-35 to compare against. Read-only: it lists runs and artifacts with
// the job's `actions: read` token and prints only the run id (a public number) to stdout.
// GitHub's branch/status-filtered run list has returned nothing while the unfiltered list held
// the baseline run (ISS-0120), so this lists runs unfiltered and selects locally. A missing
// baseline is a named failure, never a silent "no baseline" comparison.
import { realpathSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const WORKFLOW_PATH = ".github/workflows/supabase-readonly-checks.yml";
export const BASELINE_ARTIFACT = "qa-production-baseline";
const DB01_TITLE = "Read-only QA check DB-01 ";
const PER_PAGE = 100;
/** 1,000 runs; the artifact is kept 90 days, so an older baseline has expired anyway. */
const MAX_PAGES = 10;

export class BaselineError extends Error {}

/** The DB-01 runs that could hold the baseline, newest first. */
export function baselineCandidates(runs, repository) {
  return runs
    .filter((run) => Number.isSafeInteger(run?.id) && run.id > 0 &&
      run.path === WORKFLOW_PATH && run.head_branch === "main" && run.event === "workflow_dispatch" &&
      run.status === "completed" && run.conclusion === "success" &&
      typeof run.display_title === "string" && run.display_title.startsWith(DB01_TITLE) &&
      run.repository?.full_name === repository && run.head_repository?.full_name === repository)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
}

export async function findBaselineRun({ repository, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new BaselineError("repository-invalid");
  const get = async (path) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
        method: "GET", redirect: "error",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    } catch { throw new BaselineError("github-runs-unreadable"); }
    if (!response.ok) throw new BaselineError("github-runs-unreadable");
    return response.json();
  };
  const workflow = encodeURIComponent(WORKFLOW_PATH.split("/").pop());
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // Deliberately no branch, status or event filter (ISS-0120); selection happens below.
    const body = await get(`/actions/workflows/${workflow}/runs?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(body?.workflow_runs)) throw new BaselineError("github-runs-unreadable");
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < PER_PAGE || runs.length >= (body.total_count ?? Infinity)) break;
  }
  for (const run of baselineCandidates(runs, repository)) {
    const body = await get(`/actions/runs/${run.id}/artifacts?name=${BASELINE_ARTIFACT}&per_page=${PER_PAGE}`);
    if (!Array.isArray(body?.artifacts)) throw new BaselineError("github-runs-unreadable");
    if (body.artifacts.some((a) => a?.name === BASELINE_ARTIFACT && a.expired === false)) return run.id;
  }
  throw new BaselineError("baseline-not-found");
}

const REASONS = {
  "baseline-not-found": "no successful DB-01 run on main still carries the qa-production-baseline artifact; run DB-01 first",
  "github-runs-unreadable": "the workflow runs or their artifacts could not be read",
  "repository-invalid": "GITHUB_REPOSITORY is missing or malformed",
};

export async function main(env = process.env, fetchImpl = fetch) {
  let runId, reason;
  try { runId = await findBaselineRun({ repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN, fetchImpl }); }
  catch (error) { reason = error instanceof BaselineError ? error.message : "github-runs-unreadable"; }
  const text = runId
    ? `Production baseline: DB-01 run ${runId}`
    : `Production baseline: NOT found (${reason}: ${REASONS[reason]})`;
  // Only the run id goes to stdout, for the workflow to capture; the message goes to the log.
  console.error(runId ? text : `::error::${text}`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  if (!runId) return 1;
  console.log(String(runId));
  return 0;
}

/** True when `scriptPath` (process.argv[1]) is this module, through symlinks and percent-encoding. */
export function isEntryPoint(moduleUrl, scriptPath) {
  if (!scriptPath) return false;
  try { return moduleUrl === pathToFileURL(realpathSync(scriptPath)).href; }
  catch { return false; }
}

if (isEntryPoint(import.meta.url, process.argv[1])) process.exitCode = await main();
