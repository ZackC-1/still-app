import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parsers } from "prettier/plugins/yaml";
import { canonical, createOperationPlan, hash } from "./plan.mjs";
import {
  executeSyntheticOperation,
  readGitHubProtection,
  requireProductionAuthority,
} from "./approved-operation.mjs";

const revision = "a".repeat(40);
const target = "synthetic-github-runner";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cp033-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "supabase/migrations",
    "supabase/functions",
    "supabase/tests",
    "scripts/backend",
    ".github/workflows",
  ])
    await mkdir(join(root, path), { recursive: true });
  for (const path of [
    "supabase/config.toml",
    ".github/workflows/supabase-security-rehearsal.yml",
    ".github/workflows/security-audit.yml",
  ])
    await writeFile(join(root, path), "fixture\n");
  let state = {
    kind: "synthetic-sql-fixture",
    target,
    runId: "123:1",
    generation: 0,
    securityBoundary: true,
    completed: [],
  };
  const calls = [];
  const adapter = {
    read: async () => structuredClone(state),
    apply: async (operation, expected, next) => {
      assert.deepEqual(state, expected);
      calls.push(operation.id);
      state = structuredClone(next);
    },
    verify: async () => state.securityBoundary,
  };
  const plan = await createOperationPlan(root, {
    revision,
    target,
    baseline: state,
  });
  const context = {
    revision,
    target,
    runId: "123:1",
    approvedDigest: plan.digest,
    githubActions: true,
    runnerEnvironment: "github-hosted",
    platform: "linux",
    approvalKind: "synthetic",
  };
  return {
    root,
    plan,
    context,
    adapter,
    calls,
    read: () => state,
    set: (next) => {
      state = next;
    },
  };
}

test("synthetic exact execution checks CAS and authoritative readback", async (t) => {
  const f = await fixture(t);
  const receipt = await executeSyntheticOperation(
    f.root,
    f.plan,
    f.context,
    f.adapter,
  );
  assert.equal(receipt.status, "verified");
  assert.deepEqual(receipt.completed, [
    "retain-security-boundary",
    "record-verification",
  ]);
  assert.equal(f.read().generation, 2);
  assert.equal(receipt.productionEvidence, false);
});

test("scope, artifact, approval, run, target, revision and cloud drift refuse before mutation", async (t) => {
  for (const patch of [
    { approvedDigest: "0".repeat(64) },
    { runId: "123:2" },
    { target: "production" },
    { revision: "b".repeat(40) },
    { githubActions: false },
    { runnerEnvironment: "self-hosted" },
    { platform: "darwin" },
    { approvalKind: "owner" },
  ]) {
    const f = await fixture(t);
    await assert.rejects(
      executeSyntheticOperation(
        f.root,
        f.plan,
        { ...f.context, ...patch },
        f.adapter,
      ),
    );
    assert.deepEqual(f.calls, []);
  }
  const f = await fixture(t);
  f.set({ ...f.read(), generation: 1 });
  await assert.rejects(
    executeSyntheticOperation(f.root, f.plan, f.context, f.adapter),
  );
  assert.deepEqual(f.calls, []);
});

test("partial failure stops, captures actual state, and requires a separately bound forward repair", async (t) => {
  const f = await fixture(t);
  const apply = f.adapter.apply;
  f.adapter.apply = async (...args) => {
    if (args[0].id === "record-verification")
      throw new Error("private provider response must not escape");
    await apply(...args);
  };
  const receipt = await executeSyntheticOperation(
    f.root,
    f.plan,
    f.context,
    f.adapter,
  );
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.requiresReviewedForwardRepair, true);
  assert.deepEqual(receipt.completed, ["retain-security-boundary"]);
  assert.equal(f.read().securityBoundary, true);
  assert.equal(JSON.stringify(receipt).includes("private provider"), false);
  await assert.rejects(
    executeSyntheticOperation(f.root, f.plan, f.context, f.adapter),
  );
  const repair = await createOperationPlan(f.root, {
    revision,
    target,
    baseline: f.read(),
  });
  f.adapter.apply = apply;
  const repaired = await executeSyntheticOperation(
    f.root,
    repair,
    { ...f.context, approvedDigest: repair.digest },
    f.adapter,
  );
  assert.equal(repaired.status, "verified");
  assert.deepEqual(f.calls, [
    "retain-security-boundary",
    "record-verification",
  ]);
});

