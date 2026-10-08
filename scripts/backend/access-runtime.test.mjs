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
import { dirname, join } from "node:path";
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
