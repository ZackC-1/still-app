import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertSettingsRuntimeClosure } from "./plan.mjs";
import {
  assertIndependentVerifications,
  createDeployPlan,
  defaultExec,
  makeGit,
  TOOLING_PATHS,
  lintVerificationSql,
} from "./deploy/deploy.mjs";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const shared = [
  "index",
  "rules",
  "settings",
  "entitlement",
  "feature-registry",
  "settings-v2",
  "settings-operation",
  "access",
  "access-wire",
].map((name) => `packages/shared-types/src/${name}.ts`);
const functions = [
  "verify-apple-access",
  "link-apple-access",
  "reconcile-entitlement",
];

test("every enabled sandbox entrypoint resolves CLI raw imports to its Deno graph", async (t) => {
  const source = await readFile(join(checkout, "supabase/config.toml"), "utf8");
  for (const name of [
    "verify-apple-access", "link-apple-access", "reconcile-entitlement", "product-policy",
    "sync-settings", "create-web-checkout", "complete-web-checkout", "stripe-webhook",
  ]) {
    await t.test(name, async () => {
      const route = `qa-sandbox-${name}`;
      const block = source.split(`[functions.${route}]\n`)[1]?.split("\n[")[0];
      assert.ok(block, `Missing enabled ${route}`);
      const selected = block.match(/^import_map = "([^"]+)"$/m)?.[1];
      assert.ok(selected, `Missing ${route} import map`);
      const mapPath = join(checkout, "supabase", selected);
      const imports = JSON.parse(await readFile(mapPath, "utf8")).imports;
      // Deno supplies the independent resolved target; the pinned CLI instead looks up
      // each raw specifier in the selected map before walking every enabled route.
      const graph = JSON.parse(execFileSync("deno", [
        "info", "--json", "--frozen", "--config",
        join(checkout, `supabase/functions/${route}/deno.json`),
        join(checkout, `supabase/functions/${route}/index.ts`),
      ], { encoding: "utf8", stdio: "pipe" }));
      assert.ok(graph.modules.every(module => !module.error));
      const sources = graph.modules.filter(module => module.local &&
        relative(checkout, module.local).startsWith("packages/"))
        .map(module => relative(checkout, module.local));
      assert.doesNotThrow(() => assertSettingsRuntimeClosure(
        graph, checkout, imports, mapPath, sources,
      ));
    });
  }
});

test("three actual access entrypoints have frozen cold Deno and pinned CLI raw closure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "still-access-cold-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(
    join(checkout, "supabase/functions/_shared"),
    join(root, "supabase/functions/_shared"),
    { recursive: true },
  );
  for (const path of [
    ...shared,
    "supabase/functions/deno.lock",
    ...functions.flatMap((name) => [
      `supabase/functions/${name}/index.ts`,
      `supabase/functions/${name}/deno.json`,
      ...(name === "reconcile-entitlement"
        ? [`supabase/functions/${name}/handler.ts`]
        : []),
    ]),
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(checkout, path), join(root, path));
  }
  const lockPath = join(root, "supabase/functions/deno.lock");
  const lockBytes = await readFile(lockPath, "utf8");
  const lock = JSON.parse(lockBytes);
  const env = { ...process.env, DENO_DIR: join(root, "empty-cache") };
  for (const name of functions) {
    const mapPath = join(root, `supabase/functions/${name}/deno.json`);
    const config = JSON.parse(await readFile(mapPath, "utf8"));
    assert.deepEqual(config.lock, { path: "../deno.lock", frozen: true });
    const entry = join(root, `supabase/functions/${name}/index.ts`);
    const graph = JSON.parse(
      execFileSync(
        "deno",
        ["info", "--json", "--frozen", "--config", mapPath, entry],
        { encoding: "utf8", env, stdio: "pipe" },
      ),
    );
    assert.deepEqual(
      Object.keys(graph.npmPackages).sort(),
      Object.keys(lock.npm).sort(),
      name,
    );
    assert.deepEqual(
      assertSettingsRuntimeClosure(
        graph,
        root,
        config.imports,
        mapPath,
        shared,
      ),
      [...shared].sort(),
    );
    for (const alias of ["./access.js", "./access-wire.js"]) {
      const imports = { ...config.imports };
      delete imports[alias];
      assert.throws(
        () =>
          assertSettingsRuntimeClosure(graph, root, imports, mapPath, shared),
        /CLI raw import/,
        `${name}:${alias}`,
      );
    }
    // A warm dependency cache cannot mask an unbound newly imported first-party source.
    const extra = "packages/shared-types/src/cold-negative-control.ts";
    await writeFile(join(root, extra), "export const marker = 1;\n");
    const original = await readFile(entry, "utf8");
    await writeFile(entry, original + `\nimport "../../../${extra}";\n`);
    const expanded = JSON.parse(
      execFileSync(
        "deno",
        ["info", "--json", "--frozen", "--config", mapPath, entry],
        { encoding: "utf8", env, stdio: "pipe" },
      ),
    );
    assert.throws(
      () =>
        assertSettingsRuntimeClosure(
          expanded,
          root,
          config.imports,
          mapPath,
          shared,
        ),
      /manifest/,
    );
    await writeFile(entry, original);
    assert.equal(await readFile(lockPath, "utf8"), lockBytes);
  }
  const changed = structuredClone(lock);
  delete changed.specifiers["npm:pkijs@3.4.1"];
  await writeFile(lockPath, JSON.stringify(changed));
  assert.throws(
    () =>
      execFileSync(
        "deno",
        [
          "info",
          "--json",
          "--frozen",
          "--config",
          join(root, "supabase/functions/verify-apple-access/deno.json"),
          join(root, "supabase/functions/verify-apple-access/index.ts"),
        ],
        { encoding: "utf8", env, stdio: "pipe" },
      ),
    /lockfile is out of date/,
  );
});

