import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  assertSettingsRuntimeClosure,
  createOperationPlan,
  createPlan,
  settingsRuntimeSources,
  verifyOperationPlan,
  verifyPlan,
} from "./plan.mjs";

test("actual Deno closure binds every dependency and pinned CLI raw resolution", async (t) => {
  const checkout = fileURLToPath(new URL("../../", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "still-settings-cold-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Neither the global Deno cache nor a checkout's node_modules may satisfy
  // this resolution: exercise the real function config in a fresh source tree.
  await cp(
    join(checkout, "supabase/functions/_shared"),
    join(root, "supabase/functions/_shared"),
    {
      recursive: true,
      filter: (path) => path.endsWith("_shared") || path.endsWith(".ts"),
    },
  );
  for (
    const path of [
      ...settingsRuntimeSources,
      "supabase/functions/deno.json",
      "supabase/functions/deno.lock",
      "supabase/functions/sync-settings/index.ts",
      "supabase/functions/sync-settings/deno.json",
      "supabase/functions/sync-settings/deno.lock",
    ]
  ) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await cp(join(checkout, path), join(root, path));
  }
  const mapPath = join(root, "supabase/functions/sync-settings/deno.json");
  const config = JSON.parse(await readFile(mapPath, "utf8"));
  const { imports } = config;
  assert.deepEqual(config.lock, { path: "./deno.lock", frozen: true });
  const functionLockPath = join(
    root,
    "supabase/functions/sync-settings/deno.lock",
  );
  const functionLockBytes = await readFile(functionLockPath, "utf8");
  const rootLockPath = join(root, "supabase/functions/deno.lock");
  const rootLockBytes = await readFile(rootLockPath, "utf8");
  const functionLock = JSON.parse(functionLockBytes);
  const lock = JSON.parse(rootLockBytes);
  assert.deepEqual(functionLock.npm, lock.npm);
  assert.deepEqual(functionLock.jsr, lock.jsr);
  const denoEnv = { ...process.env, DENO_DIR: join(root, "empty-deno-cache") };
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
      { encoding: "utf8", env: denoEnv },
    ),
  );
  // CLI serve selects this nearest function config. Its scoped frozen lock
  // preserves the entire reviewed graph, including transitive dependencies.
  const rootImports = JSON.parse(
    await readFile(join(root, "supabase/functions/deno.json"), "utf8"),
  ).imports;
  for (const [alias, specifier] of Object.entries(rootImports)) {
    if (!specifier.startsWith("npm:") && !specifier.startsWith("jsr:")) {
      continue;
    }
    const match = /^(npm:|jsr:)(@?[^@]+)@([^/]+)(.*)$/.exec(specifier);
    assert(match, alias);
    const [, protocol, name, range, suffix] = match;
    const version = lock.specifiers[`${protocol}${name}@${range}`];
    assert(version, `Missing reviewed lock version: ${alias}`);
    assert.equal(
      imports[alias],
      `${protocol}${name}@${version}${suffix}`,
      alias,
    );
  }
  assert.deepEqual(
    Object.keys(graph.npmPackages).sort(),
    Object.keys(lock.npm).sort(),
  );
  assert.equal(await readFile(functionLockPath, "utf8"), functionLockBytes);
  assert.equal(await readFile(rootLockPath, "utf8"), rootLockBytes);
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
  for (const alias of ["./settings-v2.js", "./access.js"]) {
    const missingAlias = { ...imports };
    delete missingAlias[alias];
    assert.throws(
      () => assertSettingsRuntimeClosure(graph, root, missingAlias, mapPath),
      /CLI raw import/,
      alias,
    );
  }
  const scratch = await mkdtemp(join(tmpdir(), "still-settings-graph-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const graphSources = graph.modules.filter((m) =>
    m.local && m.specifier.startsWith("file:")
  ).map((m) => relative(root, m.local));
  for (
    const path of [
      ...graphSources,
      "supabase/functions/sync-settings/deno.json",
      "supabase/functions/sync-settings/deno.lock",
    ]
  ) {
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
      env: denoEnv,
    }),
  );
  assert.throws(
    () => assertSettingsRuntimeClosure(addedGraph, scratch, imports, extraMap),
    /manifest/,
  );
  // Frozen resolution must reject a missing exact alias instead of updating
  // the served artifact, even once the dependency cache has been populated.
  const incompleteLock = structuredClone(functionLock);
  delete incompleteLock.specifiers["npm:postgres@3.4.9"];
  await writeFile(functionLockPath, JSON.stringify(incompleteLock));
  assert.throws(
    () =>
      execFileSync("deno", [
        "info",
        "--json",
        "--config",
        mapPath,
        join(root, "supabase/functions/sync-settings/index.ts"),
      ], {
        encoding: "utf8",
        env: denoEnv,
        stdio: "pipe",
      }),
    /lockfile is out of date/,
  );
  assert.equal(
    await readFile(functionLockPath, "utf8"),
    JSON.stringify(incompleteLock),
  );
});

