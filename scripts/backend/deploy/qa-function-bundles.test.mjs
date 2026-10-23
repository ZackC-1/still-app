import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { defaultExec } from "./deploy.mjs";
import {
  ANALYTICS_FUNCTIONS,
  ANALYTICS_BUNDLE_SET,
  ANALYTICS_SWITCH_BUNDLE_SET,
  buildFunctionBundles,
  buildQaFunctionBundles,
  PURCHASE_BUNDLE_SET,
  PURCHASE_FUNCTIONS,
  QA_FUNCTIONS,
  REVIEW_SIGNIN_BUNDLE_SET,
  REVIEW_SIGNIN_FUNCTIONS,
  sealQaRuntime,
  SYNC_SETTINGS_BUNDLE_SET,
  SYNC_SETTINGS_FUNCTIONS,
  verifyFunctionBundles,
  verifyQaFunctionBundles,
} from "./qa-function-bundles.mjs";

async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}

async function fixture(t, { routes = QA_FUNCTIONS, perRouteConfig = true } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "still-qa-bundle-test-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, "source");
  const artifactDir = join(root, "uploads");
  await mkdir(artifactDir);
  await put(
    sourceDir,
    "supabase/config.toml",
    routes.map(({ name, verifyJwt }) =>
      `[functions.${name}]\nverify_jwt = ${verifyJwt}\n${
        perRouteConfig ? `import_map = "./functions/${name}/deno.json"\n` : ""
      }`
    ).join("\n"),
  );
  await put(sourceDir, "supabase/functions/deno.json", "{}\n");
  await put(
    sourceDir,
    "supabase/functions/deno.lock",
    '{"version":"5","npm":{},"jsr":{}}\n',
  );
  await put(
    sourceDir,
    "packages/shared-types/src/product-policy.ts",
    'export const value = "qa";\n',
  );
  for (
    const path of [
      "scripts/backend/deploy/qa-function-bundles.mjs",
      "scripts/backend/deploy/deploy.mjs",
      "scripts/backend/plan.mjs",
    ]
  ) {
    await put(sourceDir, path, "bound compiler tooling\n");
  }
  for (const { name } of routes) {
    await put(
      sourceDir,
      `supabase/functions/${name}/index.ts`,
      'import "../../../packages/shared-types/src/product-policy.ts";\n',
    );
    if (perRouteConfig) {
      await put(sourceDir, `supabase/functions/${name}/deno.json`, "{}\n");
    }
  }
  const state = {
    version: "2.8.3",
    extraSource: false,
    escapedUpload: false,
    unresolvedUpload: false,
  };
  const exec = async (_cmd, args) => {
    if (args[0] === "--version") {
      return {
        code: 0,
        stdout:
          `deno ${state.version} (stable, release, test)\nv8 test\ntypescript test\n`,
      };
    }
    if (args[0] === "bundle") {
      await writeFile(
        args.find((x) => x.startsWith("--output=")).slice(9),
        'export const closed = "qa";\n',
      );
      return { code: 0, stdout: "" };
    }
    const path = args.at(-1);
    if (path.endsWith(".js")) {
      const root = pathToFileURL(path).href;
      const dependencies = state.unresolvedUpload
        ? [{ specifier: "./missing.js", code: { error: "Missing" } }]
        : [];
      return {
        code: 0,
        stdout: JSON.stringify({
          roots: [root],
          modules: [
            { kind: "esm", specifier: root, local: path, dependencies },
            ...(state.escapedUpload
              ? [{
                kind: "npm",
                specifier: "npm:unbound@1",
                npmPackage: "unbound@1",
              }]
              : []),
          ],
          redirects: {},
        }),
      };
    }
    const entry = join(sourceDir, path);
    const dependency = join(
      sourceDir,
      "packages/shared-types/src/product-policy.ts",
    );
    const modules = [
      entry,
      dependency,
      ...(state.extraSource
        ? [join(sourceDir, "packages/shared-types/src/extra.ts")]
        : []),
    ]
      .map((local) => ({
        kind: "esm",
        specifier: pathToFileURL(local).href,
        local,
        dependencies: [],
      }));
    return {
      code: 0,
      stdout: JSON.stringify({
        roots: [pathToFileURL(entry).href],
        modules,
        redirects: {},
        npmPackages: {},
      }),
    };
  };
  return { sourceDir, artifactDir, exec, state };
}