test("apply success cannot substitute for authoritative state and security readback", async (t) => {
  for (const mode of [
    "no-write",
    "no-write-last",
    "unsafe",
    "read-failure",
    "verification-failure",
  ]) {
    const f = await fixture(t);
    if (mode === "no-write") f.adapter.apply = async () => {};
    if (mode === "no-write-last") {
      const apply = f.adapter.apply;
      f.adapter.apply = async (...args) => {
        if (args[0].id === "retain-security-boundary") await apply(...args);
      };
    }
    if (mode === "unsafe")
      f.adapter.apply = async () =>
        f.set({ ...f.read(), securityBoundary: false });
    if (mode === "read-failure") {
      const read = f.adapter.read;
      let n = 0;
      f.adapter.read = async () => {
        if (++n > 2) throw new Error("unavailable");
        return read();
      };
    }
    if (mode === "verification-failure") f.adapter.verify = async () => false;
    if (mode === "verification-failure") {
      await assert.rejects(
        executeSyntheticOperation(f.root, f.plan, f.context, f.adapter),
      );
      assert.deepEqual(f.calls, []);
      continue;
    }
    const receipt = await executeSyntheticOperation(
      f.root,
      f.plan,
      f.context,
      f.adapter,
    );
    assert.equal(receipt.status, "stopped", mode);
    assert.equal(receipt.requiresReviewedForwardRepair, true);
    if (mode === "no-write") assert.deepEqual(receipt.completed, []);
    if (mode === "read-failure") {
      assert.equal(receipt.stateKnown, false);
      assert.equal(receipt.observedStateDigest, null);
      assert.equal(receipt.securityBoundaryObserved, false);
      assert.deepEqual(receipt.completed, []);
      assert.equal(receipt.attempted, "retain-security-boundary");
    }
  }
});

test("recovery security verification failure retains known actual state without claiming a safe boundary", async (t) => {
  const f = await fixture(t);
  let verifications = 0;
  f.adapter.verify = async () => {
    if (++verifications > 1) throw new Error("security read unavailable");
    return true;
  };
  const receipt = await executeSyntheticOperation(
    f.root,
    f.plan,
    f.context,
    f.adapter,
  );
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.stateKnown, true);
  assert.equal(receipt.observedStateDigest, hash(canonical(f.read())));
  assert.equal(receipt.securityBoundaryObserved, false);
  assert.deepEqual(receipt.completed, []);
  assert.equal(receipt.attempted, "retain-security-boundary");
  assert.equal(f.read().generation, 1);
  assert.equal(receipt.requiresReviewedForwardRepair, true);
});

test("intervening source change and security drift stop before the next operation", async (t) => {
  for (const drift of ["source", "security"]) {
    const f = await fixture(t);
    const apply = f.adapter.apply;
    let safe = true;
    f.adapter.verify = async () => safe;
    f.adapter.apply = async (...args) => {
      await apply(...args);
      if (drift === "source")
        await writeFile(join(f.root, "supabase/config.toml"), "changed\n");
      else safe = false;
    };
    const receipt = await executeSyntheticOperation(
      f.root,
      f.plan,
      f.context,
      f.adapter,
    );
    assert.equal(receipt.status, "stopped");
    assert.deepEqual(f.calls, ["retain-security-boundary"]);
    if (drift === "security")
      assert.equal(receipt.securityBoundaryObserved, false);
  }
});

