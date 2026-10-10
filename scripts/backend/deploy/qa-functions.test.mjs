import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./deploy.mjs";
import {
  canonical,
  defaultExec,
  lintVerificationSql,
  makeGit,
  OWNER_REVIEWER_ID,
  sha256,
} from "./deploy.mjs";
import {
  createQaFunctionPlan,
  missingSecretCodes,
  QA_TOOLING,
  READINESS_ISSUE_PREFIXES,
  readinessCodes,
  renderQaFinal,
  REQUIRED_SECRETS,
  runQaFunctionOperation,
} from "./qa-functions.mjs";
import { QA_FUNCTIONS, sealQaRuntime } from "./qa-function-bundles.mjs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { buildQaFunctionBundles } from "./qa-function-bundles.mjs";

const REF = "abcdefghijklmnopqrst";
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
async function put(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}

async function fixture(t, mode = "apply", { existingQa = false } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "still-qa-operation-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo"),
    sourceDir = join(root, "source"),
    artifactDir = join(root, "uploads");
  await mkdir(cwd);
  const gitCmd = async (...args) => {
    const result = await defaultExec("git", args, { cwd });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await gitCmd("init", "-q", "-b", "main");
  await gitCmd("config", "user.email", "synthetic@example.invalid");
  await gitCmd("config", "user.name", "Synthetic fixture");
  await gitCmd("config", "commit.gpgsign", "false");
  for (const path of QA_TOOLING) {
    await put(
      cwd,
      path,
      path.endsWith(".sql") ? "select '[]';\n" : "bound tooling\n",
    );
  }
  await put(
    cwd,
    "supabase/config.toml",
    QA_FUNCTIONS.map(({ name, verifyJwt }) =>
      `[functions.${name}]\nverify_jwt = ${verifyJwt}\nimport_map = "./functions/${name}/deno.json"\n`
    ).join("\n"),
  );
  await put(cwd, "supabase/functions/deno.json", "{}");
  await put(cwd, "supabase/functions/deno.lock", '{"version":"5","npm":{}}');
  await put(cwd, "packages/core/src/unused.ts", "export {};");
  await put(cwd, "packages/shared-types/src/unused.ts", "export {};");
  for (const { name } of QA_FUNCTIONS) {
    await put(cwd, `supabase/functions/${name}/index.ts`, "export {};");
    await put(cwd, `supabase/functions/${name}/deno.json`, "{}");
  }
  const history = ["0015", "0016", "0019", "0020", "0021"].map((version) => ({
    version,
    name: "fixture",
  }));
  for (const { version } of history) {
    await put(cwd, `supabase/migrations/${version}_fixture.sql`, "select 1;");
  }
  await gitCmd("add", ".");
  await gitCmd("commit", "-qm", "synthetic fixture");
  const sha = await gitCmd("rev-parse", "HEAD");
  await gitCmd("update-ref", "refs/remotes/origin/main", sha);
  const production = {
    id: "production-fixed",
    slug: "reconcile-entitlement",
    name: "reconcile-entitlement",
    status: "ACTIVE",
    version: 9,
    verify_jwt: true,
    import_map: true,
    import_map_path: "/source/deno.json",
    entrypoint_path: "/source/index.ts",
    ezbr_sha256: "d".repeat(64),
    created_at: 1,
    updated_at: 2,
  };
  const existing = QA_FUNCTIONS.map(({ name, verifyJwt }) => ({
    ...production,
    id: `existing-${name}`,
    slug: name,
    name,
    verify_jwt: verifyJwt,
    created_at: 42,
    version: 7,
  }));
  const state = {
    functions: [production, ...(existingQa ? existing : [])].sort((a, b) =>
      a.slug.localeCompare(b.slug)
    ),
    secrets: REQUIRED_SECRETS.map((name) => ({ name, digest: "b".repeat(64) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    roles: ["synthetic narrow roles"],
    catalog: {
      issues: [],
      facts: ["synthetic exact catalog"],
      history,
      policyDigest: "fixed-policy",
    },
  };
  const controls = {
    approval: true,
    postCount: 0,
    bodies: new Map(),
    unknown: false,
    bodyMismatch: false,
    bodyMetadata: null,
    drift: false,
    missingGate: false,
    schemaMissing: false,
    dependencyMissing: false,
    secretResponse: null,
    replacementDrift: null,
    gateCodes: null,
  };
  const exec = async (command, args, options) => {
    if (command === "psql") {
      const file = args.at(-1);
      const output = file.endsWith("role-facts.sql")
        ? state.roles
        : file.endsWith("qa-function-prerequisites.sql")
        ? [state.catalog]
        : controls.gateCodes
        ? controls.gateCodes
        : controls.missingGate
        ? ["synthetic_missing_role"]
        : [];
      return {
        code: controls.schemaMissing ? 1 : 0,
        stdout: JSON.stringify(output),
        stderr: "ERROR:  42P01",
      };
    }
    if (command !== "deno") return defaultExec(command, args, options);
    if (args[0] === "--version") {
      return {
        code: 0,
        stdout:
          "deno 2.8.3 (stable, release, test)\nv8 test\ntypescript test\n",
      };
    }
    if (args[0] === "bundle") {
      await writeFile(
        args.find((arg) => arg.startsWith("--output=")).slice(9),
        'export const source="sealed";',
      );
      return { code: 0, stdout: "" };
    }
    const path = args.at(-1).startsWith("/")
      ? args.at(-1)
      : join(options.cwd, args.at(-1));
    const specifier = pathToFileURL(path).href;
    return {
      code: 0,
      stdout: JSON.stringify({
        roots: [specifier],
        redirects: {},
        modules: [
          {
            kind: "esm",
            specifier,
            local: path,
            ...(controls.dependencyMissing
              ? { error: "missing dependency" }
              : {}),
          },
        ],
      }),
    };
  };
  const receipts = [];
  const fetchImpl = async (url, options) => {
    assert.equal(
      options.redirect === "error" || url.startsWith("https://api.github.com/"),
      true,
    );
    if (url.startsWith("https://api.github.com/")) {
      if (url.includes("/deployment-branch-policies")) {
        return json({
          total_count: 1,
          branch_policies: [{ name: "main", type: "branch" }],
        });
      }
      if (url.endsWith("/approvals")) {
        return json(
          controls.approval
            ? [{
              state: "approved",
              user: { id: OWNER_REVIEWER_ID },
              environments: [{ id: 7 }],
            }]
            : [],
        );
      }
      return json({
        id: 7,
        name: "supabase-production",
        can_admins_bypass: false,
        protection_rules: [{
          type: "required_reviewers",
          reviewers: [{ type: "User", reviewer: { id: OWNER_REVIEWER_ID } }],
        }],
        deployment_branch_policy: {
          custom_branch_policies: true,
          protected_branches: false,
        },
      });
    }
    assert.ok(url.startsWith(`https://api.supabase.com/v1/projects/${REF}/`));
    if (url.endsWith("/functions")) return json(state.functions);
    if (url.endsWith("/secrets")) {
      const wire = state.secrets.map(({ name, digest }) => ({
        name,
        value: digest,
        updated_at: "2026-10-08T00:00:00Z",
      }));
      return json(
        controls.secretResponse ? controls.secretResponse(wire) : wire,
      );
    }
    if (options.method === "POST") {
      const name = new URL(url).searchParams.get("slug");
      const persisted = receipts.at(-1);
      assert.equal(
        persisted?.status,
        "uploading",
        "durable attempt must precede POST",
      );
      assert.equal(persisted.writeAttempted, true);
      assert.equal(persisted.attemptedRoute, name);
      assert.deepEqual(
        persisted.completed.map(({ name }) => name),
        QA_FUNCTIONS.slice(0, controls.postCount).map(({ name }) => name),
      );
      assert.equal(
        receipts.filter(({ status }) => status === "uploading").length,
        controls.postCount + 1,
      );
      controls.postCount++;
      const metadata = JSON.parse(options.body.get("metadata"));
      assert.deepEqual(metadata, {
        name,
        entrypoint_path: `${name}.js`,
        verify_jwt: QA_FUNCTIONS.find((f) => f.name === name).verifyJwt,
      });
      const file = options.body.get("file");
      assert.equal(file.name, `${name}.js`);
      const bytes = Buffer.from(await file.arrayBuffer());
      controls.bodies.set(name, bytes);
      const previous = state.functions.find((f) => f.slug === name);
      const next = {
        id: previous?.id ?? name,
        slug: name,
        name,
        status: "ACTIVE",
        version: (previous?.version ?? 0) + 1,
        verify_jwt: metadata.verify_jwt,
        import_map: false,
        import_map_path: null,
        entrypoint_path: `/source/${name}.js`,
        ezbr_sha256: sha256(bytes),
        created_at: previous?.created_at ?? 1,
        updated_at: 3,
      };
      if (controls.replacementDrift === "version") next.version++;
      if (controls.replacementDrift === "id") next.id = "different-id";
      if (controls.replacementDrift === "created_at") next.created_at++;
      state.functions = [
        ...state.functions.filter((f) => f.slug !== name),
        next,
      ].sort((a, b) => a.slug.localeCompare(b.slug));
      if (controls.drift) {
        state.functions.find((f) => f.slug === production.slug).version++;
      }
      if (controls.unknown) {
        throw new Error(
          "synthetic lost acknowledgement including secret sentinel",
        );
      }
      return json(next);
    }
    const name = url.split("/functions/")[1].split("/")[0];
    assert.ok(
      QA_FUNCTIONS.some((f) => f.name === name),
      "production source export forbidden",
    );
    if (url.endsWith("/body")) {
      const form = new FormData();
      const source = controls.bodyMismatch
        ? Buffer.from("changed source")
        : controls.bodies.get(name);
      form.append("file", new Blob([source]), `source/${name}.js`);
      // The hosted body endpoint's observed shape (2026-10-09): a relative entrypoint plus
      // deployment and size bookkeeping.
      const { id, version } = state.functions.find((f) => f.slug === name);
      const metadata = {
        deployment_id: `${REF}_${id}_${version}`,
        original_size: source.length + 509,
        compressed_size: Math.ceil(source.length / 2),
        module_count: 1,
        deno2_entrypoint_path: `source/${name}.js`,
      };
      const sent = controls.bodyMetadata ? controls.bodyMetadata(metadata) : metadata;
      if (sent !== undefined) form.set("metadata", JSON.stringify(sent));
      return new Response(form);
    }
    return json(state.functions.find((f) => f.slug === name));
  };
  const request = {
    git: makeGit(exec, cwd),
    sha,
    cwd,
    exec,
    sourceDir,
    artifactDir,
    projectRef: REF,
    mode,
    baselineSha256: mode === "apply" ? sha256(canonical(state)) : "",
  };
  const plan = await createQaFunctionPlan(request);
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "synthetic/still",
    GITHUB_RUN_ID: "1",
    GH_TOKEN: "synthetic-token",
    DEPLOY_MODE: mode,
    EXPECTED_PLAN_DIGEST: plan.digest,
    SUPABASE_PRODUCTION_PROJECT_REF: REF,
    SUPABASE_PRODUCTION_ACCESS_TOKEN: "synthetic-token",
    SUPABASE_DB_URL:
      `postgresql://postgres.${REF}:synthetic-secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres`,
  };
  return {
    state,
    controls,
    request,
    plan,
    env,
    cwd,
    sourceDir,
    artifactDir,
    exec,
    fetchImpl,
    gitCmd,
    receipts,
    run(onProgress = (receipt) => {
      receipts.push(receipt);
    }) {
      return runQaFunctionOperation({
        plan,
        env,
        cwd,
        sourceDir,
        artifactDir,
        exec,
        fetchImpl,
        platform: "linux",
        onProgress,
      });
    },
  };
}

test("baseline-only is a QA-only operation and never becomes a migration apply", async () => {
  await assert.rejects(
    main(["plan"], {
      DEPLOY_MODE: "baseline-only",
      DEPLOY_OPERATION: "migrations",
      DEPLOY_SHA: "a".repeat(40),
      DEPLOY_MIGRATIONS: "0021_qa_sandbox_access.sql",
    }, { out: { write() {} } }),
    (error) => error.category === "mode-invalid",
  );
});

test("QA function plan rejects caller-selected functions before compiling", async () => {
  await assert.rejects(
    main(["plan"], {
      DEPLOY_MODE: "plan-only",
      DEPLOY_OPERATION: "qa-sandbox-functions",
      DEPLOY_SHA: "a".repeat(40),
      DEPLOY_FUNCTIONS: "reconcile-entitlement",
    }, { out: { write() {} } }),
    (error) => error.category === "qa-input-invalid",
  );
});

test("QA no-receipt closing record preserves unknown function outcome", async () => {
  let output = "";
  await main(["final-summary", "--receipt", "/nonexistent/qa-receipt.json"], {
    DEPLOY_OPERATION: "qa-sandbox-functions",
    APPLY_OUTCOME: "cancelled",
  }, {
    out: {
      write(text) {
        output += text;
      },
    },
  });
  assert.match(output, /function outcome unknown/i);
  assert.match(output, /fix-forward/i);
  assert.doesNotMatch(output, /check.*migration history/i);
});

test("skipped QA apply without a receipt is definitely before any function write", async () => {
  let output = "";
  await main(["final-summary", "--receipt", "/nonexistent/qa-receipt.json"], {
    DEPLOY_OPERATION: "qa-sandbox-functions",
    APPLY_OUTCOME: "skipped",
    JOB_STATUS: "failure",
  }, {
    out: {
      write(text) {
        output += text;
      },
    },
  });
  assert.match(output, /stopped-before-write/);
  assert.doesNotMatch(output, /outcome unknown|partial upload|fix-forward/i);
});

test("interrupted receipt after a verified subset still needs fix-forward", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "still-qa-closing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "receipt.json");
  await writeFile(
    path,
    JSON.stringify({
      kind: "supabase-exact-qa-functions",
      status: "upload-verified",
      writeAttempted: true,
      completed: [{ name: "qa-sandbox-product-policy" }],
      issues: [],
      recovery: "none needed",
    }),
  );
  let output = "";
  await main(["final-summary", "--receipt", path], {
    DEPLOY_OPERATION: "qa-sandbox-functions",
  }, {
    out: {
      write(text) {
        output += text;
      },
    },
  });
  assert.match(output, /function-outcome-unknown/);
  assert.match(output, /fix-forward/);
  assert.doesNotMatch(output, /none needed/);
});

test("fixed QA upload verifies all eight source bytes and preserves production, roles and secrets", async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.state);
  const receipt = await f.run();
  assert.equal(receipt.status, "verified", JSON.stringify(receipt));
  assert.deepEqual(
    receipt.completed.map((r) => r.name),
    QA_FUNCTIONS.map((f) => f.name),
  );
  assert.equal(f.controls.postCount, 8);
  assert.deepEqual(
    f.state.functions.filter((f) => !f.slug.startsWith("qa-sandbox-")),
    before.functions,
  );
  assert.deepEqual(f.state.secrets, before.secrets);
  assert.deepEqual(f.state.roles, before.roles);
  assert.deepEqual(
    f.receipts.filter(({ status }) => status === "uploading").map((
      { attemptedRoute },
    ) => attemptedRoute),
    QA_FUNCTIONS.map(({ name }) => name),
  );
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /synthetic-secret|synthetic exact catalog/,
  );
});

