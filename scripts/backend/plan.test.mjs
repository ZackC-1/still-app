import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  createOperationPlan,
  createPlan,
  settingsRuntimeSources,
  verifyOperationPlan,
  verifyPlan,
  assertSettingsRuntimeClosure,
} from "./plan.mjs";

test("actual Deno closure binds every dependency and pinned CLI raw resolution", async (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const mapPath = join(root, "supabase/functions/sync-settings/deno.json");
  const imports = JSON.parse(await readFile(mapPath, "utf8")).imports;
  const graph = JSON.parse(
    execFileSync(
      "deno",
      [
        "info",
        "--json",
        "--config",
        mapPath,
        join(root, "supabase/functions/sync-settings/index.ts"),
      ],
      { encoding: "utf8" },
    ),
  );
  // CLI serve selects this nearest function config, independently of the frozen
  // root check. Every external alias must pin the root lock's reviewed version.
  const lock = JSON.parse(await readFile(join(root, "supabase/functions/deno.lock"), "utf8"));
  const rootImports = JSON.parse(await readFile(join(root, "supabase/functions/deno.json"), "utf8")).imports;
  for (const [alias, specifier] of Object.entries(rootImports)) {
    if (!specifier.startsWith("npm:") && !specifier.startsWith("jsr:")) continue;
    const match = /^(npm:|jsr:)(@?[^@]+)@([^/]+)(.*)$/.exec(specifier);
    assert(match, alias);
    const [, protocol, name, range, suffix] = match;
    const version = lock.specifiers[`${protocol}${name}@${range}`];
    assert(version, `Missing reviewed lock version: ${alias}`);
    assert.equal(imports[alias], `${protocol}${name}@${version}${suffix}`, alias);
  }
  assert.deepEqual(Object.keys(graph.npmPackages).sort(), Object.keys(lock.npm).sort());
  assert.deepEqual(
    assertSettingsRuntimeClosure(graph, root, imports, mapPath),
    [...settingsRuntimeSources].sort(),
  );
  assert.throws(
    () =>
      assertSettingsRuntimeClosure(
        graph,
        root,
        imports,
        mapPath,
        settingsRuntimeSources.slice(1),
      ),
    /manifest/,
  );
  const missingAlias = { ...imports };
  delete missingAlias["./settings-v2.js"];
  assert.throws(
    () => assertSettingsRuntimeClosure(graph, root, missingAlias, mapPath),
    /CLI raw import/,
  );
  const scratch = await mkdtemp(join(tmpdir(), "still-settings-graph-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const graphSources = graph.modules.filter(m=>m.local && m.specifier.startsWith("file:")).map(m=>relative(root,m.local));
  for (const path of [...graphSources,"supabase/functions/sync-settings/deno.json"]) {
    assert(!path.startsWith(".."));
    await mkdir(join(scratch, path, ".."), { recursive: true });
    await cp(join(root, path), join(scratch, path));
  }
  const extra = join(scratch, "packages/shared-types/src/extra-runtime.ts");
  await writeFile(extra, "export const extra = 1;\n");
  const entry = join(scratch, "supabase/functions/sync-settings/index.ts");
  await writeFile(
    entry,
    (await readFile(entry, "utf8")) +
      '\nimport "../../../packages/shared-types/src/extra-runtime.ts";\n',
  );
  const extraMap = join(scratch, "supabase/functions/sync-settings/deno.json");
  const addedGraph = JSON.parse(
    execFileSync("deno", ["info", "--json", "--config", extraMap, entry], {
      encoding: "utf8",
    }),
  );
  assert.throws(
    () => assertSettingsRuntimeClosure(addedGraph, scratch, imports, extraMap),
    /manifest/,
  );
});

test("candidate SQL structural constants and fields equal the maintained grammar", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sql = await readFile(
    join(root, "scripts/backend/sql/settings-sync-candidate.sql"),
    "utf8",
  );
  const source = await readFile(
    join(root, "packages/core/src/storage/settings-v2.ts"),
    "utf8",
  );
  const values = Object.fromEntries(
    [
      ...source.matchAll(
        /const (MAX_BYTES|MAX_NODES|MAX_DEPTH|MAX_MEMBERS|MAX_STRING) = ([\d_]+);/g,
      ),
    ].map((m) => [m[1], Number(m[2].replaceAll("_", ""))]),
  );
  const checks = {
    MAX_BYTES: /select bytes from sizes\)<=(\d+)/,
    MAX_NODES: /count\(\*\)<=(\d+) and coalesce\(bool_and/,
    MAX_DEPTH: /bool_and\(depth<=(\d+)/,
    MAX_MEMBERS: /jsonb_array_length\(value\)<=(\d+)/,
    MAX_STRING: /octet_length\(value#>>'\{\}'\)<=(\d+)/,
  };
  assert.equal(Object.keys(values).length, 5);
  for (const [key, pattern] of Object.entries(checks))
    assert.equal(Number(pattern.exec(sql)?.[1]), values[key], key);
  assert.match(
    sql,
    /count\(\*\)<=128 and coalesce\(bool_and\(pg_catalog.octet_length\(k\)<=128 and k not in \('__proto__','prototype','constructor'\)\)/,
  );
  const maintained = JSON.parse(
    execFileSync(
      "deno",
      [
        "eval",
        "--config",
        join(root, "supabase/functions/deno.json"),
        'import {SETTINGS_FIELDS,FEATURE_REGISTRY} from "@still/shared-types"; console.log(JSON.stringify({fields:SETTINGS_FIELDS,coreSites:FEATURE_REGISTRY.filter(f=>f.tier==="free").map(f=>f.id),servicePrefixes:FEATURE_REGISTRY.every(f=>f.id.split(".")[0]===f.service)}));',
      ],
      { encoding: "utf8" },
    ),
  );
  const actual =
    /create function private.settings_fields\(\)[\s\S]*?select array\[([^\]]+)\]/
      .exec(sql)[1]
      .split(",")
      .map((s) => s.trim().slice(1, -1));
  assert.deepEqual(actual, maintained.fields);
  assert.equal(maintained.servicePrefixes, true);
  assert.deepEqual(/core_sites constant text\[\] := array\[([^\]]+)\]/.exec(sql)[1].split(",").map(s=>s.trim().slice(1,-1)), maintained.coreSites);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "still-backend-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "supabase/migrations"), { recursive: true });
  await mkdir(join(root, "supabase/functions/demo"), { recursive: true });
  await mkdir(join(root, "scripts/backend/sql"), { recursive: true });
  await writeFile(
    join(root, "supabase/migrations/0001_init.sql"),
    "select 1;\n",
  );
  await writeFile(
    join(root, "supabase/functions/demo/index.ts"),
    'Deno.serve(() => new Response("ok"));\n',
  );
  await writeFile(
    join(root, "supabase/config.toml"),
    "[functions.demo]\nverify_jwt = true\n",
  );
  await writeFile(
    join(root, "scripts/backend/sql/hardening-candidate.sql"),
    "select 2;\n",
  );
  await mkdir(join(root, "supabase/tests"), { recursive: true });
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await writeFile(join(root, "supabase/tests/security_test.ts"), "// test\n");
  await writeFile(
    join(root, ".github/workflows/supabase-security-rehearsal.yml"),
    "// rehearsal\n",
  );
  await writeFile(
    join(root, ".github/workflows/security-audit.yml"),
    "// audit\n",
  );
  return root;
}
const revision = "a".repeat(40);
const target = "synthetic-github-runner";

test("plan binds actual bytes, target, revision and operation scope", async (t) => {
  const root = await fixture(t);
  const plan = await createPlan(root, { revision, target });
  assert.equal(plan.kind, "rehearsal");
  assert.equal(plan.productionApplyAvailable, false);
  assert.deepEqual(
    plan.migrations.map((m) => m.id),
    ["0001"],
  );
  assert.equal(plan.files.length, 7);
  await verifyPlan(root, plan, { revision, target, digest: plan.digest });
  await assert.rejects(
    verifyPlan(root, plan, {
      revision,
      target: "changed-target",
      digest: plan.digest,
    }),
  );
  await assert.rejects(
    verifyPlan(root, plan, {
      revision: "b".repeat(40),
      target,
      digest: plan.digest,
    }),
  );
  await assert.rejects(
    verifyPlan(root, plan, { revision, target, digest: "0".repeat(64) }),
  );
});

test("a changed source, missing file or new file invalidates the plan", async (t) => {
  const root = await fixture(t);
  const plan = await createPlan(root, { revision, target });
  await writeFile(
    join(root, "supabase/functions/demo/index.ts"),
    "// changed\n",
  );
  await assert.rejects(
    verifyPlan(root, plan, { revision, target, digest: plan.digest }),
  );
  await writeFile(
    join(root, "supabase/functions/demo/index.ts"),
    'Deno.serve(() => new Response("ok"));\n',
  );
  await writeFile(
    join(root, "supabase/migrations/0002_new.sql"),
    "select 3;\n",
  );
  await assert.rejects(
    verifyPlan(root, plan, { revision, target, digest: plan.digest }),
  );
  await rm(join(root, "supabase/migrations/0002_new.sql"));
  await rm(join(root, "supabase/config.toml"));
  await assert.rejects(
    verifyPlan(root, plan, { revision, target, digest: plan.digest }),
  );
});

test("duplicate migration IDs and symlinked inputs are rejected", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "supabase/migrations/0001_collision.sql"),
    "select 4;\n",
  );
  await assert.rejects(createPlan(root, { revision, target }));
  await rm(join(root, "supabase/migrations/0001_collision.sql"));
  await symlink("/etc/hosts", join(root, "supabase/functions/demo/escape.ts"));
  await assert.rejects(createPlan(root, { revision, target }));
});