test("seals all fixed uploads and verifies their actual bytes and source closure", async (t) => {
  const options = await fixture(t);
  const manifest = await buildQaFunctionBundles(options);
  assert.equal(
    manifest.toolchain.runtimeGlobals,
    "node-buffer-global-timers-v3",
  );
  assert.deepEqual(
    manifest.functions.map(({ name, verifyJwt }) => ({ name, verifyJwt })),
    QA_FUNCTIONS,
  );
  assert.equal(
    manifest.sources.some(({ path }) =>
      path === "packages/shared-types/src/product-policy.ts"
    ),
    true,
  );
  assert.equal(JSON.stringify(manifest).includes(options.sourceDir), false);
  assert.equal(await verifyQaFunctionBundles({ ...options, manifest }), true);
  await writeFile(
    join(options.artifactDir, manifest.functions[0].file),
    "export const tampered = true;",
  );
  await assert.rejects(
    verifyQaFunctionBundles({ ...options, manifest }),
    /bundle bytes/i,
  );
});

test("rejects a missing workspace source before producing uploads", async (t) => {
  const options = await fixture(t);
  await rm(
    join(options.sourceDir, "packages/shared-types/src/product-policy.ts"),
  );
  await assert.rejects(buildQaFunctionBundles(options), /source|ENOENT/i);
});

test("rejects JWT configuration drift before producing uploads", async (t) => {
  const options = await fixture(t);
  const path = join(options.sourceDir, "supabase/config.toml");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "verify_jwt = false",
      "verify_jwt = true",
    ),
  );
  await assert.rejects(buildQaFunctionBundles(options), /JWT/i);
});

test("rejects source hash drift and newly unbound transitive sources at verification", async (t) => {
  const options = await fixture(t);
  const manifest = await buildQaFunctionBundles(options);
  await put(
    options.sourceDir,
    "packages/shared-types/src/product-policy.ts",
    "changed source",
  );
  await assert.rejects(
    verifyQaFunctionBundles({ ...options, manifest }),
    /source/i,
  );
  await put(
    options.sourceDir,
    "packages/shared-types/src/product-policy.ts",
    'export const value = "qa";\n',
  );
  await put(
    options.sourceDir,
    "packages/shared-types/src/extra.ts",
    "new dependency",
  );
  options.state.extraSource = true;
  await assert.rejects(
    verifyQaFunctionBundles({ ...options, manifest }),
    /source/i,
  );
});

for (const failure of ["escapedUpload", "unresolvedUpload"]) {
  test(`rejects ${failure} in the upload graph`, async (t) => {
    const options = await fixture(t);
    options.state[failure] = true;
    await assert.rejects(
      buildQaFunctionBundles(options),
      /upload|bundle|graph/i,
    );
  });
}

test("refuses a different compiler version and a symlinked workspace source", async (t) => {
  const options = await fixture(t);
  options.state.version = "2.8.4";
  await assert.rejects(buildQaFunctionBundles(options), /Deno/i);
  options.state.version = "2.8.3";
  const path = join(
    options.sourceDir,
    "packages/shared-types/src/product-policy.ts",
  );
  await rm(path);
  await symlink(join(options.sourceDir, "supabase/functions/deno.json"), path);
  await assert.rejects(buildQaFunctionBundles(options), /symlink/i);
});

test("refuses artifact inventory changes and missing fixed route metadata", async (t) => {
  const options = await fixture(t);
  const manifest = await buildQaFunctionBundles(options);
  await put(options.artifactDir, "unapproved.js", "extra");
  await assert.rejects(
    verifyQaFunctionBundles({ ...options, manifest }),
    /inventory/i,
  );
  await rm(join(options.artifactDir, "unapproved.js"));
  await assert.rejects(
    verifyQaFunctionBundles({
      ...options,
      manifest: { ...manifest, functions: manifest.functions.slice(1) },
    }),
    /manifest/i,
  );
});

const REQUIRE_PROLOGUE =
  'import{createRequire as __deno_internal_createRequire} from "node:module";var __require=__deno_internal_createRequire(import.meta.url);';