for (
  const control of [
    "approval",
    "missingGate",
    "schemaMissing",
    "dependencyMissing",
    "secret",
    "target",
    "history",
    "catalog",
    "digest",
    "context",
    "source",
    "upload",
  ]
) {
  test(`QA ${control} failure stops before any upload`, async (t) => {
    const f = await fixture(t);
    if (control === "approval") f.controls.approval = false;
    if (
      ["missingGate", "schemaMissing", "dependencyMissing"].includes(control)
    ) f.controls[control] = true;
    if (control === "secret") {
      f.state.secrets.pop();
      f.plan.baselineSha256 = sha256(canonical(f.state));
      const { digest: _digest, ...manifest } = f.plan;
      f.plan.digest = sha256(canonical(manifest));
      f.env.EXPECTED_PLAN_DIGEST = f.plan.digest;
    }
    if (control === "target") {
      f.env.SUPABASE_DB_URL =
        "postgresql://postgres:synthetic@db.otherprojectrefxxxxx.supabase.co:5432/postgres";
    }
    if (control === "history") f.state.catalog.history.pop();
    if (control === "catalog") f.state.catalog.facts.push("unapproved grant");
    if (control === "digest") f.env.EXPECTED_PLAN_DIGEST = "0".repeat(64);
    if (control === "context") f.env.GITHUB_REF = "refs/heads/feature";
    if (control === "source") {
      await writeFile(
        join(
          f.sourceDir,
          "supabase/functions/qa-sandbox-product-policy/index.ts",
        ),
        "changed",
      );
    }
    if (control === "upload") {
      await writeFile(
        join(f.artifactDir, "qa-sandbox-product-policy.js"),
        "changed",
      );
    }
    const receipt = await f.run();
    assert.equal(receipt.status, "stopped-before-write");
    assert.equal(receipt.writeAttempted, false);
    assert.equal(f.controls.postCount, 0);
  });
}

