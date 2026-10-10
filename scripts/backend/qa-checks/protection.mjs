// Read-only GitHub check, run inside the approved job before any database credential is used:
// the `supabase-readonly-checks` environment must be owner-only (exactly the owner as required
// reviewer, administrators cannot bypass, deployments from main only) and this run must carry the
// owner's approval. Reuses the production deploy's reviewed checker (scripts/backend/deploy).
// Usage: GH_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID set by Actions; prints no secret.
import { appendFile } from "node:fs/promises";
import { readProtection } from "../deploy/deploy.mjs";

export const READONLY_ENVIRONMENT = "supabase-readonly-checks";

export async function main(env = process.env, fetchImpl = fetch) {
  let result;
  try {
    result = await readProtection({
      fetchImpl,
      repository: env.GITHUB_REPOSITORY,
      token: env.GH_TOKEN,
      runId: env.GITHUB_RUN_ID,
      includeApprovals: true,
      name: READONLY_ENVIRONMENT,
    });
  } catch {
    result = { ok: false, issues: ["github-settings-unreadable"], warnings: [] };
  }
  const text = [
    `## GitHub protection for \`${READONLY_ENVIRONMENT}\`: ${result.ok ? "verified" : "NOT verified"}`,
    ...result.issues.map((i) => `- ${i}`),
    ...result.warnings.map((w) => `- warning: ${w}`),
    "",
  ].join("\n");
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