test("a failed adapter can have committed state; readback never invents rollback", async (t) => {
  const f = await fixture(t);
  const apply = f.adapter.apply;
  f.adapter.apply = async (...args) => {
    await apply(...args);
    throw new Error("post-commit failure");
  };
  const receipt = await executeSyntheticOperation(
    f.root,
    f.plan,
    f.context,
    f.adapter,
  );
  assert.equal(receipt.status, "stopped");
  assert.deepEqual(receipt.completed, []);
  assert.equal(receipt.attempted, "retain-security-boundary");
  assert.equal(f.read().generation, 1);
  assert.equal(receipt.stateKnown, true);
  assert.equal(receipt.observedStateDigest, hash(canonical(f.read())));
  assert.equal(receipt.securityBoundaryObserved, true);
  assert.equal(receipt.requiresReviewedForwardRepair, true);
});

function githubFixture() {
  const environment = {
    id: 42,
    name: "supabase-production",
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { id: 7 } }],
      },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
  const branches = {
    total_count: 1,
    branch_policies: [{ name: "main", type: "branch" }],
  };
  const run = {
    id: 123,
    head_sha: revision,
    head_branch: "main",
    event: "workflow_dispatch",
    actor: { id: 8 },
    repository: { full_name: "owner/repo" },
  };
  const approvals = [
    {
      state: "approved",
      user: { id: 7 },
      environments: [{ id: 42 }],
      comment: `CP033 ${"c".repeat(64)}`,
    },
  ];
  const base = "https://api.github.com/repos/owner/repo";
  const responses = new Map(
    [
      [`${base}/environments/supabase-production`, environment],
      [
        `${base}/environments/supabase-production/deployment-branch-policies?per_page=100`,
        branches,
      ],
      [`${base}/actions/runs/123`, run],
      [`${base}/actions/runs/123/approvals`, approvals],
    ].map(([url, body]) => [url, { ok: true, json: async () => body }]),
  );
  const requests = [];
  const fetch = async (url, options) => {
    requests.push([url, options]);
    assert.ok(responses.has(url), `Unknown GitHub resource: ${url}`);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, undefined);
    assert.equal(options.body, undefined);
    assert.deepEqual(options.headers, {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    });
    return responses.get(url);
  };
  const request = {
    repository: "owner/repo",
    environmentName: "supabase-production",
    ownerReviewerId: 7,
    runId: 123,
    revision,
    digest: "c".repeat(64),
  };
  return {
    environment,
    branches,
    run,
    approvals,
    responses,
    requests,
    fetch,
    request,
  };
}

test("read-only GitHub proof checks actual reviewer, main branch and exact run approval; bypass remains unproven", async () => {
  const f = githubFixture();
  const proof = await readGitHubProtection(f.request, f.fetch);
  assert.equal(proof.requiredReviewerObserved, true);
  assert.equal(proof.exactRunApprovalObserved, true);
  assert.equal(proof.productionReady, false);
  assert.equal(proof.adminBypassVerified, false);
  assert.deepEqual(
    f.requests.map(([url]) => url),
    [...f.responses.keys()],
  );
  assert.throws(() => requireProductionAuthority(proof), /unavailable/);
});

test("single owner may initiate and give actual exact required-reviewer approval", async () => {
  const f = githubFixture();
  f.run.actor.id = 7;
  f.environment.protection_rules[0].prevent_self_review = false;
  const proof = await readGitHubProtection(f.request, f.fetch);
  assert.equal(proof.exactRunApprovalObserved, true);
  assert.equal(proof.preventSelfReviewObserved, false);
  assert.equal(proof.productionReady, false);
});

test("invented bypass fields cannot establish protection or production authority", async () => {
  const f = githubFixture();
  f.environment.can_admins_bypass = false;
  const proof = await readGitHubProtection(f.request, f.fetch);
  assert.equal(proof.adminBypassVerified, false);
  assert.equal(proof.productionReady, false);
  assert.throws(() => requireProductionAuthority(proof), /unavailable/);
});