test("existing fixed QA routes retain identity and advance exactly one version", async (t) => {
  const f = await fixture(t, "apply", { existingQa: true });
  const previous = structuredClone(f.state.functions);
  const receipt = await f.run();
  assert.equal(receipt.status, "verified", JSON.stringify(receipt));
  assert.equal(f.controls.postCount, 8);
  for (const { name } of QA_FUNCTIONS) {
    const before = previous.find(({ slug }) => slug === name);
    const after = f.state.functions.find(({ slug }) => slug === name);
    assert.equal(after.id, before.id);
    assert.equal(after.created_at, before.created_at);
    assert.equal(after.version, before.version + 1);
  }
});

for (const field of ["version", "id", "created_at"]) {
  test(`existing QA replacement ${field} drift stops after the first ambiguous write`, async (t) => {
    const f = await fixture(t, "apply", { existingQa: true });
    f.controls.replacementDrift = field;
    const receipt = await f.run();
    assert.equal(receipt.status, "function-outcome-unknown");
    assert.deepEqual(receipt.issues, ["qa-deployed-version-differs"]);
    assert.equal(receipt.completed.length, 0);
    assert.equal(f.controls.postCount, 1);
  });
}

test("pending durable attempt blocks POST and a rejected attempt never uploads", async (t) => {
  for (const rejected of [false, true]) {
    const f = await fixture(t);
    let release;
    let arrived;
    const reached = new Promise((resolve) => {
      arrived = resolve;
    });
    const pending = new Promise((resolve, reject) => {
      release = rejected
        ? () => reject(new Error("fixture persistence refused"))
        : resolve;
    });
    const operation = f.run((receipt) => {
      f.receipts.push(receipt);
      if (receipt.status === "uploading" && f.controls.postCount === 0) {
        arrived();
        return pending;
      }
    });
    await reached;
    assert.equal(f.controls.postCount, 0);
    release();
    const receipt = await operation;
    assert.equal(f.controls.postCount, rejected ? 0 : 8);
    assert.equal(
      receipt.status,
      rejected ? "function-outcome-unknown" : "verified",
    );
  }
});