test("handler workflows run the retained limiter assertion with exact source-read permissions", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  for (const workflow of ["ci.yml", "supabase-settings-rehearsal.yml"]) {
    const source = await readFile(
      join(root, ".github/workflows", workflow),
      "utf8",
    );
    const command = source.match(/^\s*(?:run: )?(deno test[^\n]*)$/m)?.[1];
    assert(command, `Missing root handler test invocation: ${workflow}`);
    const args = command.split(/\s+/).slice(1);
    const permission = args.find((arg) => arg.startsWith("--allow-read="));
    assert.equal(
      permission,
      "--allow-read=../migrations/0013_counter_retention.sql,../migrations/0015_settings_sync_per_field.sql",
    );
    const options = {
      cwd: join(root, "supabase/functions"),
      encoding: "utf8",
      stdio: "pipe",
    };
    const entrypoint = "_shared/settings-store.test.ts";
    execFileSync("deno", [...args, "--no-prompt", entrypoint], options);
    assert.throws(
      () =>
        execFileSync("deno", [
          ...args.filter((arg) => arg !== permission),
          "--no-prompt",
          entrypoint,
        ], options),
      (error) =>
        error.status === 1 && /Requires read access/.test(error.stdout),
    );
  }
});

test("migration 0015 structural constants and fields equal the maintained grammar", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sql = await readFile(
    join(root, "supabase/migrations/0015_settings_sync_per_field.sql"),
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
  for (const [key, pattern] of Object.entries(checks)) {
    assert.equal(Number(pattern.exec(sql)?.[1]), values[key], key);
  }
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
    /create or replace function private\.settings_fields\(\)[\s\S]*?select array\[([^\]]+)\]/
      .exec(sql)[1]
      .split(",")
      .map((s) => s.trim().slice(1, -1));
  assert.deepEqual(actual, maintained.fields);
  assert.equal(maintained.servicePrefixes, true);
  assert.deepEqual(
    /core_sites constant text\[\] := array\[([^\]]+)\]/.exec(sql)[1].split(",")
      .map((s) => s.trim().slice(1, -1)),
    maintained.coreSites,
  );
});

test("0015 post-apply verification pins the migration's exact routine bodies", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const migration = await readFile(
    join(root, "supabase/migrations/0015_settings_sync_per_field.sql"),
    "utf8",
  );
  const verification = await readFile(
    join(root, "scripts/backend/deploy/verify/0015_settings_sync_per_field.sql"),
    "utf8",
  );
  // PostgreSQL stores the text between the dollar quotes verbatim as prosrc.
  function body(name) {
    const start = migration.indexOf(`create or replace function ${name}(`);
    assert(start >= 0, `${name} defined`);
    assert.equal(
      migration.indexOf(`create or replace function ${name}(`, start + 1),
      -1,
      `${name} defined once`,
    );
    const open = migration.indexOf("$$", start);
    const close = migration.indexOf("$$", open + 2);
    return createHash("md5").update(migration.slice(open + 2, close)).digest("hex");
  }
  const pinned = new Map(
    [...verification.matchAll(/\('((?:private|public)\.[a-z_]+)\([^)]*\)'(?:, (?:true|false), (?:true|false)|, '[a-z_]+'), '([0-9a-f]{32})'\)/g)]
      .map((m) => [m[1], m[2]]),
  );
  assert.deepEqual([...pinned.keys()].sort(), [
    "private.claim_settings_write",
    "private.cleanup_settings_writes",
    "private.commit_settings",
    "private.lock_settings",
    "private.settings_canonical_valid",
    "private.settings_fields",
    "private.settings_json_bounded",
    "public.consume_rate_limit",
    "public.write_profile_settings",
  ]);
  for (const [name, digest] of pinned) assert.equal(body(name), digest, name);
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

test("function lock bytes participate in the rehearsal and exact operation digest", async (t) => {
  const root = await fixture(t);
  const path = join(root, "supabase/functions/demo/deno.lock");
  await writeFile(path, '{"version":"5","specifiers":{}}\n');
  const plan = await createPlan(root, { revision, target });
  const operation = await createOperationPlan(root, {
    revision,
    target,
    baseline,
  });
  assert(
    plan.files.some((file) =>
      file.path === "supabase/functions/demo/deno.lock"
    ),
  );
  await writeFile(path, '{"version":"5","specifiers":{"changed":"1"}}\n');
  await assert.rejects(
    verifyPlan(root, plan, { revision, target, digest: plan.digest }),
  );
  await assert.rejects(verifyOperationPlan(root, operation, {
    revision,
    target,
    baseline,
    digest: operation.digest,
  }));
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