test("missing environment/protection, branch widening and approval tampering fail closed", async () => {
  for (const mutate of [
    (f) => {
      f.environment.protection_rules = [];
    },
    (f) => {
      f.environment.protection_rules[0].reviewers.push({
        type: "User",
        reviewer: { id: 9 },
      });
    },
    (f) => {
      f.branches.total_count = 2;
    },
    (f) => {
      f.branches.branch_policies[0].type = "tag";
    },
    (f) => {
      f.run.head_sha = "b".repeat(40);
    },
    (f) => {
      f.run.head_branch = "untrusted";
    },
    (f) => {
      f.run.repository.full_name = "fork/repo";
    },
    (f) => {
      f.run.event = "pull_request";
    },
    (f) => {
      f.approvals[0].comment = "Ship it!";
    },
    (f) => {
      f.approvals[0].user.id = 9;
    },
    (f) => {
      f.approvals[0].environments[0].id = 43;
    },
    (f) => {
      f.approvals.push({ ...f.approvals[0], state: "rejected" });
    },
  ]) {
    const f = githubFixture();
    mutate(f);
    await assert.rejects(readGitHubProtection(f.request, f.fetch));
  }
  assert.throws(
    () =>
      requireProductionAuthority({
        productionReady: true,
        adminBypassVerified: true,
      }),
    /unavailable/,
  );
});

test("each GitHub resource must return a successful well-formed response", async (t) => {
  for (const url of githubFixture().responses.keys()) {
    for (const failure of ["non-OK", "malformed JSON", "wrong shape"]) {
      await t.test(`${url}: ${failure}`, async () => {
        const f = githubFixture();
        const healthy = f.responses.get(url);
        let bodyRead = false;
        f.responses.set(url, {
          ok: failure !== "non-OK",
          status: 404,
          json: async () => {
            bodyRead = true;
            if (failure === "non-OK") return healthy.json();
            if (failure === "malformed JSON")
              throw new SyntaxError("Invalid JSON");
            return {};
          },
        });
        await assert.rejects(readGitHubProtection(f.request, f.fetch));
        assert.ok(f.requests.some(([requested]) => requested === url));
        if (failure === "non-OK") assert.equal(bodyRead, false);
      });
    }
  }
});

// Reuse the installed Prettier YAML parser, retaining scalar strings (including Actions
// expressions and shell blocks). Unsupported aliases/tags fail instead of hiding scope.
function workflowValue(node) {
  assert.equal(node.anchor ?? null, null);
  assert.equal(node.tag ?? null, null);
  if (node.type === "mapping")
    return Object.fromEntries(
      node.children.map(({ children: [key, value] }) => [
        workflowValue(key),
        workflowValue(value),
      ]),
    );
  if (node.type === "sequence") return node.children.map(workflowValue);
  if (
    ["plain", "quoteDouble", "quoteSingle", "blockLiteral"].includes(node.type)
  )
    return node.value;
  if (
    ["mappingKey", "mappingValue", "sequenceItem", "documentBody"].includes(
      node.type,
    )
  ) {
    assert.ok(node.children.length <= 1);
    return node.children.length ? workflowValue(node.children[0]) : null;
  }
  assert.fail(`Unsupported workflow node: ${node.type}`);
}

test("preview installs pinned Deno and existing parser before running Node tests", async () => {
  const text = await readFile(
    new URL("../../.github/workflows/supabase-deploy.yml", import.meta.url),
    "utf8",
  );
  const ast = await parsers.yaml.parse(text);
  const workflow = workflowValue(ast.children[0].children[1]);
  const steps = workflow.jobs.preview.steps;
  const deno = steps.findIndex(
    (step) => step.uses === "denoland/setup-deno@v2",
  );
  const tests = steps.findIndex((step) =>
    step.run?.includes("entrypoints.test.mjs"),
  );
  assert.ok(deno >= 0 && tests > deno);
  assert.equal(steps[deno].with["deno-version"], "2.8.3");
  const pnpm = steps.findIndex(
    (step) => step.uses === "pnpm/action-setup@v6.1.0",
  );
  const dependencies = steps.findIndex(
    (step) =>
      step.run === "pnpm install --frozen-lockfile --ignore-scripts --filter .",
  );
  assert.ok(pnpm >= 0 && dependencies > pnpm && dependencies < tests);
});