for (
  const control of [
    "plaintext",
    "missing-value",
    "duplicate",
    "ambiguous-digest",
  ]
) {
  test(`QA secrets ${control} wire response stops before uploads without exposing content`, async (t) => {
    const f = await fixture(t);
    f.controls.secretResponse = (wire) => {
      if (control === "plaintext") wire[0].value = "synthetic-private-value";
      if (control === "missing-value") delete wire[0].value;
      if (control === "duplicate") wire.push({ ...wire[0] });
      if (control === "ambiguous-digest") wire[0].digest = "c".repeat(64);
      return wire;
    };
    const receipt = await f.run();
    assert.equal(receipt.status, "stopped-before-write");
    assert.deepEqual(receipt.issues, ["qa-secret-inventory-invalid"]);
    assert.equal(f.controls.postCount, 0);
    assert.doesNotMatch(JSON.stringify(receipt), /synthetic-private-value/);
  });
}

for (const control of ["unknown", "bodyMismatch", "drift"]) {
  test(`QA ${control} after first write preserves unknown receipt and stops`, async (t) => {
    const f = await fixture(t);
    f.controls[control] = true;
    const receipt = await f.run();
    assert.equal(receipt.status, "function-outcome-unknown");
    assert.equal(receipt.writeAttempted, true);
    assert.equal(receipt.attemptedRoute, "qa-sandbox-product-policy");
    assert.equal(receipt.completed.length, 0);
    assert.equal(f.controls.postCount, 1);
    assert.match(receipt.recovery, /fix-forward/);
    assert.doesNotMatch(JSON.stringify(receipt), /secret sentinel/);
  });
}

const BODY_METADATA_REFUSALS = {
  "unknown key": (m) => ({ ...m, synthetic_new_key: 1 }),
  "other version": (m) => ({
    ...m,
    deployment_id: m.deployment_id.replace(/_1$/, "_9"),
  }),
  "other project": (m) => ({
    ...m,
    deployment_id: m.deployment_id.replace(REF, "zyxwvutsrqponmlkjihg"),
  }),
  "other function": (m) => ({
    ...m,
    deployment_id: m.deployment_id.replace(
      "qa-sandbox-product-policy",
      "qa-sandbox-sync-settings",
    ),
  }),
  "missing deployment": ({ deployment_id: _, ...m }) => m,
  "several modules": (m) => ({ ...m, module_count: 3 }),
  "fractional size": (m) => ({ ...m, original_size: 1.5 }),
  "zero modules": (m) => ({ ...m, module_count: 0 }),
  "other entrypoint": (m) => ({
    ...m,
    deno2_entrypoint_path: "source/other.js",
  }),
  "missing entrypoint": ({ deno2_entrypoint_path: _, ...m }) => m,
  "not an object": () => ["synthetic"],
  "missing metadata part": () => undefined,
};

