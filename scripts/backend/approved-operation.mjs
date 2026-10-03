import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  canonical,
  createOperationPlan,
  hash,
  validateSyntheticBaseline,
  verifyOperationPlan,
} from "./plan.mjs";

export function requireProductionAuthority() {
  // No production adapter, target, reconciled historical-content ledger, exact owner approval
  // or independently verified no-bypass configuration is available in this source slice.
  throw new Error(
    "Production operation unavailable: actual protected environment, no-bypass evidence, trusted target/baseline, rehearsal and exact owner approval required",
  );
}

function requireCloud(context) {
  if (
    context.githubActions !== true ||
    context.runnerEnvironment !== "github-hosted" ||
    context.platform !== "linux"
  ) {
    throw new Error(
      "Synthetic operation requires an ephemeral GitHub-hosted Linux runner",
    );
  }
}

export async function executeSyntheticOperation(
  root,
  suppliedPlan,
  context,
  adapter,
) {
  requireCloud(context);
  if (
    context.target !== "synthetic-github-runner" ||
    context.approvalKind !== "synthetic"
  )
    requireProductionAuthority();
  // Detach the preview from caller mutation while awaiting authoritative reads.
  const plan = structuredClone(suppliedPlan);
  const baseline = await adapter.read();
  if (context.runId !== baseline.runId)
    throw new Error("Run changed; new synthetic preview required");
  const verifySource = () =>
    verifyOperationPlan(root, plan, {
      revision: context.revision,
      target: context.target,
      baseline,
      digest: context.approvedDigest,
    });
  await verifySource();
  if ((await adapter.verify()) !== true)
    throw new Error("Authoritative baseline security verification unavailable");
  const completed = [];
  let expected = structuredClone(baseline);
  let attempted = null;
  try {
    for (const operation of plan.operations) {
      // Verify source before each write. SQL adapter independently locks and compares the full row.
      await verifySource();
      if (canonical(await adapter.read()) !== canonical(expected))
        throw new Error("Intervening state drift");
      const next = {
        ...expected,
        generation: expected.generation + 1,
        completed: [...expected.completed, operation.id],
      };
      attempted = operation.id;
      await adapter.apply(operation, expected, next);
      const actual = await adapter.read();
      if (
        canonical(actual) !== canonical(next) ||
        (await adapter.verify()) !== true
      )
        throw new Error("Authoritative post-apply verification failed");
      completed.push(operation.id);
      expected = next;
    }
    await verifySource();
    return {
      status: "verified",
      productionEvidence: false,
      digest: plan.digest,
      completed,
      observedStateDigest: hash(canonical(expected)),
      requiresReviewedForwardRepair: false,
    };
  } catch {
    // Never emit provider error text or claim the failed step was rolled back. Read actual state.
    let actual = null;
    let securityVerified = false;
    try {
      actual = await adapter.read();
      securityVerified = (await adapter.verify()) === true;
    } catch {
      /* unknown state requires review */
    }
    return {
      status: "stopped",
      productionEvidence: false,
      digest: plan.digest,
      completed,
      attempted,
      observedStateDigest: actual ? hash(canonical(actual)) : null,
      stateKnown: actual !== null,
      securityBoundaryObserved:
        actual?.securityBoundary === true && securityVerified,
      requiresReviewedForwardRepair: true,
    };
  }
}

