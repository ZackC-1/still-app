// Structural guards for the production deploy workflow. These parse the real YAML; they do not
// prove GitHub's runtime behavior, which the owner verifies in repository settings (gate G1).
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parsers } from "prettier/plugins/yaml";
import {
  CLI_TARBALL_SHA256,
  CLI_VERSION,
  ENVIRONMENT_NAME,
  TOOLING_PATHS,
} from "./deploy.mjs";

const WORKFLOWS = new URL("../../../.github/workflows/", import.meta.url);
const DEPLOY = "supabase-production-deploy.yml";

function value(node) {
  assert.equal(node.anchor ?? null, null);
  assert.equal(node.tag ?? null, null);
  if (node.type === "mapping" || node.type === "flowMapping") {
    return Object.fromEntries(
      node.children.map(({ children: [k, v] }) => [value(k), value(v)]),
    );
  }
  if (node.type === "sequence" || node.type === "flowSequence")
    return node.children.map(value);
  if (
    [
      "plain",
      "quoteDouble",
      "quoteSingle",
      "blockLiteral",
      "blockFolded",
    ].includes(node.type)
  )
    return node.value;
  if (
    [
      "mappingKey",
      "mappingValue",
      "sequenceItem",
      "flowSequenceItem",
      "documentBody",
    ].includes(node.type)
  ) {
    assert.ok(node.children.length <= 1);
    return node.children.length ? value(node.children[0]) : null;
  }
  assert.fail(`Unsupported workflow node: ${node.type}`);
}

async function load(name) {
  const text = await readFile(new URL(name, WORKFLOWS), "utf8");
  return {
    text,
    workflow: value((await parsers.yaml.parse(text)).children[0].children[1]),
  };
}

test("deploy workflow runs only on manual dispatch, serialized, with read-only token", async () => {
  const { workflow } = await load(DEPLOY);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "commit",
    "functions",
    "migrations",
    "mode",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, "plan-only");
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
    "plan-only",
    "apply",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.functions.default, "");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "supabase-production-deploy",
    "cancel-in-progress": "false",
  });
  for (const job of Object.values(workflow.jobs)) {
    for (const level of Object.values(job.permissions ?? {}))
      assert.equal(level, "read");
    assert.match(job.if, /github\.event_name == 'workflow_dispatch'/);
    assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  }
});

test("every action in the deploy workflow is pinned to a full commit SHA", async () => {
  const { workflow } = await load(DEPLOY);
  const uses = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.filter((s) => s.uses).map((s) => s.uses),
  );
  assert.ok(uses.length >= 5);
  for (const ref of uses)
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(checkout.with["persist-credentials"], "false");
    assert.equal(checkout.with.ref, "${{ github.sha }}");
  }
});

test("only the approved apply job is bound to the environment and sees the one secret", async () => {
  const { text, workflow } = await load(DEPLOY);
  const { plan, apply } = workflow.jobs;
  assert.deepEqual(Object.keys(workflow.jobs), ["plan", "apply"]);
  assert.equal(plan.environment, undefined);
  assert.equal(apply.environment, ENVIRONMENT_NAME);
  assert.equal(apply.needs, "plan");
  assert.match(apply.if, /inputs\.mode == 'apply'/);
  assert.match(apply.if, /needs\.plan\.outputs\.environment-ready == 'true'/);
  assert.deepEqual(
    [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]),
    ["SUPABASE_PRODUCTION_DB_URL"],
  );
  const secretSteps = apply.steps.filter((s) =>
    JSON.stringify(s).includes("secrets."),
  );
  assert.equal(secretSteps.length, 1);
  const applyStep = apply.steps.find((s) => s.id === "apply");
  assert.equal(
    secretSteps[0],
    applyStep,
    "the secret reaches only the apply step",
  );
  assert.equal(applyStep["timeout-minutes"], "10");
  assert.match(
    applyStep.run,
    /--receipt "\$RUNNER_TEMP\/deploy-receipt\.json"/,
  );
  // The always-run closing record follows it, holds no secret and reads only the receipt.
  const closing = apply.steps.at(-1);
  assert.equal(apply.steps.indexOf(applyStep), apply.steps.length - 2);
  assert.equal(closing.if, "always()");
  assert.deepEqual(closing.env, {
    APPLY_OUTCOME: "${{ steps.apply.outcome }}",
    JOB_STATUS: "${{ job.status }}",
  });
  assert.match(closing.run, /deploy\.mjs final-summary --receipt/);
  assert.deepEqual(Object.keys(secretSteps[0].env), ["SUPABASE_DB_URL"]);
  assert.match(secretSteps[0].run, /deploy\.mjs apply /);
  assert.ok(!JSON.stringify(plan).includes("secrets."));
  assert.equal(
    apply.env.EXPECTED_PLAN_DIGEST,
    "${{ needs.plan.outputs.plan-digest }}",
  );
  assert.doesNotMatch(
    text,
    /pull_request_target|workflow_run|id-token|: write\b|SUPABASE_ACCESS_TOKEN/,
  );
});