for (const [label, mutate] of Object.entries(BODY_METADATA_REFUSALS)) {
  test(`QA body metadata ${label} stops after the first write`, async (t) => {
    const f = await fixture(t);
    f.controls.bodyMetadata = mutate;
    const receipt = await f.run();
    assert.equal(receipt.status, "function-outcome-unknown");
    assert.deepEqual(receipt.issues, ["qa-deployed-source-differs"]);
    assert.equal(receipt.completed.length, 0);
    assert.equal(f.controls.postCount, 1);
  });
}

test("QA re-upload onto an existing route refuses a body from the previous version", async (t) => {
  const f = await fixture(t, "apply", { existingQa: true });
  f.controls.bodyMetadata = (m) => ({
    ...m,
    deployment_id: m.deployment_id.replace(/_(\d+)$/, (_, v) => `_${v - 1}`),
  });
  const receipt = await f.run();
  assert.equal(receipt.status, "function-outcome-unknown");
  assert.deepEqual(receipt.issues, ["qa-deployed-source-differs"]);
  assert.equal(f.controls.postCount, 1);
});

test("QA body metadata may omit size bookkeeping", async (t) => {
  const f = await fixture(t);
  f.controls.bodyMetadata = ({ deno2_entrypoint_path, deployment_id }) => ({
    deno2_entrypoint_path,
    deployment_id,
  });
  const receipt = await f.run();
  assert.equal(receipt.status, "verified");
});

for (const control of ["function", "catalog", "role"]) {
  test(`QA pre-upload ${control} drift after first verified upload stops before a second POST`, async (t) => {
    const f = await fixture(t);
    let injected = false;
    const receipt = await f.run((progress) => {
      f.receipts.push(progress);
      if (progress.status !== "upload-verified" || injected) return;
      // Inject only after route one's source/version/preservation readback has
      // succeeded, so the following route's pre-upload guard must stop it.
      assert.deepEqual(
        progress.completed.map(({ name }) => name),
        [QA_FUNCTIONS[0].name],
      );
      assert.equal(f.controls.postCount, 1);
      injected = true;
      if (control === "function") {
        f.state.functions.find(({ slug }) => slug === "reconcile-entitlement")
          .version++;
      } else if (control === "catalog") {
        f.state.catalog.facts.push("synthetic catalog drift between routes");
      } else {
        f.state.roles.push("synthetic role drift between routes");
      }
    });
    assert.equal(injected, true);
    assert.equal(f.controls.postCount, 1, "no second POST or retry");
    assert.equal(receipt.status, "function-outcome-unknown");
    assert.deepEqual(receipt.issues, ["qa-baseline-drift"]);
    assert.equal(receipt.writeAttempted, true);
    assert.equal(receipt.attemptedRoute, QA_FUNCTIONS[0].name);
    assert.deepEqual(
      receipt.completed.map(({ name }) => name),
      [QA_FUNCTIONS[0].name],
    );
    assert.equal(
      f.receipts.filter(({ status }) => status === "uploading").length,
      1,
    );
    assert.equal(
      f.receipts.filter(({ status }) => status === "upload-verified").length,
      1,
    );
    assert.deepEqual(f.receipts.at(-1), receipt, "closed failure persisted");
    assert.match(receipt.recovery, /fix-forward/);
  });
}

test("protected baseline-only obtains private fingerprint without any upload", async (t) => {
  const f = await fixture(t, "baseline-only");
  f.state.secrets = [];
  const receipt = await f.run();
  assert.equal(receipt.status, "baseline-read-only");
  assert.equal(receipt.writeAttempted, false);
  assert.equal(f.controls.postCount, 0);
  assert.match(receipt.baselineSha256, /^[a-f0-9]{64}$/);
  // Readiness still names every absent required secret, by name only.
  assert.deepEqual(
    receipt.issues,
    REQUIRED_SECRETS.map((name) => `missing_secret:${name}`),
  );
  assert.match(receipt.recovery, /^Resolve the listed readiness issues, then run baseline-only again/);
  assert.match(renderQaFinal(receipt), /- Recovery: Resolve the listed readiness issues/);
  assert.doesNotMatch(renderQaFinal(receipt), /none needed/);
});

test("baseline-only with every required secret and a clean gate needs no recovery", async (t) => {
  const f = await fixture(t, "baseline-only");
  const receipt = await f.run();
  assert.equal(receipt.status, "baseline-read-only");
  assert.deepEqual(receipt.issues, []);
  assert.equal(receipt.recovery, "none needed");
});