// Read-only supported REST fields. This is evidence collection, never an approval service.
export async function readGitHubProtection(request, fetchImpl = fetch) {
  const {
    repository,
    environmentName,
    ownerReviewerId,
    runId,
    revision,
    digest,
  } = request;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[A-Za-z0-9_-]+$/.test(environmentName) ||
    !Number.isSafeInteger(ownerReviewerId) ||
    ownerReviewerId < 1 ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new Error("Invalid exact GitHub readback request");
  const base = `https://api.github.com/repos/${repository}`;
  const read = async (path) => {
    const response = await fetchImpl(`${base}${path}`, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
    if (!response.ok) throw new Error("GitHub protection readback unavailable");
    return response.json();
  };
  const environment = await read(
    `/environments/${encodeURIComponent(environmentName)}`,
  );
  const branches = await read(
    `/environments/${encodeURIComponent(environmentName)}/deployment-branch-policies?per_page=100`,
  );
  const run = await read(`/actions/runs/${runId}`);
  const approvals = await read(`/actions/runs/${runId}/approvals`);
  const rules = environment.protection_rules?.filter(
    (rule) => rule.type === "required_reviewers",
  );
  if (
    environment.name !== environmentName ||
    !Number.isSafeInteger(environment.id) ||
    rules?.length !== 1 ||
    rules[0].reviewers?.length !== 1 ||
    rules[0].reviewers[0].type !== "User" ||
    rules[0].reviewers[0].reviewer?.id !== ownerReviewerId ||
    environment.deployment_branch_policy?.protected_branches !== false ||
    environment.deployment_branch_policy?.custom_branch_policies !== true ||
    branches.total_count !== 1 ||
    branches.branch_policies?.length !== 1 ||
    branches.branch_policies[0].name !== "main" ||
    branches.branch_policies[0].type !== "branch" ||
    run.id !== runId ||
    run.head_sha !== revision ||
    run.head_branch !== "main" ||
    run.event !== "workflow_dispatch" ||
    run.repository?.full_name !== repository ||
    !Number.isSafeInteger(run.actor?.id) ||
    !Array.isArray(approvals)
  ) {
    throw new Error(
      "Required owner review, branch or exact run binding unavailable",
    );
  }
  const relevant = approvals.filter((approval) =>
    approval.environments?.some((env) => env.id === environment.id),
  );
  if (
    relevant.length !== 1 ||
    relevant[0].state !== "approved" ||
    relevant[0].user?.id !== ownerReviewerId ||
    relevant[0].comment !== `CP033 ${digest}`
  ) {
    throw new Error("Exact owner approval unavailable");
  }
  return {
    requiredReviewerObserved: true,
    exactRunApprovalObserved: true,
    preventSelfReviewObserved: rules[0].prevent_self_review === true,
    adminBypassVerified: false,
    productionReady: false,
    reason:
      "Documented REST fields do not establish disabled administrator bypass; production authority remains unavailable",
  };
}

// Fixed synthetic SQL adapter. No URL, SQL, file, command, function name or credentials from callers.
function command(binary, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.resume(); // errors may contain connection details; never forward them
    child.on("error", () => reject(new Error("Synthetic command unavailable")));
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error("Synthetic command failed")),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const sql = (input) =>
  command(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_still-app",
      "psql",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-X",
      "-qAt",
      "--set=ON_ERROR_STOP=1",
    ],
    input,
  );
const stop = () =>
  command("supabase", ["stop", "--project-id", "still-app", "--no-backup"]);

async function cleanupSynthetic() {
  let cleanupFailed = false;
  try {
    await stop();
  } catch {
    cleanupFailed = true;
  }
  const containers = await command("docker", [
    "ps",
    "-a",
    "--filter",
    "name=^/supabase_db_still-app$",
    "--format",
    "{{.ID}}",
  ]);
  const volumes = await command("docker", [
    "volume",
    "ls",
    "--filter",
    "name=^supabase_db_still-app$",
    "--format",
    "{{.Name}}",
  ]);
  if (cleanupFailed || containers || volumes)
    throw new Error("Synthetic cleanup not verified");
}