test("CommonJS runtime resolves builtins and refuses out-of-band files and optional packages", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "still-qa-require-boundary-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "unapproved.cjs", "module.exports = 'out-of-band source';");
  const module = join(root, "closed.mjs");
  await writeFile(
    module,
    sealQaRuntime(REQUIRE_PROLOGUE + "export { __require as load };\n"),
  );
  const { load } = await import(pathToFileURL(module).href);
  assert.equal(typeof load("node:crypto").createHash, "function");
  assert.throws(() => load("./unapproved.cjs"), /Unbound QA runtime require/);
  assert.throws(() => load("encoding"), /Unbound QA runtime require/);
});

test("CommonJS compiler prologue drift fails before sealing arbitrary source", () => {
  assert.throws(
    () =>
      sealQaRuntime(
        REQUIRE_PROLOGUE.replace("import.meta.url", '"unbound.js"') +
          "export const x=1;",
      ),
    /prologue/i,
  );
});

// Explicitly enabled by the protected bundle rehearsal, which installs Deno
// 2.8.3. Ordinary offline Node checks retain their synthetic boundary coverage.
test(
  "sealed immediate timers schedule and cancel without ambient Node globals",
  { skip: process.env.STILL_QA_BUNDLE_INTEGRATION !== "1" },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "still-qa-timer-boundary-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const probe = join(root, "timers.mjs");
    await writeFile(
      probe,
      sealQaRuntime(`
      delete globalThis.Buffer;
      delete globalThis.global;
      delete globalThis.setImmediate;
      delete globalThis.clearImmediate;
      if (typeof globalThis.setImmediate !== 'undefined' ||
          typeof globalThis.clearImmediate !== 'undefined') throw new Error('Ambient timer mutation');
      let cancelledRan = false;
      const cancelled = setImmediate(() => { cancelledRan = true; });
      clearImmediate(cancelled);
      await new Promise((resolve) => setImmediate(resolve));
      if (cancelledRan) throw new Error('Cancelled callback ran');
      console.log('sealed timers passed without ambient globals');
    `),
    );
    const result = await defaultExec("deno", [
      "run",
      "--no-config",
      "--no-lock",
      `--allow-read=${root}`,
      "--deny-net",
      "--deny-env",
      "--deny-write",
      "--deny-run",
      probe,
    ], { cwd: root });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /sealed timers passed without ambient globals/);
  },
);

