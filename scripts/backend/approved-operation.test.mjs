import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOperationPlan } from "./plan.mjs";
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
  }
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
  const responses = [environment, branches, run, approvals];
  const requests = [];
  const fetch = async (url, options) => {
    requests.push([url, options]);
    return { ok: true, json: async () => responses.shift() };
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
  assert.equal(f.requests.length, 4);
  assert.ok(
    f.requests.every(
      ([url, options]) =>
        url.startsWith("https://api.github.com/repos/owner/repo/") &&
        options.method === "GET",
    ),
  );
  assert.ok(f.requests[3][0].endsWith("/actions/runs/123/approvals"));
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
  const f = githubFixture();
  await assert.rejects(
    readGitHubProtection(f.request, async () => ({ ok: false, status: 404 })),
  );
  assert.throws(
    () =>
      requireProductionAuthority({
        productionReady: true,
        adminBypassVerified: true,
      }),
    /unavailable/,
  );
});

test("public workflow cannot schedule production or request any production credential", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/supabase-deploy.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /echo ['"]production-ready=false['"] >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(workflow, /needs\.preview\.outputs\.production-ready == 'true'/);
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.doesNotMatch(
    workflow,
    /\bsecrets\s*[.[]|id-token:\s*write|contents:\s*write|pull_request_target|workflow_run:/,
  );
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /supabase stop --project-id still-app --no-backup/);
  assert.match(workflow, /docker volume ls/);
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
