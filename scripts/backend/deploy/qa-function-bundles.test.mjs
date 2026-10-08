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
  buildQaFunctionBundles,
  QA_FUNCTIONS,
  sealRuntimeRequires,
  verifyQaFunctionBundles,
} from "./qa-function-bundles.mjs";

async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}

async function fixture(t) {
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
    QA_FUNCTIONS.map(({ name, verifyJwt }) =>
      `[functions.${name}]\nverify_jwt = ${verifyJwt}\nimport_map = "./functions/${name}/deno.json"\n`
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
  for (const { name } of QA_FUNCTIONS) {
    await put(
      sourceDir,
      `supabase/functions/${name}/index.ts`,
      'import "../../../packages/shared-types/src/product-policy.ts";\n',
    );
    await put(sourceDir, `supabase/functions/${name}/deno.json`, "{}\n");
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
    sealRuntimeRequires(REQUIRE_PROLOGUE + "export { __require as load };\n"),
  );
  const { load } = await import(pathToFileURL(module).href);
  assert.equal(typeof load("node:crypto").createHash, "function");
  assert.throws(() => load("./unapproved.cjs"), /Unbound QA runtime require/);
  assert.throws(() => load("encoding"), /Unbound QA runtime require/);
});

test("CommonJS compiler prologue drift fails before sealing arbitrary source", () => {
  assert.throws(
    () =>
      sealRuntimeRequires(
        REQUIRE_PROLOGUE.replace("import.meta.url", '"unbound.js"') +
          "export const x=1;",
      ),
    /prologue/i,
  );
});

// Explicitly enabled by the protected bundle rehearsal, which installs Deno
// 2.8.3. Ordinary offline Node checks retain their synthetic boundary coverage.
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
      sealRuntimeRequires(await readFile(sdkBundle, "utf8")),
    );
    await put(copiedSource, sdkEntry, sdkSource);

    const probe = join(root, "startup.mjs");
    await writeFile(
      probe,
      `
    import assert from 'node:assert/strict';
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