test("readable readiness lists sorted fixed gate codes and missing secret names only", async (t) => {
  const f = await fixture(t, "baseline-only");
  const [firstMissing, secondMissing] = [
    "STILL_QA_SANDBOX_STRIPE_WEBHOOK_SECRET",
    "PRODUCT_POLICY_READER_DB_URL",
  ];
  f.state.secrets = f.state.secrets.filter(({ name }) =>
    name !== firstMissing && name !== secondMissing
  );
  f.state.catalog.issues = [
    "sandbox_sales_policy_missing",
    "role_not_login:still_qa_sandbox_writer",
    "role_membership:still_policy_reader",
  ];
  f.controls.gateCodes = [
    "QA_missing_role_setting:lock_timeout=1s",
    "routine_body:public.qa_sandbox_account_enabled(uuid)",
    "role_not_login:still_qa_sandbox_writer",
    "routine_acl:private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])",
  ];
  const receipt = await f.run();
  assert.equal(receipt.status, "stopped-before-write");
  assert.equal(f.controls.postCount, 0);
  assert.deepEqual(receipt.issues, [
    "qa-prerequisite-gate-failed",
    `missing_secret:${secondMissing}`,
    `missing_secret:${firstMissing}`,
    "QA_missing_role_setting:lock_timeout=1s",
    "role_membership:still_policy_reader",
    "role_not_login:still_qa_sandbox_writer",
    "routine_acl:private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])",
    "routine_body:public.qa_sandbox_account_enabled(uuid)",
    "sandbox_sales_policy_missing",
  ]);
  assert.match(receipt.recovery, /^Resolve the listed readiness issues, then run baseline-only again/);
  const text = JSON.stringify(receipt) + renderQaFinal(receipt);
  assert.doesNotMatch(
    text,
    /synthetic exact catalog|fixed-policy|synthetic-secret|b{64}/,
  );
  assert.match(text, /Fixed issue codes: qa-prerequisite-gate-failed\./);
  assert.match(text, /Readiness issues \(8;/);
  assert.match(text, /- Recovery: Resolve the listed readiness issues/);
  assert.match(text, /- `missing_secret:PRODUCT_POLICY_READER_DB_URL`/);
});

test("readable readiness collapses free text and unreadable secrets to fixed markers", async (t) => {
  const f = await fixture(t, "baseline-only");
  f.controls.gateCodes = [
    "missing_role:still_policy_reader",
    "routine_body:synthetic free text with a value",
    "missing_role:Synthetic@Example.invalid",
    "unknown_prefix:still_policy_reader",
    { code: "object" },
  ];
  f.state.catalog = { ...f.state.catalog, issues: "not-an-array" };
  f.controls.secretResponse = (wire) => {
    wire[0].value = "synthetic-private-value";
    return wire;
  };
  const receipt = await f.run();
  assert.deepEqual(receipt.issues, [
    "qa-prerequisite-gate-failed",
    "secret_inventory_unreadable",
    "missing_role:still_policy_reader",
    "unrecognized_issue_code",
  ]);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /free text|Synthetic@|unknown_prefix|synthetic-private-value|not-an-array/,
  );
});

test("apply refusal for absent secrets names each missing secret", async (t) => {
  const f = await fixture(t);
  f.state.secrets = f.state.secrets.filter(({ name }) =>
    name !== "STILL_QA_SANDBOX_WEB_RETURN_ORIGIN"
  );
  f.plan.baselineSha256 = sha256(canonical(f.state));
  const { digest: _digest, ...manifest } = f.plan;
  f.plan.digest = sha256(canonical(manifest));
  f.env.EXPECTED_PLAN_DIGEST = f.plan.digest;
  const receipt = await f.run();
  assert.equal(receipt.status, "stopped-before-write");
  assert.equal(f.controls.postCount, 0);
  assert.deepEqual(receipt.issues, [
    "qa-required-secret-missing",
    "missing_secret:STILL_QA_SANDBOX_WEB_RETURN_ORIGIN",
  ]);
});

test("readiness prefix allowlist equals the codes both gate SQL files can emit", async () => {
  const prefixes = new Set();
  for (
    const file of [
      "./verify/qa-function-prerequisites.sql",
      "./verify/0021_qa_sandbox_access.sql",
    ]
  ) {
    const sql = await readFile(new URL(file, import.meta.url), "utf8");
    for (const [, prefix] of sql.matchAll(/select '([A-Za-z_]+):'\|\|/g)) {
      prefixes.add(prefix);
    }
    for (
      const [, prefix] of sql.matchAll(
        /select '([A-Za-z_]+)'(?: as code)? (?:from|where)/g,
      )
    ) prefixes.add(prefix);
  }
  assert.deepEqual([...prefixes].sort(), [...READINESS_ISSUE_PREFIXES].sort());
});

test("readiness codes are bounded and secret names come from the fixed list", () => {
  const many = Array.from(
    { length: 205 },
    (_, i) => `missing_routine:private.synthetic_${String(i).padStart(3, "0")}()`,
  );
  const codes = readinessCodes(many);
  assert.equal(codes.length, 201);
  assert.equal(codes.at(-1), "more_issue_codes:5");
  assert.deepEqual(readinessCodes(["private_schema", "private_schema"]), [
    "private_schema",
  ]);
  // Array argument types appear in fixed prerequisite signatures and must stay readable.
  const arraySignature =
    "missing_routine:private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])";
  assert.deepEqual(readinessCodes([arraySignature]), [arraySignature]);
  assert.deepEqual(missingSecretCodes(REQUIRED_SECRETS.map((name) => ({ name }))), []);
});

test("QA main drift and new migration stop even when upload source is untouched", async (t) => {
  const f = await fixture(t);
  await put(f.cwd, "supabase/migrations/0022_changed.sql", "select 2;");
  await f.gitCmd("add", ".");
  await f.gitCmd("commit", "-qm", "later migration");
  await f.gitCmd("update-ref", "refs/remotes/origin/main", "HEAD");
  const receipt = await f.run();
  assert.equal(receipt.status, "stopped-before-write");
  assert.equal(f.controls.postCount, 0);
});

test("current QA prerequisite verification is a single read-only query", async () => {
  const sql = await readFile(
    new URL("./verify/qa-function-prerequisites.sql", import.meta.url),
    "utf8",
  );
  assert.equal(lintVerificationSql(sql), true);
});

