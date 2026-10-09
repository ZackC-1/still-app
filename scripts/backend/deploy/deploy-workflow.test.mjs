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
import {
  OPERATIONS,
  POLICY_MODES,
  WORKFLOW_OPERATIONS,
  resolveOperation,
} from "./operations.mjs";
import { QA_OPERATION } from "./qa-functions.mjs";
import {
  QA_SECRETS_OPERATION,
  QA_SECRETS_TOKEN_ENV,
  STAGED_SECRETS,
} from "./qa-secrets.mjs";

/** Secrets that reach the apply step only for one operation, as `operation == X && secret || ''`. */
const scoped = (operation, secret) =>
  `\${{ inputs.operation == '${operation}' && secrets.${secret} || '' }}`;
const SECRETS_ONLY = [
  QA_SECRETS_TOKEN_ENV,
  ...STAGED_SECRETS.map((item) => item.from),
];

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
    "baseline_sha256",
    "commit",
    "functions",
    "migrations",
    "mode",
    "operation",
    "policy_expected_revision",
    "policy_mode",
    "subjects_sha256",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, "plan-only");
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
    "plan-only",
    "apply",
    "baseline-only",
    "rotate",
    "disable",
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

test("only the approved apply job is bound to the environment and sees only the fixed deployment secrets", async () => {
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
    [
      "SUPABASE_PRODUCTION_DB_URL",
      "SUPABASE_PRODUCTION_ACCESS_TOKEN",
      "QA_SANDBOX_SUBJECT_EMAILS_JSON",
      ...SECRETS_ONLY,
    ],
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
  assert.deepEqual(secretSteps[0].env, {
    SUPABASE_DB_URL: "${{ secrets.SUPABASE_PRODUCTION_DB_URL }}",
    SUPABASE_PRODUCTION_ACCESS_TOKEN:
      "${{ secrets.SUPABASE_PRODUCTION_ACCESS_TOKEN }}",
    // The test-account list reaches the apply step only for qa-sandbox-subjects.
    QA_SANDBOX_SUBJECT_EMAILS_JSON: scoped(
      "qa-sandbox-subjects",
      "QA_SANDBOX_SUBJECT_EMAILS_JSON",
    ),
    // The Secrets-only token and the 19 staged values reach it only for qa-sandbox-secrets.
    ...Object.fromEntries(
      SECRETS_ONLY.map((name) => [name, scoped(QA_SECRETS_OPERATION, name)]),
    ),
    GH_TOKEN: "${{ github.token }}",
  });
  assert.equal(SECRETS_ONLY.length, 20);
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
    assert.equal(job.env.DEPLOY_OPERATION, "${{ inputs.operation }}");
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
    for (const secret of [
      "SUPABASE_PRODUCTION_DB_URL",
      "SUPABASE_PRODUCTION_ACCESS_TOKEN",
      "QA_SANDBOX_SUBJECT_EMAILS_JSON",
      ...SECRETS_ONLY,
    ])
      assert.ok(!text.includes(secret), name);
  }
});

test("operations are a closed choice that defaults to migrations and leaves migrations empty", async () => {
  const { workflow } = await load(DEPLOY);
  const { operation, migrations } = workflow.on.workflow_dispatch.inputs;
  assert.equal(operation.type, "choice");
  assert.equal(operation.required, "true");
  assert.equal(operation.default, "migrations");
  // Exactly the operations the planner knows; anything else is refused by the planner too.
  assert.deepEqual(operation.options, [
    "migrations",
    ...Object.keys(WORKFLOW_OPERATIONS),
    QA_OPERATION,
    QA_SECRETS_OPERATION,
  ]);
  const { policy_mode, policy_expected_revision, subjects_sha256 } =
    workflow.on.workflow_dispatch.inputs;
  assert.equal(policy_mode.type, "choice");
  assert.equal(policy_mode.default, "none");
  assert.deepEqual(policy_mode.options, [...POLICY_MODES]);
  for (const input of [policy_expected_revision, subjects_sha256]) {
    assert.equal(input.type, "string");
    assert.equal(input.required, "false");
    assert.equal(input.default, "");
  }
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.env.DEPLOY_POLICY_MODE, "${{ inputs.policy_mode }}");
    assert.equal(
      job.env.DEPLOY_POLICY_EXPECTED_REVISION,
      "${{ inputs.policy_expected_revision }}",
    );
    assert.equal(
      job.env.DEPLOY_SUBJECTS_SHA256,
      "${{ inputs.subjects_sha256 }}",
    );
  }
  assert.equal(migrations.required, "false");
  assert.equal(migrations.default, "");
  assert.doesNotMatch(workflow["run-name"], /secrets\.|commit|migrations \}\}/);
  assert.ok(TOOLING_PATHS.includes("scripts/backend/deploy/operations.mjs"));
  assert.ok(
    TOOLING_PATHS.includes("scripts/backend/deploy/sql/role-facts.sql"),
  );
});