test("tampered operations or digest never verify, and production target is unavailable", async (t) => {
  const root = await fixture(t);
  const plan = await createPlan(root, { revision, target });
  await assert.rejects(
    verifyPlan(
      root,
      { ...plan, productionApplyAvailable: true },
      {
        revision,
        target,
        digest: plan.digest,
      },
    ),
  );
  await assert.rejects(createPlan(root, { revision, target: "production" }));
});

const baseline = {
  kind: "synthetic-sql-fixture",
  target,
  runId: "123:1",
  generation: 0,
  securityBoundary: true,
  completed: [],
};

test("exact operation binds artifact, observed baseline, run and recovery scope", async (t) => {
  const root = await fixture(t);
  const operation = await createOperationPlan(root, {
    revision,
    target,
    baseline,
  });
  assert.equal(operation.kind, "synthetic-exact-operation");
  assert.equal(operation.productionApplyAvailable, false);
  assert.equal(operation.expectedBaseline.generation, 0);
  await verifyOperationPlan(root, operation, {
    revision,
    target,
    baseline,
    digest: operation.digest,
  });
  for (
    const changed of [
      { ...baseline, runId: "124:1" },
      { ...baseline, generation: 1 },
      { ...baseline, securityBoundary: false },
    ]
  ) {
    await assert.rejects(
      verifyOperationPlan(root, operation, {
        revision,
        target,
        baseline: changed,
        digest: operation.digest,
      }),
    );
  }
  for (
    const key of [
      "artifactDigest",
      "operations",
      "expectedBaseline",
      "sourceRevision",
    ]
  ) {
    await assert.rejects(
      verifyOperationPlan(
        root,
        { ...operation, [key]: "tampered" },
        { revision, target, baseline, digest: operation.digest },
      ),
    );
  }
  await assert.rejects(
    createOperationPlan(root, { revision, target, baseline: undefined }),
  );
  await assert.rejects(
    createOperationPlan(root, { revision, target: "production", baseline }),
  );
  await assert.rejects(
    createOperationPlan(root, {
      revision,
      target,
      baseline: { ...baseline, completed: ["arbitrary-shell-command"] },
    }),
  );
});