test(
  "current prerequisite gate runs against actual disposable PostgreSQL and detects drift",
  {
    skip: process.env.STILL_QA_PREREQUISITE_INTEGRATION !== "1",
  },
  async () => {
    assert.equal(process.platform, "linux");
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
    const sql = await readFile(
      new URL("./verify/qa-function-prerequisites.sql", import.meta.url),
      "utf8",
    );
    const query = async (mutation = "") => {
      const result = await defaultExec("psql", [
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "-X",
        "-q",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `begin; ${mutation}\n${sql}\nrollback;`,
      ]);
      assert.equal(result.code, 0, "fixed prerequisite fixture SQL failed");
      return JSON.parse(result.stdout.trim())[0];
    };
    assert.deepEqual((await query()).issues, []);
    assert.deepEqual(
      (await query("alter role still_entitlement_writer inherit;")).issues,
      [],
      "the legacy role keeps its original INHERIT attribute without receiving memberships",
    );
    for (
      const [mutation, issue] of [
        ["alter role still_settings_writer inherit;", /^unsafe_role:/],
        [
          "alter role still_qa_sandbox_writer in database postgres set log_parameter_max_length_on_error='-1';",
          /^QA_database_role_setting:/,
        ],
        [
          "alter role still_qa_sandbox_writer in database postgres set statement_timeout='0';",
          /^QA_database_role_setting:/,
        ],
        [
          "grant still_settings_writer to still_entitlement_writer;",
          /^role_membership:/,
        ],
        [
          "grant execute on function private.lock_settings(uuid,uuid,text) to anon;",
          /^routine_acl:/,
        ],
        [
          "alter function private.read_product_policy(text,text) security invoker;",
          /^routine_definer:/,
        ],
        [
          "delete from supabase_migrations.schema_migrations where version='0015';",
          /^missing_history:/,
        ],
        [
          "alter table private.product_policy_revisions disable trigger user; delete from private.product_policy_revisions where environment='sandbox';",
          /^sandbox_sales_policy_missing$/,
        ],
      ]
    ) {
      assert.ok(
        (await query(mutation)).issues.some((code) => issue.test(code)),
        `missing negative control ${issue}`,
      );
      assert.deepEqual(
        (await query()).issues,
        [],
        "transactional fixture restored the healthy gate",
      );
    }
    const healthy = await query();
    const safeDatabaseSetting = await query(
      "alter role still_qa_sandbox_writer in database postgres set statement_timeout='2s';",
    );
    assert.deepEqual(
      safeDatabaseSetting.issues,
      [],
      "an identical safety setting remains valid",
    );
    assert.notDeepEqual(
      safeDatabaseSetting.facts,
      healthy.facts,
      "database-specific role settings are bound even when safe",
    );
    const allRoleDatabaseSetting = await query(
      "alter database postgres set application_name='fixture-preservation-drift';",
    );
    assert.notDeepEqual(
      allRoleDatabaseSetting.facts,
      healthy.facts,
      "database ALL-role defaults are also bound",
    );
    const columnDrift = await query(
      "alter table private.settings_anchors alter column modern_used drop not null;",
    );
    assert.notDeepEqual(
      columnDrift.facts,
      healthy.facts,
      "column definition drift must alter the preservation fingerprint",
    );
    assert.deepEqual(
      (await query()).facts,
      healthy.facts,
      "column definition fixture restored",
    );
  },
);