test("untrusted inputs reach scripts only through environment variables", async () => {
  const { workflow } = await load(DEPLOY);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.run)
        assert.doesNotMatch(
          step.run,
          /\$\{\{/,
          `expression inside run: ${step.name}`,
        );
    }
    assert.equal(job.env.DEPLOY_SHA, "${{ inputs.commit }}");
    assert.equal(job.env.DEPLOY_MIGRATIONS, "${{ inputs.migrations }}");
    assert.equal(job.env.DEPLOY_FUNCTIONS, "${{ inputs.functions }}");
  }
});

test("both jobs install the same checksum-pinned CLI and re-derive the plan before any secret", async () => {
  const { workflow } = await load(DEPLOY);
  for (const job of Object.values(workflow.jobs)) {
    const install = job.steps.find((s) =>
      s.name?.startsWith("Install pinned Supabase CLI"),
    );
    assert.ok(
      install.run.includes(
        `/v${CLI_VERSION}/supabase_${CLI_VERSION}_linux_amd64.tar.gz`,
      ),
    );
    assert.ok(
      install.run.includes(
        `${CLI_TARBALL_SHA256}  $RUNNER_TEMP/supabase.tgz" | sha256sum -c -`,
      ),
    );
    assert.ok(
      job.steps.some((s) =>
        s.run?.includes(`test "$(supabase --version)" = '${CLI_VERSION}'`),
      ),
    );
  }
  const { plan, apply } = workflow.jobs;
  assert.match(
    plan.steps.find((s) => s.id === "plan").run,
    /deploy\.mjs plan --out/,
  );
  assert.match(plan.steps.find((s) => s.id === "protection").run, /--require/);
  assert.match(
    plan.steps.find((s) => s.run?.includes("replay.sh")).run,
    /replay\.sh "\$RUNNER_TEMP\/deploy-plan\.json"/,
  );
  const names = apply.steps.map((s) => s.run ?? "");
  const order = [
    "protection --phase apply --require",
    "--expect-digest",
    "sha256sum -c",
    "--stage full",
    "git fetch --no-tags --prune origin +refs/heads/main:refs/remotes/origin/main",
    "deploy.mjs freshness --plan",
    "deploy.mjs apply",
    "deploy.mjs final-summary",
  ].map((needle) => names.findIndex((r) => r.includes(needle)));
  assert.ok(
    order.every((i) => i >= 0),
    String(order),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "apply steps out of order",
  );
});

test("the plan digest binds the workflow and every deploy tool", async () => {
  assert.ok(TOOLING_PATHS.includes(`.github/workflows/${DEPLOY}`));
  for (const path of TOOLING_PATHS)
    await readFile(new URL(`../../../${path}`, import.meta.url));
});

test("no other workflow can reach the production database environment or its secret", async () => {
  for (const name of await readdir(WORKFLOWS)) {
    if (name === DEPLOY || !/\.ya?ml$/.test(name)) continue;
    const { text, workflow } = await load(name);
    for (const job of Object.values(workflow.jobs ?? {})) {
      const environment =
        typeof job.environment === "object"
          ? job.environment?.name
          : job.environment;
      assert.notEqual(
        String(environment ?? "").toLowerCase(),
        ENVIRONMENT_NAME,
        `${name} names ${ENVIRONMENT_NAME}`,
      );
    }
    assert.ok(!text.includes("SUPABASE_PRODUCTION_DB_URL"), name);
  }
});