test("new deployment workflow bytes participate in the rehearsal and operation digest", async (t) => {
  const root = await fixture(t);
  const path = join(root, ".github/workflows/supabase-deploy.yml");
  await writeFile(path, "exact-operation-source\n");
  const operation = await createOperationPlan(root, {
    revision,
    target,
    baseline,
  });
  await writeFile(path, "changed-workflow\n");
  await assert.rejects(
    verifyOperationPlan(root, operation, {
      revision,
      target,
      baseline,
      digest: operation.digest,
    }),
  );
});

test("settings endpoint binds every shared runtime source and rejects source drift", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "supabase/functions/sync-settings"), {
    recursive: true,
  });
  await writeFile(
    join(root, "supabase/functions/sync-settings/index.ts"),
    "// settings entrypoint\n",
  );
  await writeFile(
    join(root, ".github/workflows/supabase-settings-rehearsal.yml"),
    "// settings workflow\n",
  );
  await assert.rejects(createPlan(root, { revision, target }));
  for (const path of settingsRuntimeSources) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "// maintained runtime\n");
  }
  const plan = await createPlan(root, { revision, target });
  assert.deepEqual(
    plan.files.filter((f) => f.path.startsWith("packages/")).map((f) => f.path)
      .sort(),
    [...settingsRuntimeSources].sort(),
  );
  for (const path of settingsRuntimeSources) {
    await writeFile(join(root, path), "// changed runtime\n");
    await assert.rejects(
      verifyPlan(root, plan, { revision, target, digest: plan.digest }),
    );
    await writeFile(join(root, path), "// maintained runtime\n");
  }
});