test(
  "all eight sealed uploads deny incomplete requests and the sealed driver queries disposable PostgreSQL in the actual Edge runtime",
  {
    skip: process.env.STILL_QA_RUNTIME_INTEGRATION !== "1",
  },
  async (t) => {
    assert.equal(process.platform, "linux");
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "still-qa-edge-bundles-")),
    );
    let service = null;
    t.after(async () => {
      if (service && service.exitCode === null) {
        const exited = new Promise((resolve) => service.once("close", resolve));
        service.kill("SIGTERM");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        if (service.exitCode === null) service.kill("SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    });
    const fixtureDir = join(root, "project"), uploads = join(root, "uploads");
    const manifest = await buildQaFunctionBundles({
      sourceDir: cwd,
      artifactDir: uploads,
    });
    assert.equal(manifest.functions.length, 8);
    // This ninth route exists only in the disposable local serving tree, never
    // in the fixed upload manifest or production source. Exercise a successful
    // PostgreSQL exchange, which incomplete-request denials cannot establish.
    const probeName = "fixture-only-postgres-runtime-probe";
    const probeSource = join(root, "postgres-runtime-probe.ts");
    const probeBundle = join(root, "postgres-runtime-probe.js");
    await writeFile(
      probeSource,
      `
// The reviewed config and frozen lock resolve this to postgres@3.4.9.
import postgres from "postgres";
Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(null, { status: 405 });
  }
  if (Deno.env.get("STILL_QA_FIXTURE_DB_PASSWORD") !== "postgres") {
    return new Response(null, { status: 503 });
  }
  const sql = postgres({
    // The pinned CLI serves through Docker's db alias: the Edge runtime cannot
    // resolve underscores in the full local container name.
    host: "db", port: 5432, database: "postgres",
    username: "postgres", password: "postgres", ssl: false, max: 1,
    // Match createWriterSql's prepare:false and default type discovery; only
    // fixture connection limits differ from the maintained writer recipe.
    prepare: false, connect_timeout: 2,
    idle_timeout: 0, max_lifetime: null, no_subscribe: true,
  });
  let deadline;
  try {
    const rows = await Promise.race([
      sql\`SELECT \${1}::integer AS runtime_probe\`,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Fixture query deadline")), 4_000);
      }),
    ]);
    return Response.json({
      runtime_probe: rows[0]?.runtime_probe,
      ambient_setImmediate: typeof globalThis.setImmediate,
      ambient_clearImmediate: typeof globalThis.clearImmediate,
    });
  } catch (error) {
    // This route has only the fixed disposable database and synthetic inputs.
    // Keep the next driver failure visible without emitting arbitrary payloads.
    return Response.json({ fixture_failure: {
      name: String(error?.name ?? '').slice(0, 80),
      code: String(error?.code ?? '').slice(0, 80),
      message: String(error?.message ?? '').slice(0, 240),
    } }, { status: 500 });
  } finally {
    clearTimeout(deadline);
    await sql.end({ timeout: 1 });
  }
});
`,
    );
    const compiledProbe = await defaultExec("deno", [
      "bundle",
      ...manifest.toolchain.flags,
      `--output=${probeBundle}`,
      probeSource,
    ], { cwd });
    assert.equal(compiledProbe.code, 0, compiledProbe.stderr);
    await put(
      fixtureDir,
      `supabase/functions/${probeName}/index.js`,
      sealQaRuntime(await readFile(probeBundle, "utf8")),
    );
    const config = (await readFile(join(cwd, "supabase/config.toml"), "utf8"))
      .replace(/^\[functions\.[^\]]+\][\s\S]*?(?=^\[|$(?![\s\S]))/gm, "");
    await put(
      fixtureDir,
      "supabase/config.toml",
      config + "\n" +
        manifest.functions.map(({ name, verifyJwt }) =>
          `[functions.${name}]\nverify_jwt = ${verifyJwt}\nentrypoint = "./functions/${name}/index.js"\n`
        ).join("\n") +
        `\n[functions.${probeName}]\nverify_jwt = true\nentrypoint = "./functions/${probeName}/index.js"\n`,
    );
    for (const upload of manifest.functions) {
      await put(
        fixtureDir,
        `supabase/functions/${upload.name}/index.js`,
        await readFile(join(uploads, upload.file)),
      );
    }
    const envFile = join(root, "fixture.env");
    await writeFile(envFile, "STILL_QA_FIXTURE_DB_PASSWORD=postgres\n", {
      mode: 0o600,
    });
    const status = await defaultExec("supabase", ["status", "-o", "json"], {
      cwd,
    });
    assert.equal(status.code, 0);
    const anonKey = JSON.parse(status.stdout).ANON_KEY;
    assert.equal(typeof anonKey, "string");
    let runtimeLog = "";
    const capture = (chunk) => {
      runtimeLog = (runtimeLog + chunk.toString()).slice(-16_384);
    };
    service = spawn("supabase", [
      "functions",
      "serve",
      "--workdir",
      fixtureDir,
      "--env-file",
      envFile,
    ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout.on("data", capture);
    service.stderr.on("data", capture);
    let serviceError = false;
    service.on("error", () => {
      serviceError = true;
    });
    const request = (name) =>
      fetch(`http://127.0.0.1:54321/functions/v1/${name}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${anonKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(3_000),
        redirect: "error",
      });
    const deadline = Date.now() + 90_000;
    let ready = false;
    let lastStatus = null;
    while (Date.now() < deadline) {
      assert.equal(
        serviceError,
        false,
        "local Edge runtime process failed to start",
      );
      assert.equal(
        service.exitCode,
        null,
        "local Edge runtime process stopped before readiness",
      );
      try {
        lastStatus = (await request("qa-sandbox-product-policy")).status;
        ready = lastStatus === 400;
      } catch { /* startup only */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(
      ready,
      `actual sealed policy bundle never reached its handler (HTTP ${lastStatus}); local fixture diagnostics: ${
        runtimeLog.replaceAll(anonKey, "[local JWT]")
      }`,
    );
    for (const { name, verifyJwt } of manifest.functions) {
      const response = await request(name);
      const expectedStatus = verifyJwt
        ? 401
        : name === "qa-sandbox-verify-apple-access"
        ? 200
        : name === "qa-sandbox-stripe-webhook"
        ? 503
        : 400;
      assert.equal(
        response.status,
        expectedStatus,
        `${name}; local fixture diagnostics: ${
          runtimeLog.replaceAll(anonKey, "[local JWT]")
        }`,
      );
      if (verifyJwt) {
        const body = await response.json();
        assert.equal(response.status, 401, name);
        assert.deepEqual(body, { error: "unauthorized" });
      } else if (name === "qa-sandbox-verify-apple-access") {
        const body = await response.json();
        assert.equal(response.status, 200, name);
        assert.deepEqual(body, { status: "unavailable" });
      } else if (name === "qa-sandbox-stripe-webhook") {
        const body = await response.json();
        assert.equal(response.status, 503, name);
        assert.deepEqual(body, { error: "webhook_unavailable" });
      } else assert.equal(response.status, 400, name);
    }
    const probeResponse = await fetch(
      `http://127.0.0.1:54321/functions/v1/${probeName}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${anonKey}` },
        signal: AbortSignal.timeout(8_000),
        redirect: "error",
      },
    );
    const probeBody = await probeResponse.text();
    assert.equal(
      probeResponse.status,
      200,
      `sealed driver did not complete its disposable database query; fixture reply: ${
        probeBody.slice(0, 500)
      }; local fixture diagnostics: ${
        runtimeLog.replaceAll(anonKey, "[local JWT]")
      }`,
    );
    const probeResult = JSON.parse(probeBody);
    assert.equal(probeResult.runtime_probe, 1);
    assert.deepEqual(Object.keys(probeResult).sort(), [
      "ambient_clearImmediate",
      "ambient_setImmediate",
      "runtime_probe",
    ]);
    for (const key of ["ambient_setImmediate", "ambient_clearImmediate"]) {
      assert.ok(["undefined", "function"].includes(probeResult[key]), key);
    }
    t.diagnostic(
      `Disposable Edge PostgreSQL SELECT 1 succeeded; ambient setImmediate=${probeResult.ambient_setImmediate}, clearImmediate=${probeResult.ambient_clearImmediate}`,
    );
    for (const upload of manifest.functions) {
      assert.equal(
        sha256(await readFile(join(uploads, upload.file))),
        upload.sha256,
      );
    }
  },
);