test("every operation retains authority checks and uses only its fixed rehearsal path", async () => {
  const { workflow } = await load(DEPLOY);
  const { plan, apply } = workflow.jobs;
  assert.doesNotMatch(plan.if, /operation/);
  assert.equal(
    apply.if,
    "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && (inputs.mode == 'apply' || (inputs.mode == 'baseline-only' && inputs.operation == 'qa-sandbox-functions') || ((inputs.mode == 'rotate' || inputs.mode == 'disable') && inputs.operation == 'qa-sandbox-secrets')) && needs.plan.outputs.environment-ready == 'true'",
  );
  for (const [jobName, job] of Object.entries({ plan, apply })) {
    const conditionals = job.steps.filter((step) =>
      /operation/.test(step.if ?? ""),
    );
    const expected = new Map([
      ["denoland/setup-deno", "inputs.operation == 'qa-sandbox-functions'"],
      [
        "Install pinned Supabase CLI (checksum verified)",
        "inputs.operation != 'qa-sandbox-functions'",
      ],
      [
        "Verify pinned Supabase CLI",
        "inputs.operation != 'qa-sandbox-functions'",
      ],
      ...(jobName === "plan"
        ? [
            [
              "Rehearse the exact change on a throwaway database (no production access)",
              "inputs.operation != 'qa-sandbox-functions'",
            ],
            [
              "Verify fixed QA operation and compiler boundary (no production access)",
              "inputs.operation == 'qa-sandbox-functions'",
            ],
          ]
        : [
            [
              "Extract the exact commit and re-verify every hash",
              "inputs.operation != 'qa-sandbox-functions'",
            ],
          ]),
    ]);
    assert.equal(conditionals.length, expected.size);
    for (const step of conditionals) {
      const key = step.uses?.startsWith("denoland/setup-deno@")
        ? "denoland/setup-deno"
        : step.name;
      assert.equal(step.if, expected.get(key), `${jobName}: ${key}`);
      expected.delete(key);
    }
    assert.equal(expected.size, 0);
    for (const step of job.steps.filter((s) => !conditionals.includes(s)))
      assert.ok(
        step.if === undefined || step.if === "always()",
        `${jobName}: ${step.name}`,
      );
    assert.equal(
      job.steps.find((s) => s.uses?.startsWith("denoland/setup-deno@")).with[
        "deno-version"
      ],
      "2.8.3",
    );
    assert.equal(
      job.env.DEPLOY_BASELINE_SHA256,
      "${{ inputs.baseline_sha256 }}",
    );
    assert.equal(
      job.env.SUPABASE_PRODUCTION_PROJECT_REF,
      "${{ vars.SUPABASE_PRODUCTION_PROJECT_REF }}",
    );
    assert.equal(job.env.DEPLOY_MODE, "${{ inputs.mode }}");
  }
  const protection = plan.steps.find((s) => s.id === "protection");
  // Every mode but plan-only needs the protected environment ready before approval is requested.
  assert.match(protection.run, /if \[ "\$DEPLOY_MODE" != plan-only \]; then/);
  assert.match(protection.run, /protection --phase plan --require/);
  const qaRehearsal = plan.steps.findIndex(
    (s) =>
      s.name ===
      "Verify fixed QA operation and compiler boundary (no production access)",
  );
  assert.match(
    plan.steps[qaRehearsal].run,
    /qa-functions\.test\.mjs.*qa-function-bundles\.test\.mjs.*deploy\.test\.mjs/,
  );
  for (const job of [plan, apply]) {
    const derived = job.steps.find((s) =>
      s.run?.includes("deploy.mjs plan --out"),
    );
    assert.match(
      derived.run,
      /--source-dir "\$RUNNER_TEMP\/qa-source" --artifact-dir "\$RUNNER_TEMP\/qa-uploads"/,
    );
  }
  const planOrder = [
    "deploy.mjs plan --out",
    "protection --phase plan",
    "sha256sum -c",
    "replay.sh",
  ].map((needle) =>
    plan.steps.findIndex((s) => (s.run ?? "").includes(needle)),
  );
  assert.ok(
    planOrder.every((i) => i >= 0),
    `plan steps missing: ${planOrder}`,
  );
  assert.deepEqual(
    [...planOrder].sort((a, b) => a - b),
    planOrder,
  );
  const publish = plan.steps.findIndex((s) =>
    s.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.ok(
    publish > planOrder.at(-1) && publish > qaRehearsal,
    "the plan is published after the rehearsal",
  );
  // The apply job: approval readback, re-derived digest, hash re-check, freshness, the one step
  // that both writes and verifies (deploy.mjs apply), then the always-run closing record.
  const applyRuns = apply.steps.map((s) => s.run ?? "");
  for (const needle of [
    "protection --phase apply --require",
    "--expect-digest",
    "--stage full",
    "deploy.mjs freshness --plan",
    "deploy.mjs apply --plan",
    "deploy.mjs final-summary",
  ])
    assert.equal(applyRuns.filter((r) => r.includes(needle)).length, 1, needle);
});

test("the pull-request operation rehearsal has no environment or secret and covers every operation", async () => {
  const { text, workflow } = await load("supabase-operation-rehearsal.yml");
  assert.deepEqual(Object.keys(workflow.on), ["pull_request"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["operation-rehearsal"]);
  const job = workflow.jobs["operation-rehearsal"];
  assert.equal(job.environment, undefined);
  assert.equal(job.permissions, undefined);
  assert.doesNotMatch(
    text,
    /secrets\.|SUPABASE_PRODUCTION_DB_URL|id-token|: write\b/,
  );
  assert.equal(job.if, "github.event_name == 'pull_request'");
  // Every registry row (every operation and mode) is rehearsed exactly once, and the secrets
  // operation in each of its writing modes.
  const rows = job.strategy.matrix.include;
  assert.deepEqual(
    rows
      .filter((row) => row.operation !== QA_SECRETS_OPERATION)
      .map((row) => resolveOperation(row.operation, row.policy_mode))
      .sort(),
    Object.keys(OPERATIONS).sort(),
  );
  assert.deepEqual(
    rows
      .filter((row) => row.operation === QA_SECRETS_OPERATION)
      .map((row) => row.mode),
    ["apply", "rotate", "disable"],
  );
  const plan = job.steps.find((s) => (s.run ?? "").includes("deploy.mjs plan"));
  assert.equal(plan.env.DEPLOY_OPERATION, "${{ matrix.operation }}");
  assert.equal(plan.env.DEPLOY_POLICY_MODE, "${{ matrix.policy_mode }}");
  assert.equal(
    plan.env.DEPLOY_POLICY_EXPECTED_REVISION,
    "${{ matrix.expected_revision }}",
  );
  assert.equal(
    plan.env.DEPLOY_SUBJECTS_SHA256,
    "${{ matrix.subjects_sha256 }}",
  );
  assert.equal(plan.env.DEPLOY_MODE, "${{ matrix.mode || 'plan-only' }}");
  // A synthetic project ref: the rehearsal never reaches a hosted project.
  assert.match(plan.env.SUPABASE_PRODUCTION_PROJECT_REF, /^[a-z]{20}$/);
  assert.match(plan.run, /--source-dir "\$RUNNER_TEMP\/qa-source"/);
  assert.equal(plan.env.DEPLOY_MIGRATIONS, "");
  for (const step of job.steps)
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, step.name);
  const replay = job.steps.findIndex((s) =>
    (s.run ?? "").includes("bash scripts/backend/deploy/replay.sh"),
  );
  assert.ok(replay > job.steps.indexOf(plan));
  assert.ok(
    job.steps.some((s) =>
      (s.run ?? "").includes(
        `${CLI_TARBALL_SHA256}  $RUNNER_TEMP/supabase.tgz" | sha256sum -c -`,
      ),
    ),
  );
  // Every action is pinned to the same full commit SHA the production deploy workflow uses.
  const production = (await load(DEPLOY)).workflow;
  const pinned = new Map(
    Object.values(production.jobs)
      .flatMap((j) => j.steps)
      .filter((s) => s.uses)
      .map((s) => s.uses.split("@"))
      .map(([action, sha]) => [action, sha]),
  );
  const uses = job.steps.filter((s) => s.uses).map((s) => s.uses);
  assert.ok(uses.length >= 2);
  for (const ref of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
    const [action, sha] = ref.split("@");
    assert.equal(
      sha,
      pinned.get(action),
      `${action} pin differs from production`,
    );
  }
  // The operation tests run with the other deploy tests on every pull request.
  const foundation = (await load("supabase-deploy.yml")).workflow;
  const tests = foundation.jobs.preview.steps.find((s) =>
    (s.run ?? "").includes("node --test"),
  );
  for (const file of [
    "operations.test.mjs",
    "qa-secrets.test.mjs",
    "qa-secrets-operation.test.mjs",
  ])
    assert.ok(tests.run.includes(`scripts/backend/deploy/${file}`), file);
});