async function cloudSynthetic(root) {
  const context = {
    githubActions: process.env.GITHUB_ACTIONS === "true",
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
    platform: process.platform,
    target: "synthetic-github-runner",
    approvalKind: "synthetic",
    runId: `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`,
  };
  requireCloud(context);
  context.revision = await command("git", ["rev-parse", "HEAD"]);
  const initial = {
    kind: "synthetic-sql-fixture",
    target: context.target,
    runId: context.runId,
    generation: 0,
    securityBoundary: true,
    completed: [],
  };
  validateSyntheticBaseline(initial);
  const receipts = [];
  try {
    await command("supabase", [
      "start",
      "--exclude",
      "gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor",
    ]);
    await command("supabase", ["db", "reset", "--local", "--no-seed"]);
    // This table is solely a cloud fixture. It is not a production deployment ledger.
    await sql(
      "CREATE SCHEMA cp033_fixture; CREATE TABLE cp033_fixture.state (id int primary key CHECK (id=1), payload jsonb NOT NULL); REVOKE ALL ON SCHEMA cp033_fixture FROM PUBLIC; REVOKE ALL ON cp033_fixture.state FROM PUBLIC;",
    );
    const reset = () =>
      sql(
        `DELETE FROM cp033_fixture.state; INSERT INTO cp033_fixture.state VALUES (1, '${canonical(initial)}'::jsonb);`,
      );
    const read = async () =>
      JSON.parse(
        await sql("SELECT payload::text FROM cp033_fixture.state WHERE id=1;"),
      );
    let failSecond = false;
    let driftBeforeApply = false;
    const adapter = {
      read,
      apply: async (operation, expected, next) => {
        validateSyntheticBaseline(expected);
        validateSyntheticBaseline(next);
        if (driftBeforeApply) {
          driftBeforeApply = false;
          // Inject an independent write after the runner read but before its locked CAS.
          await sql(
            `UPDATE cp033_fixture.state SET payload='${canonical(next)}'::jsonb WHERE id=1;`,
          );
        }
        await sql(`BEGIN; SELECT id FROM cp033_fixture.state WHERE id=1 FOR UPDATE;
DO $$ BEGIN IF (SELECT payload FROM cp033_fixture.state WHERE id=1) IS DISTINCT FROM '${canonical(expected)}'::jsonb THEN RAISE EXCEPTION 'CAS drift'; END IF; END $$;
UPDATE cp033_fixture.state SET payload='${canonical(next)}'::jsonb WHERE id=1;
${failSecond && operation.id === "record-verification" ? "SELECT 1/0;" : ""}
COMMIT;`);
      },
      verify: async () =>
        (await sql(
          "SELECT ((payload->>'securityBoundary')::boolean AND NOT has_schema_privilege('anon','cp033_fixture','USAGE') AND NOT has_schema_privilege('authenticated','cp033_fixture','USAGE') AND NOT has_table_privilege('anon','cp033_fixture.state','UPDATE') AND NOT has_table_privilege('authenticated','cp033_fixture.state','UPDATE'))::text FROM cp033_fixture.state WHERE id=1;",
        )) === "true",
    };
    const execute = async () => {
      const plan = await createOperationPlan(root, {
        revision: context.revision,
        target: context.target,
        baseline: await read(),
      });
      process.stdout.write(
        `${JSON.stringify({ kind: "synthetic-preview", productionEvidence: false, plan })}\n`,
      );
      // Simulation only: no real owner approval and no production protection claim.
      return executeSyntheticOperation(
        root,
        plan,
        { ...context, approvedDigest: plan.digest },
        adapter,
      );
    };
    await reset();
    receipts.push(await execute());
    if (receipts[0].status !== "verified")
      throw new Error("Synthetic positive control failed");
    await reset();
    failSecond = true;
    receipts.push(await execute());
    if (
      receipts[1].status !== "stopped" ||
      !receipts[1].securityBoundaryObserved ||
      (await read()).generation !== 1
    )
      throw new Error("Synthetic partial failure control failed");
    // A separate newly previewed synthetic repair binds the actual retained partial state.
    failSecond = false;
    receipts.push(await execute());
    if (receipts[2].status !== "verified" || (await adapter.verify()) !== true)
      throw new Error("Synthetic forward repair failed");
    await reset();
    driftBeforeApply = true;
    receipts.push(await execute());
    if (
      receipts[3].status !== "stopped" ||
      receipts[3].completed.length !== 0 ||
      (await read()).generation !== 1
    )
      throw new Error("Synthetic SQL CAS drift rejection failed");
  } finally {
    // Assert removal rather than treating a stop exit status as sufficient readback.
    await cleanupSynthetic();
  }
  return {
    kind: "cloud-synthetic-only",
    productionEvidence: false,
    cleanupVerified: true,
    receipts,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3)
      throw new Error("Use cloud-synthetic or production-unavailable");
    if (process.argv[2] === "production-unavailable")
      requireProductionAuthority();
    else if (process.argv[2] === "cloud-synthetic")
      process.stdout.write(
        `${JSON.stringify(await cloudSynthetic(process.cwd()))}\n`,
      );
    else throw new Error("Use cloud-synthetic or production-unavailable");
  } catch {
    process.stderr.write(
      "Exact operation unavailable or failed; no production action performed. Review required.\n",
    );
    process.exitCode = 1;
  }
}