test(
  "actual eight-route bundles are portable, closed, and start without authority",
  {
    skip: process.env.STILL_QA_BUNDLE_INTEGRATION !== "1",
  },
  async (t) => {
    const sourceDir = await realpath(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    );
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "still-qa-bundle-integration-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const artifactDir = join(root, "first-uploads");
    const manifest = await buildQaFunctionBundles({ sourceDir, artifactDir });
    assert.equal(manifest.functions.length, 8);
    assert.equal(JSON.stringify(manifest).includes(sourceDir), false);
    const copiedSource = join(root, "copied-source");
    for (const { path } of manifest.sources) {
      await put(copiedSource, path, await readFile(join(sourceDir, path)));
    }
    const copied = await buildQaFunctionBundles({
      sourceDir: copiedSource,
      artifactDir: join(root, "second-uploads"),
    });
    assert.deepEqual(
      copied,
      manifest,
      "source/upload hashes must not depend on checkout or artifact paths",
    );

    // Expose the maintained crypto implementation only in this owned fixture.
    // Exercise SDK construction and malformed proof rejection after sealing,
    // beyond the route's deliberately unavailable configuration control.
    const sdkEntry =
      "supabase/functions/qa-sandbox-verify-apple-access/index.ts";
    const sdkSource = await readFile(join(copiedSource, sdkEntry), "utf8");
    await put(
      copiedSource,
      sdkEntry,
      sdkSource + `
      export { EdgeAppleSignedDataVerifier } from '../_shared/apple-edge-verifier.ts';
      export { APPLE_ROOT_CERTIFICATES } from '../_shared/apple-roots.ts';
      export { Environment } from '@apple/app-store-server-library';
    `,
    );
    const sdkBundle = join(root, "sdk-fixture.js");
    const sdkCompiled = await defaultExec("deno", [
      "bundle",
      ...manifest.toolchain.flags,
      `--output=${sdkBundle}`,
      sdkEntry,
    ], { cwd: copiedSource });
    assert.equal(sdkCompiled.code, 0, sdkCompiled.stderr);
    await writeFile(
      sdkBundle,
      sealQaRuntime(await readFile(sdkBundle, "utf8")),
    );
    await put(copiedSource, sdkEntry, sdkSource);

    const probe = join(root, "startup.mjs");
    await writeFile(
      probe,
      `
    import assert from 'node:assert/strict';
    delete globalThis.Buffer;
    delete globalThis.global;
    delete globalThis.setImmediate;
    delete globalThis.clearImmediate;
    Deno.env.get = () => undefined;
    let networkCalls = 0;
    globalThis.fetch = () => { networkCalls++; throw new Error('Network forbidden'); };
    let handler;
    Deno.serve = (callback) => { handler = callback; };
    const routes = ${JSON.stringify(manifest.functions)};
    for (const route of routes) {
      handler = undefined;
      await import(${
        JSON.stringify(pathToFileURL(artifactDir + "/").href)
      } + route.file);
      assert.equal(typeof handler, 'function', route.name);
      const response = await handler(new Request('https://qa.invalid', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:'{}',
      }));
      const body = await response.text();
      if (route.verifyJwt) {
        assert.equal(response.status, 401, route.name);
        assert.deepEqual(JSON.parse(body), {error:'unauthorized'});
      } else if (route.name === 'qa-sandbox-verify-apple-access') {
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(body), {status:'unavailable'});
      } else if (route.name === 'qa-sandbox-stripe-webhook') {
        assert.equal(response.status, 503);
        assert.deepEqual(JSON.parse(body), {error:'webhook_unavailable'});
      } else {
        assert.equal(response.status, 400);
      }
    }
    const sdk = await import(${JSON.stringify(pathToFileURL(sdkBundle).href)});
    const verifier = new sdk.EdgeAppleSignedDataVerifier(sdk.APPLE_ROOT_CERTIFICATES,
      sdk.Environment.SANDBOX, 'co.still.qa', 1);
    await assert.rejects(verifier.verifyAndDecodeTransaction('eyJhbGciOiJFUzI1NiJ9.e30.AA'));
    assert.equal(networkCalls, 0);
    console.log('eight isolated handlers passed');
  `,
    );
    const result = await defaultExec("deno", [
      "run",
      "--no-config",
      "--no-lock",
      `--allow-read=${root}`,
      "--deny-net",
      "--deny-env",
      "--deny-write",
      "--deny-run",
      probe,
    ], { cwd: root });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /eight isolated handlers passed/);

    // The copied tree is owned by this test. Remove an actual graph dependency,
    // then verify the original sealed manifest; do not substitute a graph fixture.
    await rm(join(copiedSource, "packages/shared-types/src/product-policy.ts"));
    await assert.rejects(
      verifyQaFunctionBundles({
        sourceDir: copiedSource,
        artifactDir: join(root, "second-uploads"),
        manifest: copied,
      }),
      /source|graph|Deno info/i,
    );
  },
);