test("public workflow effective authority output cannot schedule production or request any production credential", async (t) => {
  const text = await readFile(
    new URL("../../.github/workflows/supabase-deploy.yml", import.meta.url),
    "utf8",
  );
  const ast = await parsers.yaml.parse(text);
  const workflow = workflowValue(ast.children[0].children[1]);
  const preview = workflow.jobs.preview;
  // The sealed placeholder job was replaced by supabase-production-deploy.yml (CP-033). This
  // foundation workflow must never name an environment or schedule a production job.
  assert.deepEqual(Object.keys(workflow.jobs), ["preview", "synthetic"]);
  const authorities = preview.steps.filter((step) => step.id === "authority");
  assert.equal(authorities.length, 1);
  const authority = authorities[0];
  assert.equal(
    preview.outputs["production-ready"],
    "${{ steps.authority.outputs.production-ready }}",
  );
  assert.deepEqual(authority.env, {
    REQUESTED_OPERATION: "${{ inputs.operation }}",
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.environment, undefined);
    for (const scope of [job, ...job.steps]) {
      assert.doesNotMatch(JSON.stringify(scope), /\bsecrets\s*[.[]/);
      for (const level of Object.values(scope.permissions ?? {}))
        assert.notEqual(level, "write");
    }
  }
  const root = await mkdtemp(join(tmpdir(), "cp033-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [event, operation, status] of [
    ["pull_request", "", 0],
    ["workflow_dispatch", "synthetic", 0],
    ["workflow_dispatch", "production-unavailable", 1],
  ]) {
    const output = join(root, `${event}-${operation}.output`);
    const summary = join(root, `${event}-${operation}.summary`);
    const result = spawnSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", authority.run],
      {
        cwd: new URL("../../", import.meta.url),
        env: {
          PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,
          REQUESTED_OPERATION: operation,
          GITHUB_EVENT_NAME: event,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr);
    // The last assignment is the effective Actions output, including a later override.
    const outputs = Object.fromEntries(
      (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          assert.ok(separator > 0, `Invalid output assignment: ${line}`);
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    assert.equal(outputs["production-ready"], "false");
  }
  assert.doesNotMatch(
    text,
    /\bsecrets\s*[.[]|id-token:\s*write|contents:\s*write|pull_request_target|workflow_run:/,
  );
  const cleanup = workflow.jobs.synthetic.steps.find(
    (step) => step.if === "always()",
  );
  assert.ok(cleanup);
  assert.match(cleanup.run, /supabase stop --project-id still-app --no-backup/);
  assert.match(cleanup.run, /docker volume ls/);
});

test("CLI production, arbitrary operation and non-cloud execution refuse before tool acquisition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cp033-tool-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = join(root, "tool-called");
  for (const tool of ["git", "docker", "supabase"]) {
    await writeFile(
      join(root, tool),
      `#!/bin/sh\nprintf called > '${probe}'\nexit 1\n`,
      {
        mode: 0o700,
      },
    );
  }
  for (const operation of [
    "production-unavailable",
    "arbitrary-shell",
    "cloud-synthetic",
  ]) {
    const result = spawnSync(
      process.execPath,
      [new URL("approved-operation.mjs", import.meta.url).pathname, operation],
      {
        env: {
          PATH: root,
          GITHUB_ACTIONS: "false",
          RUNNER_ENVIRONMENT: "github-hosted",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    await assert.rejects(readFile(probe), { code: "ENOENT" });
  }
});