test("0019 and corrected 0020 are read-only gates with a required separate operation boundary", async () => {
  const migrations = [];
  for (const stem of [
    "0019_scoped_access_rights",
    "0020_apple_scoped_access",
  ]) {
    const verificationSource = await readFile(
      join(checkout, `scripts/backend/deploy/verify/${stem}.sql`),
      "utf8",
    );
    const invariant = await readFile(
      join(checkout, `scripts/backend/deploy/verify/${stem}.invariant.sql`),
      "utf8",
    );
    assert.equal(lintVerificationSql(verificationSource), true);
    assert.equal(lintVerificationSql(invariant), true);
    migrations.push({
      text: await readFile(
        join(checkout, `supabase/migrations/${stem}.sql`),
        "utf8",
      ),
      verificationText: verificationSource,
      file: stem + ".sql",
    });
  }
  assert.throws(
    () => assertIndependentVerifications(migrations),
    /deploy 0019_scoped_access_rights.sql alone/,
  );
  for (const migration of migrations)
    assert.doesNotThrow(() => assertIndependentVerifications([migration]));
});

test("served fixture keeps actual entrypoints and checks the substituted provider closure", async (t) => {
  const { prepareAccessFixture } = await import("./prepare-access-fixture.mjs");
  const root = await mkdtemp(join(tmpdir(), "still-access-served-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envFile = join(root, "private.env"),
    stateFile = join(root, "state.json");
  await prepareAccessFixture(checkout, root, envFile, stateFile);
  // CLI 2.119.0 discovers and walks every enabled function before runtime startup,
  // including policy routes outside the three substituted access providers.
  const policyPath = "packages/shared-types/src/product-policy.ts";
  assert.equal(
    await readFile(join(root, policyPath), "utf8"),
    await readFile(join(checkout, policyPath), "utf8"),
  );
  for (const name of ["product-policy", "product-policy-admin"]) {
    const graph = JSON.parse(execFileSync("deno", [
      "info", "--json", "--frozen", "--config",
      join(root, "supabase/functions/deno.json"),
      join(root, `supabase/functions/${name}/index.ts`),
    ], { encoding: "utf8", stdio: "pipe" }));
    assert.ok(graph.modules.some((module) => module.local === join(root, policyPath)));
    assert.ok(graph.modules.every((module) => !module.error));
  }
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.match(state.kid, /^access-rehearsal-[a-f0-9-]+$/);
  assert.match(state.publicHex, /^[a-f0-9]{64}$/);
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  for (const name of functions) {
    assert.equal(
      await readFile(join(root, `supabase/functions/${name}/index.ts`), "utf8"),
      await readFile(
        join(checkout, `supabase/functions/${name}/index.ts`),
        "utf8",
      ),
    );
    const actual = JSON.parse(
      await readFile(
        join(checkout, `supabase/functions/${name}/deno.json`),
        "utf8",
      ),
    );
    const config = JSON.parse(
      await readFile(
        join(root, `supabase/functions/${name}/deno.json`),
        "utf8",
      ),
    );
    for (const [alias, target] of Object.entries(actual.imports))
      assert.equal(config.imports[alias], target);
    assert.deepEqual(config.lock, actual.lock);
    assert.equal(
      Object.keys(config.imports).length - Object.keys(actual.imports).length,
      6,
    );
    const graph = JSON.parse(
      execFileSync(
        "deno",
        [
          "info",
          "--json",
          "--frozen",
          "--config",
          join(root, `supabase/functions/${name}/deno.json`),
          join(root, `supabase/functions/${name}/index.ts`),
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    );
    assert.deepEqual(
      assertSettingsRuntimeClosure(
        graph,
        root,
        config.imports,
        join(root, `supabase/functions/${name}/deno.json`),
        shared,
      ),
      [...shared].sort(),
    );
    execFileSync(
      "deno",
      [
        "check",
        "--frozen",
        "--config",
        join(root, `supabase/functions/${name}/deno.json`),
        join(root, `supabase/functions/${name}/index.ts`),
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
  }
  for (const name of [
    "apple-fulfillment",
    "apple-account-access",
    "pg-access-store",
    "apple-access-store",
    "access-issuer",
    "auth",
    "jwt",
    "pg-store",
  ]) {
    assert.equal(
      await readFile(
        join(root, `supabase/functions/_shared/${name}.ts`),
        "utf8",
      ),
      await readFile(
        join(checkout, `supabase/functions/_shared/${name}.ts`),
        "utf8",
      ),
    );
  }
});

test("actual deploy planner accepts the intermediate 0019 commit then exact 0020, refusing combined or incomplete tails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "still-access-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Synthetic operation fixture");
  git("config", "user.email", "access-operation@example.invalid");
  git("config", "commit.gpgsign", "false");
  const copy = async (path) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(checkout, path), join(root, path));
  };
  for (const path of [
    ...TOOLING_PATHS,
    "supabase/config.toml",
    ...["0019_scoped_access_rights", "0020_apple_scoped_access"].flatMap(
      (stem) => [
        `scripts/backend/deploy/verify/${stem}.sql`,
        `scripts/backend/deploy/verify/${stem}.invariant.sql`,
      ],
    ),
  ])
    await copy(path);
  for (const name of await readdir(join(checkout, "supabase/migrations"))) {
    if (name.endsWith(".sql") && name.split("_")[0] < "0019")
      await copy(`supabase/migrations/${name}`);
  }
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  commit("Synthetic released 0018 baseline");
  await copy("supabase/migrations/0019_scoped_access_rights.sql");
  const first = commit("Synthetic separate 0019 operation");
  await copy("supabase/migrations/0020_apple_scoped_access.sql");
  const second = commit("Synthetic separate 0020 operation");
  const plan = (sha, migrations) =>
    createDeployPlan({ git: makeGit(defaultExec, root), sha, migrations });
  assert.deepEqual(
    (await plan(first, "0019_scoped_access_rights.sql")).migrations.map(
      (m) => m.file,
    ),
    ["0019_scoped_access_rights.sql"],
  );
  assert.deepEqual(
    (await plan(second, "0020_apple_scoped_access.sql")).migrations.map(
      (m) => m.file,
    ),
    ["0020_apple_scoped_access.sql"],
  );
  await assert.rejects(
    plan(second, "0019_scoped_access_rights.sql"),
    (error) => error.category === "not-pending-tail",
  );
  await assert.rejects(
    plan(second, "0019_scoped_access_rights.sql,0020_apple_scoped_access.sql"),
    (error) => error.category === "verification-overlap",
  );
});

test("both hosted access database scripts reject before planning or Docker on ordinary machines", () => {
  for (const name of ["rehearse.sh", "rehearse-access.sh"]) {
    assert.throws(
      () =>
        execFileSync("bash", [join(checkout, `scripts/backend/${name}`)], {
          cwd: checkout,
          encoding: "utf8",
          stdio: "pipe",
          env: {
            ...process.env,
            GITHUB_ACTIONS: "false",
            RUNNER_ENVIRONMENT: "github-hosted",
          },
        }),
      (error) =>
        error.status === 1 &&
        error.stderr.trim() ===
          "Cloud rehearsal requires an ephemeral GitHub-hosted Linux runner.",
    );
  }
});

test("access CLI diagnostics emit only closed phases/categories from synthetic private logs", async () => {
  const { classifyAccessCliFailure } = await import(
    "./access-cli-diagnostics.mjs"
  );
  const privateText = "synthetic-private-token-account-path-message";
  for (
    const [text, category] of [
      ["InvalidWorkerCreation: worker boot error", "boot"],
      ["Module not found", "import-resolution"],
      ["failed to read path", "mount"],
      ["Could not find npm package", "npm"],
      ["PostgresError 42501", "privilege"],
    ]
  ) {
    assert.deepEqual(
      classifyAccessCliFailure(`${text} ${privateText}`, "synthetic"),
      { accessCliFailure: { phase: "synthetic", categories: [category] } },
    );
  }
  const unknown = classifyAccessCliFailure(privateText, privateText);
  assert.deepEqual(unknown, {
    accessCliFailure: { phase: "unknown", categories: [] },
  });
  assert(!JSON.stringify(unknown).includes(privateText));
  assert.deepEqual(
    classifyAccessCliFailure(
      "worker boot worker boot failed to read path 28P01",
      "default",
    ),
    {
      accessCliFailure: {
        phase: "default",
        categories: ["boot", "mount", "privilege"],
      },
    },
  );
});

test("access CLI diagnostics retain bounded file/stream tails without leaking private content", async (t) => {
  const { Readable } = await import("node:stream");
  const { DIAGNOSTIC_BYTE_LIMIT, readDiagnosticTail, collectDiagnosticTail } =
    await import("./access-cli-diagnostics.mjs");
  const root = await mkdtemp(join(tmpdir(), "still-diagnostic-tail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "synthetic.log");
  const text = "discard-private-prefix".repeat(100_000) +
    "\nfailed to read path synthetic-private-tail";
  await writeFile(path, text);
  const expected = Buffer.from(text).subarray(-DIAGNOSTIC_BYTE_LIMIT).toString(
    "utf8",
  );
  assert.equal(readDiagnosticTail(path), expected);
  assert.equal(
    await collectDiagnosticTail(
      Readable.from([
        Buffer.from(text.slice(0, 100)),
        Buffer.from(text.slice(100)),
      ]),
    ),
    expected,
  );
  assert.equal(readDiagnosticTail(join(root, "absent")), "");
  const output = execFileSync(process.execPath, [
    join(checkout, "scripts/backend/access-cli-diagnostics.mjs"),
    path,
    "synthetic-private-phase",
  ], { input: text, encoding: "utf8", maxBuffer: 2048 });
  assert.deepEqual(JSON.parse(output), {
    accessCliFailure: { phase: "unknown", categories: ["mount"] },
  });
  assert(!output.includes("synthetic-private"));
});

test("access served failure diagnostics keep exit1 and cleanup with exact ephemeral container only", async (t) => {
  const shell = await readFile(
    join(checkout, "scripts/backend/rehearse-access.sh"),
    "utf8",
  );
  const probe = shell.slice(
    shell.indexOf("served_test() {"),
    shell.indexOf("\nread_mount() {"),
  );
  assert.match(
    probe,
    /timeout 5s docker logs --tail 200 supabase_edge_runtime_still-app 2>&1/,
  );
  assert.match(
    probe.replaceAll("\\\n", ""),
    /\|\s*node scripts\/backend\/access-cli-diagnostics\.mjs/,
  );
  assert.match(shell, /trap cleanup EXIT/);
  const root = await mkdtemp(join(tmpdir(), "still-diagnostic-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "access-serve.log"),
    "synthetic-private-token-account-log",
  );
  for (const failure of ["boot", "log-unavailable", "classifier-unavailable"]) {
    const stubs =
      `set -euo pipefail\nserve_pid=synthetic\nkill(){ return 0; }\ndeno(){ return 1; }\ntimeout(){ [[ $1 == 5s ]]; shift; "$@"; }\ndocker(){ [[ "$*" == 'logs --tail 200 supabase_edge_runtime_still-app' ]]; ${
        failure === "log-unavailable"
          ? "return 7;"
          : "printf '%s\\n' 'InvalidWorkerCreation synthetic-private-token-account-path';"
      } }\n${
        failure === "classifier-unavailable" ? "node(){ return 9; }" : ""
      }\ntrap 'printf "%s\\n" closed-cleanup' EXIT\n`;
    assert.throws(
      () =>
        execFileSync("bash", [
          "-c",
          stubs + probe + "\nserved_test\nprintf unexpected-success",
        ], {
          cwd: checkout,
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            STILL_ACCESS_SERVED_PHASE: "synthetic",
          },
          encoding: "utf8",
          stdio: "pipe",
        }),
      (error) => {
        assert.equal(error.status, 1);
        assert(error.stdout.includes("closed-cleanup"));
        assert(!error.stdout.includes("unexpected-success"));
        assert(!error.stdout.includes("synthetic-private"));
        if (failure !== "classifier-unavailable") {
          assert.deepEqual(JSON.parse(error.stdout.split("\n")[0]), {
            accessCliFailure: {
              phase: "synthetic",
              categories: failure === "boot" ? ["boot"] : [],
            },
          });
        }
        return true;
      },
    );
  }
});