// ── Production purchase routes ─────────────────────────────────────────────────────────────────

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** One [functions.<name>] section of the real config.toml: its verify_jwt and import_map lines. */
async function configSection(name) {
  const text = await readFile(join(REPO, "supabase/config.toml"), "utf8");
  const sections = [...text.matchAll(/^\s*\[([^\]\n]+)\]\s*(?:#.*)?$/gm)];
  const matches = sections.filter((section) => section[1] === `functions.${name}`);
  assert.equal(matches.length, 1, name);
  const start = matches[0].index + matches[0][0].length;
  const next = sections.find((section) => section.index >= start);
  const body = text.slice(start, next?.index ?? text.length);
  return {
    verifyJwt: [...body.matchAll(/^\s*verify_jwt\s*=\s*(true|false)\s*(?:#.*)?$/gm)].map((m) => m[1]),
    importMap: [...body.matchAll(/^\s*import_map\s*=\s*"([^"\n]+)"/gm)].map((m) => m[1]),
  };
}

test("the purchase routes are a closed, ordered set: read-only routes first, the webhook last", () => {
  assert.deepEqual(
    PURCHASE_FUNCTIONS.map(({ name, verifyJwt }) => [name, verifyJwt]),
    [
      ["product-policy", false],
      ["export-user-data", true],
      ["verify-apple-access", false],
      ["link-apple-access", true],
      ["reconcile-entitlement", true],
      ["create-web-checkout", true],
      ["complete-web-checkout", true],
      ["revenuecat-webhook", false],
      ["stripe-webhook", false],
    ],
  );
  assert.deepEqual(
    SYNC_SETTINGS_FUNCTIONS.map(({ name, verifyJwt }) => [name, verifyJwt]),
    [["sync-settings", true]],
  );
  assert.equal(PURCHASE_BUNDLE_SET.routes, PURCHASE_FUNCTIONS);
  assert.equal(PURCHASE_BUNDLE_SET.perRouteConfig, false);
  assert.equal(SYNC_SETTINGS_BUNDLE_SET.routes, SYNC_SETTINGS_FUNCTIONS);
  assert.equal(SYNC_SETTINGS_BUNDLE_SET.perRouteConfig, true);
  // review-signin is its own one-route step, outside JWT, with the shared import map.
  assert.deepEqual(
    REVIEW_SIGNIN_FUNCTIONS.map(({ name, verifyJwt }) => [name, verifyJwt]),
    [["review-signin", false]],
  );
  assert.equal(REVIEW_SIGNIN_BUNDLE_SET.routes, REVIEW_SIGNIN_FUNCTIONS);
  assert.equal(REVIEW_SIGNIN_BUNDLE_SET.perRouteConfig, false);
  assert.equal(REVIEW_SIGNIN_BUNDLE_SET.kind, "still-review-signin-function-bundles");
  const all = [...PURCHASE_FUNCTIONS, ...SYNC_SETTINGS_FUNCTIONS, ...REVIEW_SIGNIN_FUNCTIONS].map(({ name }) => name);
  assert.equal(new Set(all).size, all.length);
  for (const name of all) {
    assert.doesNotMatch(name, /^qa-sandbox-/, name);
    assert.ok(!QA_FUNCTIONS.some((route) => route.name === name), name);
    assert.ok(!ANALYTICS_FUNCTIONS.some((route) => route.name === name), name);
  }
  // The owner page remains outside this deployment.
  for (const name of ["product-policy-admin"]) {
    assert.ok(!all.includes(name), name);
  }
  for (const set of [PURCHASE_BUNDLE_SET, SYNC_SETTINGS_BUNDLE_SET, REVIEW_SIGNIN_BUNDLE_SET]) {
    assert.ok(Object.isFrozen(set) && Object.isFrozen(set.routes));
    for (const route of set.routes) assert.ok(Object.isFrozen(route));
  }
});

test("every purchase route's verify_jwt and import map equal the real config.toml", async () => {
  for (const { name, verifyJwt } of PURCHASE_FUNCTIONS) {
    const section = await configSection(name);
    assert.deepEqual(section.verifyJwt, [String(verifyJwt)], name);
    assert.deepEqual(section.importMap, [], `${name} is bundled with the shared import map`);
  }
  for (const { name, verifyJwt } of SYNC_SETTINGS_FUNCTIONS) {
    const section = await configSection(name);
    assert.deepEqual(section.verifyJwt, [String(verifyJwt)], name);
    assert.deepEqual(section.importMap, [`./functions/${name}/deno.json`], name);
  }
  for (const { name, verifyJwt } of REVIEW_SIGNIN_FUNCTIONS) {
    const section = await configSection(name);
    assert.deepEqual(section.verifyJwt, [String(verifyJwt)], name);
    assert.deepEqual(section.importMap, [], `${name} is bundled with the shared import map`);
  }
});

test("the review-signin set seals one route, reads it back, and refuses an extra route or JWT drift", async (t) => {
  const options = await fixture(t, { routes: REVIEW_SIGNIN_FUNCTIONS, perRouteConfig: false });
  const manifest = await buildFunctionBundles(REVIEW_SIGNIN_BUNDLE_SET, options);
  assert.equal(manifest.kind, "still-review-signin-function-bundles");
  assert.deepEqual(
    manifest.functions.map(({ name, verifyJwt, file }) => ({ name, verifyJwt, file })),
    [{ name: "review-signin", verifyJwt: false, file: "review-signin.js" }],
  );
  assert.equal(
    await verifyFunctionBundles(REVIEW_SIGNIN_BUNDLE_SET, { ...options, manifest }),
    true,
  );
  // Another set's manifest, or one with any route beside review-signin, is refused.
  await assert.rejects(
    verifyFunctionBundles(PURCHASE_BUNDLE_SET, { ...options, manifest }),
    /manifest/i,
  );
  for (const extra of [
    { ...manifest.functions[0], name: "sync-settings", file: "sync-settings.js" },
    { ...manifest.functions[0], name: "product-policy", file: "product-policy.js" },
  ]) {
    await assert.rejects(
      verifyFunctionBundles(REVIEW_SIGNIN_BUNDLE_SET, {
        ...options,
        manifest: { ...manifest, functions: [...manifest.functions, extra] },
      }),
      /manifest/i,
    );
  }
  await assert.rejects(
    verifyFunctionBundles(REVIEW_SIGNIN_BUNDLE_SET, {
      ...options,
      manifest: { ...manifest, functions: [{ ...manifest.functions[0], verifyJwt: true }] },
    }),
    /manifest/i,
  );
  // Read-back: changed upload bytes after sealing are refused.
  await writeFile(join(options.artifactDir, "review-signin.js"), "// tampered\n");
  await assert.rejects(
    verifyFunctionBundles(REVIEW_SIGNIN_BUNDLE_SET, { ...options, manifest }),
    /drift/i,
  );
  const config = join(options.sourceDir, "supabase/config.toml");
  const text = await readFile(config, "utf8");
  await writeFile(
    config,
    text.replace("[functions.review-signin]\nverify_jwt = false", "[functions.review-signin]\nverify_jwt = true"),
  );
  await rm(options.artifactDir, { recursive: true });
  await assert.rejects(buildFunctionBundles(REVIEW_SIGNIN_BUNDLE_SET, options), /JWT/i);
});

test("the purchase set builds and verifies like the QA set, and refuses JWT or import-map drift", async (t) => {
  const options = await fixture(t, { routes: PURCHASE_FUNCTIONS, perRouteConfig: false });
  const manifest = await buildFunctionBundles(PURCHASE_BUNDLE_SET, options);
  assert.equal(manifest.kind, "still-purchase-function-bundles");
  assert.deepEqual(
    manifest.functions.map(({ name, verifyJwt, file }) => ({ name, verifyJwt, file })),
    PURCHASE_FUNCTIONS.map((route) => ({ ...route, file: `${route.name}.js` })),
  );
  assert.ok(manifest.sources.every(({ path }) => !path.includes("qa-sandbox-")));
  assert.equal(
    await verifyFunctionBundles(PURCHASE_BUNDLE_SET, { ...options, manifest }),
    true,
  );
  // A manifest of another set, or with a route outside the list, is refused.
  await assert.rejects(
    verifyFunctionBundles(SYNC_SETTINGS_BUNDLE_SET, { ...options, manifest }),
    /manifest/i,
  );
  await assert.rejects(
    verifyFunctionBundles(PURCHASE_BUNDLE_SET, {
      ...options,
      manifest: {
        ...manifest,
        functions: [...manifest.functions, { ...manifest.functions[0], name: "qa-sandbox-product-policy" }],
      },
    }),
    /manifest/i,
  );
  const config = join(options.sourceDir, "supabase/config.toml");
  const text = await readFile(config, "utf8");
  await writeFile(
    config,
    text.replace("[functions.revenuecat-webhook]\nverify_jwt = false", "[functions.revenuecat-webhook]\nverify_jwt = true"),
  );
  await rm(options.artifactDir, { recursive: true });
  await assert.rejects(buildFunctionBundles(PURCHASE_BUNDLE_SET, options), /JWT/i);
  await writeFile(
    config,
    text.replace(
      "[functions.product-policy]\nverify_jwt = false\n",
      '[functions.product-policy]\nverify_jwt = false\nimport_map = "./functions/product-policy/deno.json"\n',
    ),
  );
  await assert.rejects(buildFunctionBundles(PURCHASE_BUNDLE_SET, options), /import map/i);
});

// Explicitly enabled by the purchase function rehearsal workflow, which installs Deno 2.8.3.
test(
  "actual purchase, sync-settings, review-signin and canonical analytics bundles are portable, closed, and start without authority",
  { skip: process.env.STILL_PURCHASE_BUNDLE_INTEGRATION !== "1" },
  async (t) => {
    const sourceDir = await realpath(REPO);
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "still-purchase-bundle-integration-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const uploads = [];
    for (const [index, set] of [PURCHASE_BUNDLE_SET, SYNC_SETTINGS_BUNDLE_SET, REVIEW_SIGNIN_BUNDLE_SET, ANALYTICS_BUNDLE_SET, ANALYTICS_SWITCH_BUNDLE_SET].entries()) {
      const artifactDir = join(root, `uploads-${index}`);
      const manifest = await buildFunctionBundles(set, { sourceDir, artifactDir });
      assert.equal(manifest.functions.length, set.routes.length);
      assert.equal(JSON.stringify(manifest).includes(sourceDir), false);
      const copiedSource = join(root, `copied-source-${index}`);
      for (const { path } of manifest.sources) {
        await put(copiedSource, path, await readFile(join(sourceDir, path)));
      }
      const copied = await buildFunctionBundles(set, {
        sourceDir: copiedSource,
        artifactDir: join(root, `second-uploads-${index}`),
      });
      assert.deepEqual(
        copied,
        manifest,
        "source/upload hashes must not depend on checkout or artifact paths",
      );
      for (const route of manifest.functions) {
        if (set === ANALYTICS_SWITCH_BUNDLE_SET) continue; // Same routes already start above.
        if (set === ANALYTICS_BUNDLE_SET && !["analytics-purchase", "analytics-apple-purchase"].includes(route.name)) continue;
        uploads.push({ ...route, url: pathToFileURL(join(artifactDir, route.file)).href });
      }
    }
    // Platform-provided names only (a refused loopback URL); no purchase secret, no network.
    const probe = join(root, "startup.mjs");
    await writeFile(
      probe,
      `
    import assert from 'node:assert/strict';
    delete globalThis.Buffer;
    delete globalThis.global;
    delete globalThis.setImmediate;
    delete globalThis.clearImmediate;
    const platform = { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'rehearsal-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'rehearsal-service' };
    Deno.env.get = (name) => platform[name];
    let networkCalls = 0;
    globalThis.fetch = () => { networkCalls++; throw new Error('Network forbidden'); };
    let handler;
    Deno.serve = (callback) => { handler = callback; };
    for (const route of ${JSON.stringify(uploads)}) {
      handler = undefined;
      await import(route.url);
      assert.equal(typeof handler, 'function', route.name);
      const response = await handler(new Request('https://purchase.invalid', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:'{}',
      }));
      const body = await response.text();
      if (route.name === 'product-policy') {
        assert.equal(response.status, 400, route.name);
      } else if (route.name === 'review-signin') {
        // A malformed body is refused before the unset review configuration is consulted, and an
        // oversized body (3,000 bytes, for an unrelated address) is refused as bad input too.
        assert.equal(response.status, 400, route.name);
        assert.deepEqual(JSON.parse(body), {error:'bad_request'});
        const oversized = JSON.stringify({ action:'request', email:'someone@example.invalid', code:'', pad:'x'.repeat(3000) });
        const large = await handler(new Request('https://purchase.invalid', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: oversized,
        }));
        assert.equal(large.status, 400, 'review-signin oversized body');
        assert.deepEqual(await large.json(), {error:'bad_request'});
      } else if (route.name === 'verify-apple-access') {
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(body), {status:'unavailable'});
      } else if (route.name === 'analytics-apple-purchase') {
        assert.equal(response.status, 200, route.name);
        assert.deepEqual(JSON.parse(body), {schema:1,status:'unavailable'});
      } else if (route.name === 'stripe-webhook') {
        assert.equal(response.status, 503, route.name);
        assert.deepEqual(JSON.parse(body), {error:'webhook_unavailable'});
      } else {
        // Every JWT route, and the RevenueCat webhook without its token.
        assert.equal(response.status, 401, route.name);
        assert.deepEqual(JSON.parse(body), {error:'unauthorized'});
      }
    }
    assert.equal(networkCalls, 0);
    console.log(${JSON.stringify(`${PURCHASE_FUNCTIONS.length + 4} isolated handlers passed`)});
  `,
    );
    const result = await defaultExec("deno", [
      "run",
      "--no-config",
      "--no-lock",
      `--allow-read=${root}`,
      "--deny-net",
      "--deny-env",
      "--deny-write",
      "--deny-run",
      probe,
    ], { cwd: root });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /13 isolated handlers passed/);
  },
);
