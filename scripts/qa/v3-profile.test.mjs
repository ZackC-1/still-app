import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  artifactManifest,
  paidSandboxMain,
  inventory,
  profileEnvironment,
  PAID_INSTALL_ARGS,
  main,
} from "./v3-profile.mjs";

test("local profile removes inherited client/backend/trust and debug inputs", () => {
  const env = profileEnvironment("local", {
    PATH: "/usr/bin",
    VITE_SUPABASE_URL: "https://production.invalid",
    VITE_SUPABASE_ANON_KEY: "private-sentinel",
    VITE_ACCESS_ENVIRONMENT: "sandbox",
    VITE_ACCESS_KEYS: "sentinel",
    VITE_POSTHOG_KEY: "sentinel",
    STILL_QA_SUPABASE_ANON_KEY: "sentinel",
    DEBUG: "*",
    NODE_OPTIONS: "--require bad",
    NODE_ENV: "development",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    NODE_ENV: "production",
    VITE_BACKEND_ROUTE_PROFILE: "production",
    VITE_MODERN_SETTINGS_SYNC_ENABLED: "true",
    VITE_APPLE_ATOMIC_SETTINGS: "true",
  });
});

const inputs = {
  STILL_QA_BACKEND_ENVIRONMENT: "shared-hosted",
  STILL_QA_SUPABASE_URL: "https://hosted-fixture.invalid",
  STILL_QA_SUPABASE_ANON_KEY: "sb_publishable_test-only",
};
test("test profile requires deliberate paired public configuration and discards unrelated inherited flags", () => {
  assert.throws(() => profileEnvironment("test", {}));
  assert.throws(() =>
    profileEnvironment("test", { ...inputs, STILL_QA_SUPABASE_ANON_KEY: "" }),
  );
  assert.throws(() =>
    profileEnvironment("test", {
      ...inputs,
      STILL_QA_BACKEND_ENVIRONMENT: "production",
    }),
  );
  assert.throws(() =>
    profileEnvironment("test", {
      ...inputs,
      STILL_QA_SUPABASE_URL: "http://remote.invalid",
    }),
  );
  assert.throws(() =>
    profileEnvironment("test", {
      ...inputs,
      STILL_QA_SUPABASE_URL: "https://user:secret@remote.invalid",
    }),
  );
  assert.throws(() =>
    profileEnvironment("test", {
      ...inputs,
      STILL_QA_SUPABASE_ANON_KEY: "sb_secret_private",
    }),
  );
  const jwt = `x.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.x`;
  assert.throws(() =>
    profileEnvironment("test", { ...inputs, STILL_QA_SUPABASE_ANON_KEY: jwt }),
  );
  const env = profileEnvironment("test", {
    ...inputs,
    VITE_POSTHOG_KEY: "private-sentinel",
    VITE_ACCESS_KEYS: "private-sentinel",
  });
  assert.equal(env.VITE_SUPABASE_URL, inputs.STILL_QA_SUPABASE_URL);
  assert.equal(env.VITE_MODERN_SETTINGS_SYNC_ENABLED, "true");
  assert.equal(env.VITE_APPLE_ATOMIC_SETTINGS, "true");
  assert.equal(env.VITE_ACCESS_KEYS, undefined);
  assert.equal(env.VITE_POSTHOG_KEY, undefined);
});

test("manifest binds backend target without exporting endpoint/key or claiming provider readiness", () => {
  const manifest = artifactManifest({
    profile: "test",
    surface: "safari",
    revision: "123",
    dirty: false,
    backendUrl: "https://private-target.invalid",
    artifacts: { totalBytes: 0, files: [] },
  });
  assert.equal(manifest.trust.sandboxProofAccepted, false);
  assert.equal(manifest.trust.buildMode, "production");
  assert.equal(manifest.backend.state, "configured-shared-hosted-unverified");
  assert.equal(manifest.backend.routeProfile, "production");
  assert.equal(manifest.backend.routeConsumption, "unverified");
  assert.equal(
    manifest.backend.accountScope,
    "dedicated-test-accounts-required",
  );
  assert.match(manifest.backend.targetSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /private-target|sb_publishable|sb_secret/,
  );
});

test("artifact inventory records actual bytes/hashes and refuses symlink escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "still-profile-test-"));
  try {
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "font.woff2"), "abc");
    const result = await inventory(dir);
    assert.equal(result.totalBytes, 3);
    assert.deepEqual(result.files, [
      {
        path: "assets/font.woff2",
        bytes: 3,
        sha256:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
    ]);
    await symlink(join(dir, "assets", "font.woff2"), join(dir, "escape"));
    await assert.rejects(inventory(dir), /symbolic links/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const sandboxKey = { kid: "sandbox-fixture", publicKeyHex: "12".repeat(32), environment: "sandbox", purpose: "access" };
const paidInputs = { ...inputs, STILL_QA_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox", STILL_QA_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  STILL_QA_ACCESS_ENVIRONMENT: "sandbox", STILL_QA_ACCESS_PUBLIC_KEYS: JSON.stringify([sandboxKey]),
  STILL_QA_REVENUECAT_PUBLIC_API_KEY: "appl_public_fixture" };

const paid = await import("../../apps/apple/scripts/paid-sandbox-qa.mjs");
const { execFileSync } = await import("node:child_process");
const { readFile } = await import("node:fs/promises");

test("backend route profile is closed and paid sandbox requires an explicit isolated route selection", () => {
  for (const profile of ["local", "test"]) {
    assert.equal(profileEnvironment(profile, inputs).VITE_BACKEND_ROUTE_PROFILE, "production");
    assert.equal(profileEnvironment(profile, { ...inputs, STILL_QA_BACKEND_ROUTE_PROFILE: "production" }).VITE_BACKEND_ROUTE_PROFILE, "production");
    assert.equal(profileEnvironment(profile, { ...inputs, STILL_QA_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox" }).VITE_BACKEND_ROUTE_PROFILE, "shared-hosted-sandbox");
    for (const value of ["", "sandbox", "shared-hosted", " Production", "shared-hosted-sandbox ", null, 1])
      assert.throws(() => profileEnvironment(profile, { ...inputs, STILL_QA_BACKEND_ROUTE_PROFILE: value }), /route profile/);
  }
  assert.equal(paid.sandboxConfiguration(paidInputs).backendRouteProfile, "shared-hosted-sandbox");
  for (const value of [undefined, "production", "sandbox", "", "shared-hosted-sandbox "])
    assert.throws(() => paid.sandboxConfiguration({ ...paidInputs, STILL_QA_BACKEND_ROUTE_PROFILE: value }), /route profile/);
  const env = profileEnvironment("paid-sandbox", { ...paidInputs, VITE_BACKEND_ROUTE_PROFILE: "production" });
  assert.equal(env.VITE_BACKEND_ROUTE_PROFILE, "shared-hosted-sandbox");
});

test("local and test profiles refuse a paid-enabled source before building or issuing receipts", async () => {
  for (const profile of ["local", "test"]) {
    for (const flag of Object.values(paid.PAID_FLAGS)) {
      const root = await fixture();
      try {
        await writeFile(join(root, ".gitignore"), ".output/\n");
        const manifest = join(root, `.output/v3-qa/${profile}/chrome/artifact-manifest.json`);
        await mkdir(join(root, `.output/v3-qa/${profile}/chrome`), { recursive: true });
        await writeFile(manifest, "stale receipt");
        await writeFile(join(root, flag), (await readFile(join(root, flag), "utf8")).replace("false", "true"));
        let calls = 0;
        await assert.rejects(main([profile, "chrome"], inputs, root, () => {
          calls += 1;
          return { status: 1 };
        }), /both original paid constants/);
        assert.equal(calls, 0);
        await assert.rejects(readFile(manifest), /ENOENT/);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
});

test("nested linked worktrees remain intact and are excluded from isolated source clones", async () => {
  const root = await fixture();
  try {
    const before = await paid.sourceSnapshot(root);
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", join(root, "wt"), "HEAD"], { cwd: root });
    await writeFile(join(root, "wt", "unowned.txt"), "preserve other agent work");
    assert.equal((await paid.sourceSnapshot(root)).sha256, before.sha256);
    await paid.isolatedSandboxSource(root, paid.sandboxConfiguration(paidInputs), async ({ clone }) => {
      await assert.rejects(readFile(join(clone, "wt", "unowned.txt")), /ENOENT/);
    });
    assert.equal(await readFile(join(root, "wt", "unowned.txt"), "utf8"), "preserve other agent work");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("large compiler output streams to the run log without exhausting a capture buffer", async () => {
  const { openSync, closeSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), "still-paid-output-test-"));
  const log = join(root, "compiler.log"), fd = openSync(log, "w");
  try {
    paid.runChecked(process.execPath, ["-e", 'process.stdout.write("x".repeat(2*1024*1024)); process.stderr.write("y".repeat(2*1024*1024));'], { stdio: ["ignore", fd, fd] });
    assert.equal((await readFile(log)).length, 4*1024*1024);
  } finally { closeSync(fd); await rm(root, { recursive: true, force: true }); }
});

test("isolated source honors staged deletion and ignored index removal from HEAD", async () => {
  for (const cached of [false, true]) {
    const root = await fixture();
    try {
      await writeFile(join(root, "obsolete.swift"), "must never compile again");
      await writeFile(join(root, ".gitignore"), "obsolete.swift\n");
      execFileSync("git", ["add", "--force", "obsolete.swift", ".gitignore"], { cwd: root });
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "old source"], { cwd: root });
      execFileSync("git", ["rm", ...(cached ? ["--cached"] : []), "obsolete.swift"], { cwd: root });
      const before = await paid.sourceSnapshot(root);
      await paid.isolatedSandboxSource(root, paid.sandboxConfiguration(paidInputs), async ({ clone }) => {
        await assert.rejects(readFile(join(clone, "obsolete.swift")), /ENOENT/);
      });
      assert.equal((await paid.sourceSnapshot(root)).sha256, before.sha256);
      if (cached) assert.equal(await readFile(join(root, "obsolete.swift"), "utf8"), "must never compile again");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("inherited alternate Git repository and index cannot change source identity or clone", async () => {
  const root = await fixture(), foreign = await fixture();
  const keys = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"];
  const previous = keys.map(key => process.env[key]);
  try {
    await writeFile(join(foreign, "foreign-only.txt"), "foreign source");
    execFileSync("git", ["add", "foreign-only.txt"], { cwd: foreign });
    const before = await paid.sourceSnapshot(root);
    process.env.GIT_DIR = join(foreign, ".git");
    process.env.GIT_INDEX_FILE = join(foreign, ".git/index");
    process.env.GIT_WORK_TREE = foreign;
    assert.equal((await paid.sourceSnapshot(root)).sha256, before.sha256);
    await paid.isolatedSandboxSource(root, paid.sandboxConfiguration(paidInputs), async ({ clone }) => {
      await assert.rejects(readFile(join(clone, "foreign-only.txt")), /ENOENT/);
    });
    assert.equal((await paid.sourceSnapshot(root)).sha256, before.sha256);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(root, { recursive: true, force: true }); await rm(foreign, { recursive: true, force: true });
  }
});

test("source identity distinguishes deletions and unambiguous binary entry boundaries", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "binary-a"), "<deleted>");
    execFileSync("git", ["add", "binary-a"], { cwd: root });
    const literal = await paid.sourceSnapshot(root);
    await rm(join(root, "binary-a"));
    assert.notEqual((await paid.sourceSnapshot(root)).sha256, literal.sha256);
    await writeFile(join(root, "binary-a"), "x\0binary-b\0y");
    const embedded = await paid.sourceSnapshot(root);
    await writeFile(join(root, "binary-a"), "x");
    await writeFile(join(root, "binary-b"), "y");
    assert.notEqual((await paid.sourceSnapshot(root)).sha256, embedded.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local source identity includes HEAD files still built after ignored index removal", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "retained.swift"), "first compiled content");
    await writeFile(join(root, ".gitignore"), "retained.swift\n");
    execFileSync("git", ["add", "--force", "retained.swift", ".gitignore"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "tracked source"], { cwd: root });
    execFileSync("git", ["rm", "--cached", "retained.swift"], { cwd: root });
    const isolated = await paid.sourceSnapshot(root);
    const local = await paid.sourceSnapshot(root, { includeIndexRemovedFiles: true });
    await writeFile(join(root, "retained.swift"), "different compiled content");
    assert.notEqual((await paid.sourceSnapshot(root, { includeIndexRemovedFiles: true })).sha256, local.sha256);
    assert.equal((await paid.sourceSnapshot(root)).sha256, isolated.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public anon JWT must satisfy native base64url payload grammar", () => {
  let padding = "";
  let payload;
  do {
    payload = Buffer.from(JSON.stringify({ role: "anon", ref: "abcdefghijklmnopqrst", padding })).toString("base64url");
    padding += "x";
  } while (payload.length % 4 !== 0);
  paid.sandboxConfiguration({ ...paidInputs, STILL_QA_SUPABASE_ANON_KEY: `e30.${payload}.sig` });
  assert.throws(() => paid.sandboxConfiguration({ ...paidInputs, STILL_QA_SUPABASE_ANON_KEY: `e30.${payload}A.sig` }), /anonymous/);
  assert.throws(() => paid.sandboxConfiguration({ ...paidInputs, STILL_QA_SUPABASE_ANON_KEY: `sb_publishable_header.${payload}.sig` }), /anonymous|publishable/);
});

test("actual cold paid dependency install retains development build tools under production env", async () => {
  const root = await mkdtemp(join(tmpdir(), "still-paid-install-test-"));
  try {
    await mkdir(join(root, "fixture-dev"));
    await writeFile(join(root, "fixture-dev/package.json"), JSON.stringify({ name: "qa-dev-fixture", version: "1.0.0" }));
    await writeFile(join(root, "fixture-dev/index.js"), 'module.exports = "development tool installed";');
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "qa-install-fixture", private: true, devDependencies: { "qa-dev-fixture": "file:./fixture-dev" } }));
    const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const isolation = ["--offline", "--ignore-scripts", "--reporter=silent", "--store-dir", join(root, "store"), "--cache-dir", join(root, "cache")];
    execFileSync("pnpm", ["install", "--lockfile-only", ...isolation], { cwd: root, env });
    paid.runChecked("pnpm", [...PAID_INSTALL_ARGS, ...isolation], { cwd: root, env: { ...env, NODE_ENV: "production" } });
    assert.match(await readFile(join(root, "node_modules/qa-dev-fixture/index.js"), "utf8"), /development tool installed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source identity and isolated clone preserve executable modes for dirty scripts", async () => {
  const { chmod } = await import("node:fs/promises");
  const root = await fixture();
  try {
    const path = join(root, "dirty-task.sh");
    await writeFile(path, '#!/bin/sh\nprintf "executable fixture"\n');
    await chmod(path, 0o644);
    const before = await paid.sourceSnapshot(root);
    await chmod(path, 0o755);
    assert.notEqual((await paid.sourceSnapshot(root)).sha256, before.sha256);
    await paid.isolatedSandboxSource(root, paid.sandboxConfiguration(paidInputs), async ({ clone }) => {
      assert.equal(execFileSync(join(clone, "dirty-task.sh"), [], { encoding: "utf8" }), "executable fixture");
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("web trust check requires every selected key in generated JavaScript", async () => {
  const root = await mkdtemp(join(tmpdir(), "still-paid-compiled-trust-test-"));
  try {
    const second = { ...sandboxKey, kid: "second-fixture", publicKeyHex: "34".repeat(32) };
    const config = paid.sandboxConfiguration({ ...paidInputs, STILL_QA_ACCESS_PUBLIC_KEYS: JSON.stringify([sandboxKey, second]) });
    await writeFile(join(root, "background.js"), sandboxKey.publicKeyHex);
    await writeFile(join(root, "index.html"), second.publicKeyHex);
    await assert.rejects(paid.assertCompiledSandboxTrust(root, config), /JavaScript lacks/);
    await writeFile(join(root, "chunk.js"), second.publicKeyHex);
    await paid.assertCompiledSandboxTrust(root, config);
    await writeFile(join(root, "background.js"), "production trust only");
    await assert.rejects(paid.assertCompiledSandboxTrust(root, config), /JavaScript lacks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("webview trust check reads inline modules but refuses HTML, CSS and external script bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "still-paid-inline-trust-test-"));
  try {
    const config = paid.sandboxConfiguration(paidInputs), key = sandboxKey.publicKeyHex;
    const path = join(root, "index.html");
    for (const text of [
      `<div>${key}</div>`,
      `<style>/* ${key} */</style>`,
      `<script type="application/json">${key}</script>`,
      `<script type="module" src="missing.js">${key}</script>`,
      `<script type="module" src>${key}</script>`,
      `<!-- <script type="module">${key}</script> -->`,
      `<script data-type="module">${key}</script>`,
      `<script title='type="module"'>${key}</script>`,
      `<script type="application/json" data-type="module">${key}</script>`,
      `<template><script type="module">${key}</script></template>`,
      `<noscript><script type="module">${key}</script></noscript>`,
      `<textarea><script type="module">${key}</script></textarea>`,
      `<style><script type="module">${key}</script></style>`,
    ]) {
      await writeFile(path, text);
      await assert.rejects(paid.assertCompiledSandboxTrust(root, config, { inlineModules: true }), /JavaScript lacks/);
    }
    await writeFile(path, `<html><head><script type="module">const key = "${key}";</script></head></html>`);
    await assert.rejects(paid.assertCompiledSandboxTrust(root, config), /JavaScript lacks/);
    await paid.assertCompiledSandboxTrust(root, config, { inlineModules: true });
    await writeFile(path, '<script type="module">const key = "production trust only";</script>');
    await assert.rejects(paid.assertCompiledSandboxTrust(root, config, { inlineModules: true }), /JavaScript lacks/);
    await writeFile(join(root, "orphan.js"), key);
    await assert.rejects(paid.assertCompiledSandboxTrust(root, config, { inlineModules: true }), /JavaScript lacks/);
    await writeFile(join(root, "other.html"), `<script type="module">${key}</script>`);
    await assert.rejects(paid.assertCompiledSandboxTrust(root, config, { inlineModules: true }), /JavaScript lacks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inline trust resolves the installed candidate parser from a cold operator checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "still-paid-cold-parser-test-"));
  try {
    const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
    await mkdir(join(root, "apps/apple/scripts"), { recursive: true });
    await mkdir(join(root, "scripts/qa"), { recursive: true });
    await mkdir(join(root, "packages/core"), { recursive: true });
    await mkdir(join(root, "artifact"));
    await copyFile(join(sourceRoot, "apps/apple/scripts/paid-sandbox-qa.mjs"), join(root, "apps/apple/scripts/paid-sandbox-qa.mjs"));
    await copyFile(join(sourceRoot, "scripts/qa/v3-profile.mjs"), join(root, "scripts/qa/v3-profile.mjs"));
    await writeFile(join(root, "packages/core/package.json"), '{"name":"synthetic-uninstalled-operator"}');
    await writeFile(join(root, "artifact/index.html"), `<script type="module">const key = "${sandboxKey.publicKeyHex}";</script>`);
    const cold = await import(pathToFileURL(join(root, "apps/apple/scripts/paid-sandbox-qa.mjs")));
    const config = paid.sandboxConfiguration(paidInputs);
    await assert.rejects(cold.assertCompiledSandboxTrust(join(root, "artifact"), config, { inlineModules: true }), /local node check failed/);
    await cold.assertCompiledSandboxTrust(join(root, "artifact"), config, { sourceRoot, inlineModules: true });
    await assert.rejects(cold.assertCompiledSandboxTrust(join(root, "artifact"), config, { sourceRoot }), /JavaScript lacks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("candidate parser receives no operator environment and cannot modify verifier globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "still-paid-parser-boundary-test-"));
  const sentinel = process.env.STILL_QA_SYNTHETIC_PARSER_SENTINEL;
  const includes = String.prototype.includes;
  try {
    process.env.STILL_QA_SYNTHETIC_PARSER_SENTINEL = "synthetic-secret-never-forward";
    const core = join(root, "packages/core");
    const jsdom = join(core, "node_modules/jsdom");
    const parser = join(jsdom, "node_modules/parse5");
    await mkdir(parser, { recursive: true });
    await mkdir(join(root, "artifact"));
    await writeFile(join(core, "package.json"), '{"name":"synthetic-parser-root"}');
    await writeFile(join(jsdom, "package.json"), '{"name":"jsdom","main":"index.js"}');
    await writeFile(join(jsdom, "index.js"), "");
    await writeFile(join(parser, "package.json"), '{"name":"parse5","type":"module","main":"index.js"}');
    await writeFile(join(parser, "index.js"), `
      if (process.env.STILL_QA_SYNTHETIC_PARSER_SENTINEL) throw new Error("operator environment leaked");
      String.prototype.includes = () => { throw new Error("candidate dependency escaped"); };
      export function parse() { return { childNodes: [{ tagName: "script", namespaceURI: "http://www.w3.org/1999/xhtml",
        attrs: [{name: "type", value: "module"}], childNodes: [{nodeName: "#text", value: "${sandboxKey.publicKeyHex}"}] }] }; }
    `);
    await writeFile(join(root, "artifact/index.html"), "<html></html>");
    await paid.assertCompiledSandboxTrust(join(root, "artifact"), paid.sandboxConfiguration(paidInputs), { sourceRoot: root, inlineModules: true });
    assert.equal(String.prototype.includes, includes);
    assert.equal("verified".includes("verified"), true);
  } finally {
    String.prototype.includes = includes;
    if (sentinel === undefined) delete process.env.STILL_QA_SYNTHETIC_PARSER_SENTINEL;
    else process.env.STILL_QA_SYNTHETIC_PARSER_SENTINEL = sentinel;
    await rm(root, { recursive: true, force: true });
  }
});

test("local all-target receipts refuse source edits during a build and retain coherent healthy results", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const root = await fixture();
  try {
    await writeFile(join(root, ".gitignore"), ".output/\n");
    await writeFile(join(root, "source-marker.txt"), "before compilation");
    let mutate = true, calls = 0;
    const runner = (_command, args) => {
      calls += 1;
      const output = join(args[2], "artifact");
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "compiled.js"), "fixture result");
      if (mutate && calls === 4) writeFileSync(join(root, "source-marker.txt"), "source edited while building");
      return { status: 0 };
    };
    await assert.rejects(main(["local", "all"], {}, root, runner), /source changed/);
    for (const surface of ["chrome", "firefox", "safari", "apple-webview"])
      await assert.rejects(readFile(join(root, `.output/v3-qa/local/${surface}/artifact-manifest.json`)), /ENOENT/);
    mutate = false; calls = 0;
    await main(["local", "all"], {}, root, runner);
    const sourceSha256 = (await paid.sourceSnapshot(root, { includeIndexRemovedFiles: true })).sha256;
    for (const surface of ["chrome", "firefox", "safari", "apple-webview"]) {
      const manifest = JSON.parse(await readFile(join(root, `.output/v3-qa/local/${surface}/artifact-manifest.json`), "utf8"));
      assert.equal(manifest.sourceSha256, sourceSha256);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("paid sandbox selects matching public trust and rejects hostile public configuration", () => {
  const env = profileEnvironment("paid-sandbox", { ...paidInputs, PATH: "/usr/bin",
    VITE_ACCESS_ENVIRONMENT: "production", VITE_PAID_TIER_ENABLED: "false" });
  assert.equal(env.VITE_ACCESS_ENVIRONMENT, "sandbox");
  assert.deepEqual(JSON.parse(env.VITE_ACCESS_PUBLIC_KEYS), [sandboxKey]);
  assert.equal(env.VITE_MODERN_SETTINGS_SYNC_ENABLED, "true");
  assert.equal(env.VITE_APPLE_ATOMIC_SETTINGS, "true");
  assert.equal(env.VITE_PAID_TIER_ENABLED, undefined);
  for (const change of [
    { STILL_QA_ACCESS_ENVIRONMENT: "production" }, { STILL_QA_ACCESS_ENVIRONMENT: "unknown" },
    { STILL_QA_ACCESS_PUBLIC_KEYS: "[]" }, { STILL_QA_ACCESS_PUBLIC_KEYS: "" }, { STILL_QA_ACCESS_PUBLIC_KEYS: "{" },
    { STILL_QA_SUPABASE_URL: "https://remote.invalid" }, { STILL_QA_SUPABASE_URL: "https://127.0.0.1" },
    { STILL_QA_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co:8443" },
    { STILL_QA_SUPABASE_URL: "https://user:pass@abcdefghijklmnopqrst.supabase.co" },
    { STILL_QA_SUPABASE_ANON_KEY: "sb_secret_private" }, { STILL_QA_SUPABASE_ANON_KEY: "bearer-private-token" },
    { STILL_QA_REVENUECAT_PUBLIC_API_KEY: "sk_private" }, { STILL_QA_ACCESS_PRIVATE_KEY: "never-read-file" },
    { STILL_QA_SIGNER_KEY_PATH: "/do-not-read/private.pem" },
  ]) assert.throws(() => profileEnvironment("paid-sandbox", { ...paidInputs, ...change }));
  for (const keys of [[{ ...sandboxKey, environment: "production" }], [{ ...sandboxKey, privateKeyHex: "34".repeat(32) }],
    [{ ...sandboxKey, publicKeyHex: "ABC" }], [{ ...sandboxKey, purpose: "rules" }], [sandboxKey, sandboxKey],
    Array.from({ length: 9 }, (_, i) => ({ ...sandboxKey, kid: `key-${i}` }))])
    assert.throws(() => profileEnvironment("paid-sandbox", { ...paidInputs, STILL_QA_ACCESS_PUBLIC_KEYS: JSON.stringify(keys) }));
  const claims = role => `e30.${Buffer.from(JSON.stringify({ role, ref: "other-project" })).toString("base64url")}.sig`;
  for (const role of ["anon", "service_role"]) assert.throws(() => profileEnvironment("paid-sandbox", { ...paidInputs, STILL_QA_SUPABASE_ANON_KEY: claims(role) }));
  const clean = profileEnvironment("paid-sandbox", { ...paidInputs, SUPABASE_SERVICE_ROLE_KEY: "discard", NPM_TOKEN: "discard", REVENUECAT_SECRET_API_KEY: "discard" });
  assert.equal(clean.SUPABASE_SERVICE_ROLE_KEY, undefined); assert.equal(clean.NPM_TOKEN, undefined); assert.equal(clean.REVENUECAT_SECRET_API_KEY, undefined);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "still-paid-profile-test-"));
  const files = { [paid.PAID_FLAGS.js]: "export const PAID_TIER_ENABLED = false;\n",
    [paid.PAID_FLAGS.native]: "public enum MonetizationConfig { public static let paidTierEnabled = false }\n" };
  for (const part of ["iOS (App)", "iOS (Extension)", "macOS (App)", "macOS (Extension)"])
    files[`apps/apple/Still/${part}/Info.plist`] = '<?xml version="1.0"?><plist version="1.0"><dict><key>Existing</key><string>preserved</string></dict></plist>\n';
  for (const [path, bytes] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), bytes); }
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  return root;
}

test("isolation enables both constants and typed app/extension trust while source remains unchanged on success and failure", async () => {
  const root = await fixture();
  try {
    const before = await paid.sourceSnapshot(root), config = paid.sandboxConfiguration(paidInputs);
    await assert.rejects(paid.applySandboxOverlay(root, config), /isolated source clone/);
    assert.equal((await paid.sourceSnapshot(root)).sha256, before.sha256);
    let runPath;
    const build = await paid.isolatedSandboxSource(root, config, async ({ clone, run, snapshot, overlay }) => {
      runPath = run;
      assert.match(await readFile(join(clone, paid.PAID_FLAGS.js), "utf8"), /PAID_TIER_ENABLED = true/);
      assert.match(await readFile(join(clone, paid.PAID_FLAGS.native), "utf8"), /paidTierEnabled = true/);
      assert.equal(overlay.overlayFiles.length, 6);
      assert.equal(overlay.backendRouteProfile, "shared-hosted-sandbox");
      for (const file of overlay.overlayFiles) { assert.match(file.beforeSha256, /^[a-f0-9]{64}$/); assert.notEqual(file.beforeSha256, file.sha256); }
      for (const part of ["iOS (App)", "iOS (Extension)", "macOS (App)", "macOS (Extension)"]) {
        const text = await readFile(join(clone, `apps/apple/Still/${part}/Info.plist`), "utf8");
        assert.match(text, /<key>StillBackendRouteProfile<\/key><string>shared-hosted-sandbox<\/string>/);
        assert.match(text, /<key>StillAccessTrustKeys<\/key><array><dict>/);
        assert.match(text, /<key>environment<\/key><string>sandbox<\/string>/);
        assert.match(text, /<key>StillAccessSupabaseURL<\/key>/);
        assert.match(text, /<string>preserved<\/string>/);
      }
      return paid.candidateIdentity(snapshot, overlay, ["safari", "apple-webview", "apple-ios-sim"]);
    });
    assert.equal((await paid.sourceSnapshot(root)).sha256, before.sha256);
    await assert.rejects(readFile(join(runPath, "source", paid.PAID_FLAGS.js)), /ENOENT/);
    const manifest = artifactManifest({ profile: "paid-sandbox", surface: "safari", revision: before.revision, dirty: false,
      sourceSha256: before.sha256, backendRouteProfile: "shared-hosted-sandbox", backendUrl: paidInputs.STILL_QA_SUPABASE_URL, artifacts: { totalBytes: 0, files: [] }, paidBuild: build });
    assert.equal(manifest.runtime.paidTierEnabled, true); assert.equal(manifest.trust.sandboxProofAccepted, null);
    assert.equal(manifest.trust.access, "sandbox-native-authority-unverified");
    assert.equal(manifest.trust.nativePackageVerification, "unverified-resource-only");
    assert.equal(manifest.paidBuild.flags.nativePaid, true);
    assert.equal(manifest.backend.routeProfile, "shared-hosted-sandbox");
    assert.equal(manifest.backend.routeConsumption, "unverified");
    assert.equal(manifest.paidBuild.backendRouteProfile, "shared-hosted-sandbox");
    assert.throws(() => artifactManifest({ profile: "paid-sandbox", surface: "safari", sourceSha256: before.sha256,
      backendRouteProfile: "production", paidBuild: build }), /route profile/);
    assert.throws(() => artifactManifest({ profile: "paid-sandbox", surface: "safari", sourceSha256: before.sha256,
      backendRouteProfile: "shared-hosted-sandbox", paidBuild: { ...build, backendRouteProfile: "production" } }), /mixed/);
    assert.doesNotMatch(JSON.stringify(manifest), /abcdefghijklmnopqrst|appl_public_fixture|sb_publishable/);
    assert.throws(() => artifactManifest({ profile: "paid-sandbox", surface: "safari", sourceSha256: before.sha256, backendRouteProfile: "shared-hosted-sandbox",
      paidBuild: { ...build, flags: { ...build.flags, nativePaid: false } } }), /mixed/);
    assert.throws(() => artifactManifest({ profile: "paid-sandbox", surface: "chrome", sourceSha256: before.sha256, backendRouteProfile: "shared-hosted-sandbox", paidBuild: build }), /identity/);
    assert.throws(() => artifactManifest({ profile: "paid-sandbox", surface: "safari", sourceSha256: "0".repeat(64), backendRouteProfile: "shared-hosted-sandbox", paidBuild: build }), /identity/);
    await assert.rejects(paid.isolatedSandboxSource(root, config, async () => { throw new Error("fixture build failed"); }), /fixture build failed/);
    assert.equal((await paid.sourceSnapshot(root)).sha256, before.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mixed original flags refuse without editing any source and incomplete base cannot build paid artifacts", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, paid.PAID_FLAGS.native), "public static let paidTierEnabled = true\n");
    const before = await paid.sourceSnapshot(root);
    await assert.rejects(paid.isolatedSandboxSource(root, paid.sandboxConfiguration(paidInputs), async () => assert.fail("must not build")), /both original paid constants/);
    assert.equal((await paid.sourceSnapshot(root)).sha256, before.sha256);
    await mkdir(join(root, ".output/v3-qa/paid-sandbox/safari"), { recursive: true });
    await writeFile(join(root, ".output/v3-qa/paid-sandbox/safari/artifact-manifest.json"), "stale-success");
    await assert.rejects(paidSandboxMain("safari", paidInputs, root), /trust wiring is missing/);
    await assert.rejects(readFile(join(root, ".output/v3-qa/paid-sandbox/safari/artifact-manifest.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("paid sandbox refuses a missing or production route before candidate installation", async () => {
  const root = await fixture();
  try {
    for (const value of [undefined, "production", "unknown"]) {
      await assert.rejects(paidSandboxMain("chrome", { ...paidInputs, STILL_QA_BACKEND_ROUTE_PROFILE: value }, root), /route profile/);
      await assert.rejects(readFile(join(root, ".output/v3-qa/paid-sandbox/chrome/artifact-manifest.json")), /ENOENT/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("complete paid builds require client and native route source prerequisites before installation", async () => {
  const root = await fixture();
  try {
    const core = "packages/core/src/sync/backend-route-profile.ts";
    const native = "apps/apple/StillKit/Sources/StillKit/NativeAccessConfiguration.swift";
    for (const path of ["packages/core/src/entitlement/packaged-access-trust.ts", native]) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), "source fixture");
    }
    const catalog = "apps/apple/StillKit/Sources/StillKit/ApplePurchaseCatalog.swift";
    await writeFile(join(root, catalog), `public static let stillProV3 = ApplePurchaseProduct(
      productID: "still_pro_v3", entitlementID: "still_pro_v3", offeringID: "still_pro_v3", packageID: "$rc_lifetime")
      public static let historicalStillSync = ApplePurchaseProduct(productID: "still_sync")`);
    await assert.rejects(paid.requireIntegratedPaidCandidate(root), /backend route profile source is missing/);
    await mkdir(join(root, core, ".."), { recursive: true });
    await writeFile(join(root, core), "route source fixture");
    await assert.rejects(paid.requireIntegratedPaidCandidate(root), /native backend route profile source is missing/);
    await writeFile(join(root, native), 'let key = "StillBackendRouteProfile"');
    await paid.requireIntegratedPaidCandidate(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packaged app and extension require the same typed sandbox trust, backend and bundle identity", () => {
  const config = paid.sandboxConfiguration(paidInputs), fields = paid.plistConfiguration(config);
  const app = { ...fields, CFBundleIdentifier: "com.chartash.still", RevenueCatPublicAPIKey: config.revenueCatKey };
  const ext = { ...fields, CFBundleIdentifier: "com.chartash.still.Extension" };
  paid.assertNativePlist(app, app.CFBundleIdentifier, config);
  paid.assertNativePlist(ext, ext.CFBundleIdentifier, config);
  const reordered = { ...ext, StillAccessTrustKeys: [{ purpose: "access", environment: "sandbox", publicKeyHex: sandboxKey.publicKeyHex, kid: sandboxKey.kid }] };
  paid.assertNativePlist(reordered, ext.CFBundleIdentifier, config);
  for (const changed of [
    { StillAccessEnvironment: "production" }, { StillAccessTrustKeys: JSON.stringify([sandboxKey]) },
    { StillAccessTrustKeys: [] }, { StillAccessTrustKeys: [{ ...sandboxKey, publicKeyHex: "34".repeat(32) }] },
    { StillAccessSupabaseURL: "https://other.invalid" }, { StillAccessSupabasePublishableKey: "sb_publishable_other" },
    { CFBundleIdentifier: "org.example.forged" },
  ]) assert.throws(() => paid.assertNativePlist({ ...ext, ...changed }, ext.CFBundleIdentifier, config), /mismatch/);
  assert.throws(() => paid.assertNativePlist({ ...app, RevenueCatPublicAPIKey: "appl_other" }, app.CFBundleIdentifier, config), /mismatch/);
});

test("packaged app and extension reject missing or mismatched backend route profiles", () => {
  const config = paid.sandboxConfiguration(paidInputs), fields = paid.plistConfiguration(config);
  assert.equal(fields.StillBackendRouteProfile, "shared-hosted-sandbox");
  for (const bundleId of ["com.chartash.still", "com.chartash.still.Extension"]) {
    const plist = { ...fields, CFBundleIdentifier: bundleId, ...(bundleId === "com.chartash.still" ? { RevenueCatPublicAPIKey: config.revenueCatKey } : {}) };
    paid.assertNativePlist(plist, bundleId, config);
    for (const value of [undefined, "production", "sandbox", "shared-hosted-sandbox "])
      assert.throws(() => paid.assertNativePlist({ ...plist, StillBackendRouteProfile: value }, bundleId, config), /mismatch/);
  }
});

test("changed clone paid flags cannot issue a receipt and original source is still preserved", async () => {
  const root = await fixture();
  try {
    const before = await paid.sourceSnapshot(root);
    await assert.rejects(paid.isolatedSandboxSource(root, paid.sandboxConfiguration(paidInputs), async ({ clone }) => {
      await writeFile(join(clone, paid.PAID_FLAGS.native), "public static let paidTierEnabled = false\n");
    }), /changed during build/);
    assert.equal((await paid.sourceSnapshot(root)).sha256, before.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual packaged resource verification refuses a foreign webview or Safari worker", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "still-paid-package-test-"));
  const app = join(root, "Still.app"), ext = join(app, "PlugIns/Still Extension.appex"), config = paid.sandboxConfiguration(paidInputs);
  try {
    const files = {
      "packages/app-webview/dist/index.html": "<html>current candidate</html>",
      "packages/app-webview/dist/assets/current.js": "current-webview-script",
      "packages/ext-safari/dist/safari-mv3/manifest.json": '{"name":"Still"}',
      "packages/ext-safari/dist/safari-mv3/background.js": "current-sandbox-worker",
      "Still.app/WebUI/index.html": "<html>current candidate</html>",
      "Still.app/WebUI/assets/current.js": "current-webview-script",
      "Still.app/PlugIns/Still Extension.appex/manifest.json": '{"name":"Still"}',
      "Still.app/PlugIns/Still Extension.appex/background.js": "current-sandbox-worker",
      "Still.app/Info.plist": JSON.stringify({ ...paid.plistConfiguration(config), CFBundleIdentifier: "com.chartash.still", RevenueCatPublicAPIKey: config.revenueCatKey }),
      "Still.app/PlugIns/Still Extension.appex/Info.plist": JSON.stringify({ ...paid.plistConfiguration(config), CFBundleIdentifier: "com.chartash.still.Extension" }),
    };
    for (const [path, bytes] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), bytes); }
    const verified = await paid.verifyApplePackage(app, "apple-ios-sim", config, root);
    assert.equal(verified.nativeInfoPlistsMatched, true); assert.equal(verified.codeSigned, false);
    await writeFile(join(app, "WebUI/assets/current.js"), "foreign-webview-script");
    await assert.rejects(paid.verifyApplePackage(app, "apple-ios-sim", config, root), /webview differs/);
    await writeFile(join(app, "WebUI/assets/current.js"), "current-webview-script");
    await writeFile(join(app, "WebUI/stale.js"), "stale-webview-script");
    await assert.rejects(paid.verifyApplePackage(app, "apple-ios-sim", config, root), /webview differs/);
    await rm(join(app, "WebUI/stale.js"));
    await writeFile(join(ext, "background.js"), "foreign-production-worker");
    await assert.rejects(paid.verifyApplePackage(app, "apple-ios-sim", config, root), /Safari resources differ/);
    await writeFile(join(ext, "background.js"), "current-sandbox-worker");
    await writeFile(join(ext, "stale.js"), "unexpected-packaged-web-script");
    await assert.rejects(paid.verifyApplePackage(app, "apple-ios-sim", config, root), /Safari resources differ/);
    await rm(join(ext, "stale.js"));
    await writeFile(join(app, "WebUI/index.html"), "foreign-webview");
    await assert.rejects(paid.verifyApplePackage(app, "apple-ios-sim", config, root), /webview differs/);
    await writeFile(join(app, "WebUI/index.html"), "<html>current candidate</html>");
    const { copyFile } = await import("node:fs/promises");
    for (const bundle of [ext, app]) {
      const path = join(bundle, "Info.plist");
      const fields = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...fields, CFBundleExecutable: "FixtureBinary", CFBundlePackageType: bundle === app ? "APPL" : "XPC!" }));
      await copyFile("/usr/bin/true", join(bundle, "FixtureBinary"));
      execFileSync("/usr/bin/plutil", ["-convert", "xml1", path]);
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", bundle], { stdio: "pipe" });
    }
    // Ad-hoc code verifies structurally; it cannot establish the project's Apple signing team.
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
    await mkdir(join(root, "apps/apple/Still/Still.xcodeproj"), { recursive: true });
    await writeFile(join(root, "apps/apple/Still/Still.xcodeproj/project.pbxproj"), "DEVELOPMENT_TEAM = ZZZZZZZZZZ;\n");
    await assert.rejects(paid.verifyApplePackage(app, "apple-ios-archive", config, root), /reviewed Apple signing team/);
    await writeFile(join(root, "apps/apple/Still/Still.xcodeproj/project.pbxproj"), "DEVELOPMENT_TEAM = UM9HVDH3P3;\n");
    await assert.rejects(paid.verifyApplePackage(app, "apple-ios-archive", config, root), /local codesign check failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("development device export never uploads or requests provisioning changes", () => {
  const options = paid.developmentExportOptions();
  assert.match(options, /<key>method<\/key><string>debugging<\/string>/);
  assert.match(options, /<key>destination<\/key><string>export<\/string>/);
  assert.match(options, /<key>teamID<\/key><string>UM9HVDH3P3<\/string>/);
  assert.doesNotMatch(options, /upload|app-store|enterprise|allowProvisioning/i);
  for (const target of ["apple-ios-device", "apple-macos-device"])
    assert.deepEqual([paid.APPLE_TARGETS[target].signed, paid.APPLE_TARGETS[target].archive], [true, true]);
});

test("development device packages require the reviewed team, a device-limited live profile and the App Group", () => {
  const now = Date.parse("2026-10-08T00:00:00Z");
  const profileFor = (bundle, overrides = {}) => ({
    teams: ["UM9HVDH3P3"], devices: ["device-a"], allDevices: false, expires: "2027-06-24T00:00:00Z",
    entitlements: { "application-identifier": `UM9HVDH3P3.${bundle.endsWith(".appex") ? "com.chartash.still.Extension" : "com.chartash.still"}` },
    ...overrides,
  });
  const entitlements = () => ({ "com.apple.security.application-groups": ["group.com.chartash.still"] });
  const verify = (profileOverrides = {}, signed = entitlements, target = "apple-ios-device") =>
    paid.verifyDevelopmentSigning("/qa/Still.app", target, { now, readEntitlements: signed, readProfile: bundle => profileFor(bundle, profileOverrides) });
  const verified = verify();
  assert.equal(verified.developmentSigned, true);
  assert.deepEqual(verified.bundles.map(bundle => [bundle.bundleId, bundle.provisionedDeviceCount]), [["com.chartash.still", 1], ["com.chartash.still.Extension", 1]]);
  // Receipts carry counts and dates, never device identifiers.
  assert.doesNotMatch(JSON.stringify(verified), /device-a/);
  // Mac profiles name the identifier with the com.apple prefix.
  const mac = paid.verifyDevelopmentSigning("/qa/Still.app", "apple-macos-device", { now, readEntitlements: entitlements,
    readProfile: bundle => profileFor(bundle, { entitlements: { "com.apple.application-identifier": profileFor(bundle).entitlements["application-identifier"] } }) });
  assert.equal(mac.bundles.length, 2);
  assert.throws(() => verify({ teams: ["ZZZZZZZZZZ"] }), /reviewed team/);
  assert.throws(() => verify({ entitlements: { "application-identifier": "UM9HVDH3P3.org.example.other" } }), /reviewed team/);
  assert.throws(() => verify({ devices: undefined }), /device-limited/);
  assert.throws(() => verify({ devices: [] }), /device-limited/);
  assert.throws(() => verify({ allDevices: true }), /device-limited/);
  assert.throws(() => verify({ expires: "2026-10-07T00:00:00Z" }), /expired/);
  assert.throws(() => verify({ expires: undefined }), /expired/);
  assert.throws(() => verify({}, () => ({ "com.apple.security.application-groups": ["group.org.example"] })), /App Group/);
  assert.throws(() => verify({}, () => ({})), /App Group/);
  assert.throws(() => verify({}, entitlements, "apple-ios-archive"), /not a development device target/);
});

test("QA builds always label analytics as test and only ever send to the separate QA project", async () => {
  const { qaAnalyticsEnvironment, PRODUCTION_POSTHOG_KEY_SHA256 } = await import("./v3-profile.mjs");
  assert.deepEqual(qaAnalyticsEnvironment({}), { VITE_ANALYTICS_BUILD_CHANNEL: "test" });
  const key = "phc_" + "q".repeat(43);
  assert.deepEqual(qaAnalyticsEnvironment({ STILL_QA_POSTHOG_KEY: key, STILL_QA_POSTHOG_REGION: "eu" }),
    { VITE_ANALYTICS_BUILD_CHANNEL: "test", VITE_POSTHOG_KEY: key, VITE_POSTHOG_HOST: "https://eu.i.posthog.com" });
  assert.throws(() => qaAnalyticsEnvironment({ STILL_QA_POSTHOG_KEY: key }), /both/);
  assert.throws(() => qaAnalyticsEnvironment({ STILL_QA_POSTHOG_REGION: "us" }), /both/);
  assert.throws(() => qaAnalyticsEnvironment({ STILL_QA_POSTHOG_KEY: "phx_personal", STILL_QA_POSTHOG_REGION: "us" }), /phc_/);
  assert.throws(() => qaAnalyticsEnvironment({ STILL_QA_POSTHOG_KEY: key, STILL_QA_POSTHOG_REGION: "mars" }), /us or eu/);
  // The store project is refused by fingerprint, whatever region is given.
  const { createHash } = await import("node:crypto");
  const fakeStore = "phc_" + "s".repeat(43);
  assert.notEqual(createHash("sha256").update(fakeStore).digest("hex"), PRODUCTION_POSTHOG_KEY_SHA256);
  assert.match(PRODUCTION_POSTHOG_KEY_SHA256, /^[a-f0-9]{64}$/);
  // Inherited VITE_POSTHOG_* never reach a QA build: only the QA inputs above can supply analytics.
  const env = profileEnvironment("test", { STILL_QA_BACKEND_ENVIRONMENT: "shared-hosted", STILL_QA_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    STILL_QA_SUPABASE_ANON_KEY: "sb_publishable_fixture", VITE_POSTHOG_KEY: "phc_inherited", VITE_POSTHOG_HOST: "https://us.i.posthog.com" });
  assert.equal(env.VITE_ANALYTICS_BUILD_CHANNEL, "test");
  assert.equal(env.VITE_POSTHOG_KEY, undefined);
  assert.equal(env.VITE_POSTHOG_HOST, undefined);
  assert.equal(profileEnvironment("local", {}).VITE_ANALYTICS_BUILD_CHANNEL, undefined);
});

test("QA build sequence is main's first-parent commit count, only for a clean commit on main", async () => {
  const { qaBuildSequence } = await import("./v3-profile.mjs");
  const rev = "a".repeat(40), other = "b".repeat(40);
  const fake = ({ line = `${other}\n${rev}\n`, count = "306\n", lineStatus = 0, countStatus = 0 } = {}) => {
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push([cmd, args, opts.cwd]);
      return args[1] === "--first-parent" ? { stdout: line, status: lineStatus } : { stdout: count, status: countStatus };
    };
    return { run, calls };
  };
  const ok = fake();
  assert.equal(qaBuildSequence("/repo", { revision: rev, dirty: false }, ok.run), "306");
  assert.deepEqual(ok.calls, [
    ["git", ["rev-list", "--first-parent", "origin/main"], "/repo"],
    ["git", ["rev-list", "--count", "--first-parent", rev], "/repo"],
  ]);
  assert.throws(() => qaBuildSequence("/repo", { revision: rev, dirty: true }, fake().run), /clean checkout/);
  assert.throws(() => qaBuildSequence("/repo", { revision: rev }, fake().run), /clean checkout/);
  assert.throws(() => qaBuildSequence("/repo", { revision: rev, dirty: false }, fake({ line: `${other}\n` }).run), /main's own line/);
  assert.throws(() => qaBuildSequence("/repo", { revision: rev, dirty: false }, fake({ lineStatus: 128 }).run), /main's own line/);
  for (const count of ["0\n", "65536\n", "", "x\n"])
    assert.throws(() => qaBuildSequence("/repo", { revision: rev, dirty: false }, fake({ count }).run), /could not be derived/);
  assert.throws(() => qaBuildSequence("/repo", { revision: rev, dirty: false }, fake({ countStatus: 128 }).run), /could not be derived/);
  assert.throws(() => qaBuildSequence("/repo", { revision: "HEAD", dirty: false }, fake().run), /exact revision/);
});

// ---- integration packages (STILL_QA_INTEGRATION_BRANCH) ----

/** A 40-hex fake commit id per label, so fake histories never collide. */
const fakeSha = label => (label + "_").repeat(40).replace(/[^0-9a-f]/g, "0").slice(0, 40).padEnd(40, "0");
const mainSha = n => n.toString(16).padStart(40, "c");
/**
 * Fake git for qaIntegrationBuild: origin/main has `mainCount` first-parent commits (newest first),
 * and the branch is `heads` (newest first) on top of main's commit number `baseCount`.
 */
function fakeIntegrationGit({ mainCount = 440, baseCount = 438, heads = [["b2", "Merge PR #2"], ["b1", "Merge PR #1"]], branchStatus = 0, mainStatus = 0,
  ancestorStatus = 1, plain = [] } = {}) {
  const calls = [];
  const main = Array.from({ length: mainCount }, (_, i) => mainSha(mainCount - i));
  // Heads are --no-ff merges (two parents) unless listed in `plain`; main commits have one parent.
  const branch = [...heads.map(([label, subject], i) => `${fakeSha(label)}\t${[heads[i + 1] ? fakeSha(heads[i + 1][0]) : mainSha(baseCount), ...(plain.includes(label) ? [] : [fakeSha(`pr${label}`)])].join(" ")}\t${subject}`),
    ...Array.from({ length: baseCount }, (_, i) => `${mainSha(baseCount - i)}\t${baseCount - i > 1 ? mainSha(baseCount - i - 1) : ""}\tmain ${baseCount - i}`)];
  const run = (cmd, args, opts) => {
    calls.push([cmd, args, opts.cwd]);
    assert.equal(Object.keys(opts.env ?? {}).some(key => key.startsWith("GIT_")), false, "integration Git calls drop inherited GIT_* overrides");
    assert.ok(opts.env, "integration Git calls pass the filtered environment");
    if (args[0] === "log") return { status: branchStatus, stdout: branchStatus ? "" : `${branch.join("\n")}\n` };
    if (args.at(-1) === "origin/main") return { status: mainStatus, stdout: mainStatus ? "" : `${main.join("\n")}\n` };
    if (args[0] === "merge-base") return { status: ancestorStatus, stdout: "" };
    return { status: 1, stdout: "" };
  };
  return { run, calls };
}

test("integration mode is opt-in through STILL_QA_INTEGRATION_BRANCH only; unset or empty runs no git and changes nothing", async () => {
  const { qaIntegrationBuild, INTEGRATION_BRANCH_INPUT } = await import("./v3-profile.mjs");
  assert.equal(INTEGRATION_BRANCH_INPUT, "STILL_QA_INTEGRATION_BRANCH");
  for (const input of [{}, { STILL_QA_INTEGRATION_BRANCH: "" }, { STILL_QA_INTEGRATION_BRANCHES: "qa/x", STILL_QA_INTEGRATION: "qa/x" }]) {
    const git = fakeIntegrationGit();
    assert.equal(qaIntegrationBuild("/repo", { revision: fakeSha("b2"), dirty: true }, input, git.run), undefined);
    assert.deepEqual(git.calls, []);
  }
  // The variable never reaches the build tools, like every other STILL_QA_ input.
  const env = profileEnvironment("paid-sandbox", { ...paidInputs, STILL_QA_INTEGRATION_BRANCH: "qa/integration" });
  assert.equal(Object.values(env).includes("qa/integration"), false);
});

test("an integration branch based on main at count 438 gets sequence 1438 and records its base and every merged head in order", async () => {
  const { qaIntegrationBuild } = await import("./v3-profile.mjs");
  const git = fakeIntegrationGit();
  const input = { STILL_QA_INTEGRATION_BRANCH: "qa/integration-20261022" };
  const built = qaIntegrationBuild("/repo", { revision: fakeSha("b2"), dirty: false }, input, git.run);
  assert.deepEqual(built, {
    branch: "qa/integration-20261022",
    base: { revision: mainSha(438), count: 438 },
    originMainCount: 440,
    sequence: 1438,
    mergedHeads: [{ revision: fakeSha("b1"), subject: "Merge PR #1" }, { revision: fakeSha("b2"), subject: "Merge PR #2" }],
  });
  assert.deepEqual(git.calls, [
    ["git", ["log", "--no-show-signature", "--first-parent", "--format=%H%x09%P%x09%s", "refs/heads/qa/integration-20261022", "--"], "/repo"],
    ["git", ["rev-list", "--first-parent", "origin/main"], "/repo"],
    // Main's commit right after the base (count 439) must not be in the package.
    ["git", ["merge-base", "--is-ancestor", mainSha(439), fakeSha("b2")], "/repo"],
  ]);
  // A commit lower on the branch's own line is accepted; only the heads below it are recorded.
  const lower = qaIntegrationBuild("/repo", { revision: fakeSha("b1"), dirty: false }, input, fakeIntegrationGit().run);
  assert.deepEqual(lower.mergedHeads, [{ revision: fakeSha("b1"), subject: "Merge PR #1" }]);
  assert.equal(lower.sequence, 1438);
  // A subject containing a tab survives intact.
  const tabbed = qaIntegrationBuild("/repo", { revision: fakeSha("t"), dirty: false }, input, fakeIntegrationGit({ heads: [["t", "Merge\tPR #3"]] }).run);
  assert.deepEqual(tabbed.mergedHeads, [{ revision: fakeSha("t"), subject: "Merge\tPR #3" }]);
});

test("integration builds refuse a dirty checkout, a missing branch, a revision off the branch, and a branch with no base on main", async () => {
  const { qaIntegrationBuild, qaBuildSequence } = await import("./v3-profile.mjs");
  const input = { STILL_QA_INTEGRATION_BRANCH: "qa/integration" };
  const build = (snapshot, options, branchInput = input) => qaIntegrationBuild("/repo", snapshot, branchInput, fakeIntegrationGit(options).run);
  const clean = { revision: fakeSha("b2"), dirty: false };
  // A dirty checkout is refused with exactly today's words.
  let today;
  try { qaBuildSequence("/repo", { revision: fakeSha("b2"), dirty: true }, fakeIntegrationGit().run); } catch (error) { today = error.message; }
  for (const dirty of [true, undefined]) assert.throws(() => build({ revision: fakeSha("b2"), dirty }), { message: today });
  assert.throws(() => build({ revision: "HEAD", dirty: false }), /exact revision/);
  assert.throws(() => build(clean, { branchStatus: 128 }),
    { message: "Integration QA packages need a local branch named qa/integration (create it from origin/main and merge the approved PR branches into it with git merge --no-ff, or unset STILL_QA_INTEGRATION_BRANCH to build from main)" });
  for (const name of ["-x", "a..b", "has space", "qa/x;rm"]) {
    const git = fakeIntegrationGit();
    assert.throws(() => qaIntegrationBuild("/repo", clean, { STILL_QA_INTEGRATION_BRANCH: name }, git.run),
      { message: `${name} is not a usable branch name (set STILL_QA_INTEGRATION_BRANCH to the local integration branch, for example qa/integration-20261022)` });
    assert.deepEqual(git.calls, [], "an unusable branch name never reaches git");
  }
  assert.throws(() => build({ revision: fakeSha("elsewhere"), dirty: false }),
    { message: "Integration QA packages are built only from the head of qa/integration or a commit on its own line (check out qa/integration)" });
  assert.throws(() => build(clean, { mainStatus: 128 }), { message: "Integration QA packages need origin/main to compare against (fetch origin and try again)" });
  // The branch's own line never meets main's own line.
  assert.throws(() => build(clean, { baseCount: 0 }),
    { message: "Integration QA packages need qa/integration to start from a commit on main's own line (fetch, then recreate qa/integration from current origin/main and merge each PR branch with git merge --no-ff)" });
  assert.throws(() => build({ revision: mainSha(438), dirty: false }),
    { message: "Integration branch qa/integration has nothing merged above main, so there is nothing to integrate (merge the approved PR branches into it with git merge --no-ff, or unset STILL_QA_INTEGRATION_BRANCH to build from main)" });
  assert.throws(() => build(clean, { ancestorStatus: 0 }),
    { message: "Integration branch qa/integration contains main commits newer than its base, so its number would understate what it contains (a PR branch merged a newer main, or main was merged into qa/integration); recreate qa/integration from current origin/main and merge each PR branch with git merge --no-ff" });
  assert.throws(() => build(clean, { ancestorStatus: 128 }), { message: "Integration QA packages could not compare the branch with origin/main (fetch origin and try again)" });
  assert.throws(() => build(clean, { plain: ["b1"] }),
    { message: `Integration branch qa/integration has a commit above main that is not a merge (${fakeSha("b1").slice(0, 12)} Merge PR #1); recreate qa/integration from current origin/main and merge each PR branch with git merge --no-ff` });
  // With the base at main's tip there is no newer main commit to look for.
  const tip = fakeIntegrationGit({ mainCount: 438 });
  assert.equal(qaIntegrationBuild("/repo", clean, input, tip.run).sequence, 1438);
  assert.equal(tip.calls.some(([, args]) => args[0] === "merge-base"), false);
});

test("an integration number must stay more than 500 above main's current count and within 1 to 65535", async () => {
  const { qaIntegrationBuild } = await import("./v3-profile.mjs");
  const input = { STILL_QA_INTEGRATION_BRANCH: "qa/integration" };
  const build = options => qaIntegrationBuild("/repo", { revision: fakeSha("b2"), dirty: false }, input, fakeIntegrationGit(options).run);
  assert.equal(build({ baseCount: 438, mainCount: 937 }).sequence, 1438);
  assert.throws(() => build({ baseCount: 438, mainCount: 938 }),
    { message: "Integration QA package number 1438 is too close to main, which is already at 938; it must be more than 500 ahead of main's count (recreate qa/integration from current origin/main and merge the PR branches again with git merge --no-ff)" });
  assert.throws(() => build({ baseCount: 438, mainCount: 1500 }), /too close to main/);
  assert.equal(build({ baseCount: 64535, mainCount: 64535 }).sequence, 65535);
  assert.throws(() => build({ baseCount: 64536, mainCount: 64536 }),
    { message: "Integration QA package number 65536 is above 65535, the largest a browser version part allows (bump the store version and change the QA numbering before building more integration packages)" });
  assert.equal(build({ baseCount: 1, mainCount: 1 }).sequence, 1001);
});

test("integration mode reads a real Git history: base, count and merged heads come from first-parent lines", async () => {
  const { qaIntegrationBuild } = await import("./v3-profile.mjs");
  const repo = await mkdtemp(join(tmpdir(), "still-qa-integration-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, encoding: "utf8", env }).trim();
  try {
    git("init", "-q", "-b", "main");
    for (const n of [1, 2, 3]) git("commit", "-q", "--allow-empty", "-m", `main ${n}`);
    const base = git("rev-parse", "HEAD");
    git("switch", "-q", "-c", "pr-one"); git("commit", "-q", "--allow-empty", "-m", "PR one work");
    git("switch", "-q", "-c", "pr-two", "main"); git("commit", "-q", "--allow-empty", "-m", "PR two work");
    const prTwo = git("rev-parse", "HEAD");
    git("switch", "-q", "-c", "qa/integration", "main");
    git("merge", "-q", "--no-ff", "-m", "Merge PR one", "pr-one"); const first = git("rev-parse", "HEAD");
    git("merge", "-q", "--no-ff", "-m", "Merge PR two", "pr-two"); const second = git("rev-parse", "HEAD");
    // Main moves on after the branch was cut; the base stays where the branch started.
    git("switch", "-q", "main"); git("commit", "-q", "--allow-empty", "-m", "main 4");
    git("update-ref", "refs/remotes/origin/main", "main");
    const input = { STILL_QA_INTEGRATION_BRANCH: "qa/integration" };
    assert.deepEqual(qaIntegrationBuild(repo, { revision: second, dirty: false }, input), {
      branch: "qa/integration", base: { revision: base, count: 3 }, originMainCount: 4, sequence: 1003,
      mergedHeads: [{ revision: first, subject: "Merge PR one" }, { revision: second, subject: "Merge PR two" }],
    });
    // A merged PR's own commit is on the branch's history but not its first-parent line.
    assert.throws(() => qaIntegrationBuild(repo, { revision: prTwo, dirty: false }, input), /head of qa\/integration/);
    assert.throws(() => qaIntegrationBuild(repo, { revision: second, dirty: false }, { STILL_QA_INTEGRATION_BRANCH: "qa/missing" }), /local branch named qa\/missing/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("the candidate identity and every manifest carry the integration block only for integration packages", async () => {
  const { qaIntegrationBuild } = await import("./v3-profile.mjs");
  const integration = qaIntegrationBuild("/repo", { revision: fakeSha("b2"), dirty: false }, { STILL_QA_INTEGRATION_BRANCH: "qa/integration" }, fakeIntegrationGit().run);
  const overlay = { mode: "paid-sandbox", environment: "sandbox", backendRouteProfile: "shared-hosted-sandbox", trustSha256: "a".repeat(64),
    flags: { jsPaid: true, nativePaid: true, modernSettingsSync: true, appleAtomicSettings: true } };
  const snapshot = { sha256: "b".repeat(64) };
  const plain = paid.candidateIdentity(snapshot, overlay, ["chrome"]);
  const integrated = paid.candidateIdentity(snapshot, overlay, ["chrome"], integration);
  assert.equal(Object.hasOwn(plain, "integration"), false);
  assert.deepEqual(integrated.integration, integration);
  // Nothing else in the identity changes (buildId is random per build).
  const strip = ({ integration: _i, buildId: _b, candidateSha256: _c, ...rest }) => rest;
  assert.deepEqual(strip(integrated), strip(plain));
  assert.deepEqual(Object.keys(integrated).filter(key => key !== "integration"), Object.keys(plain));
  const manifestFor = (paidBuild, extra = {}) => artifactManifest({ profile: "paid-sandbox", surface: "chrome", revision: fakeSha("b2"), dirty: false,
    sourceSha256: snapshot.sha256, backendRouteProfile: "shared-hosted-sandbox", backendUrl: "https://hosted-fixture.invalid",
    artifacts: { totalBytes: 0, files: [] }, paidBuild, ...extra });
  const main = manifestFor(plain), integ = manifestFor(integrated, { integration });
  assert.equal(Object.hasOwn(main, "integration"), false, "main builds have no integration block, not even null");
  assert.deepEqual(integ.integration, integration);
  assert.deepEqual(integ.paidBuild.integration, integration);
  const { integration: _block, paidBuild: _p, ...integRest } = integ, { paidBuild: _q, ...mainRest } = main;
  assert.deepEqual(integRest, mainRest, "the integration block is the only difference in the receipt");
  assert.deepEqual(Object.keys(integ).filter(key => key !== "integration"), Object.keys(main));
  // The receipt and the candidate identity must describe the same integration.
  assert.throws(() => manifestFor(plain, { integration }), /identity mismatch/);
  assert.throws(() => manifestFor(integrated), /identity mismatch/);
  assert.throws(() => manifestFor(integrated, { integration: { ...integration, branch: "qa/other" } }), /identity mismatch/);
  for (const broken of [null, { ...integration, sequence: 1439 }, { ...integration, mergedHeads: [] }, { ...integration, originMainCount: 938 },
    { ...integration, base: { ...integration.base, revision: "HEAD" } }, { ...integration, mergedHeads: [{ revision: "x", subject: "s" }] }])
    assert.throws(() => manifestFor({ ...plain, integration: broken }, { integration: broken }), /Integration record/);
  // Local and test profiles never carry one.
  assert.throws(() => artifactManifest({ profile: "local", surface: "chrome", revision: fakeSha("b2"), dirty: false, sourceSha256: snapshot.sha256,
    artifacts: { totalBytes: 0, files: [] }, integration }), /Integration record/);
});

test("the paid sandbox builder reads STILL_QA_INTEGRATION_BRANCH and refuses before installing; without it the main-only rule still applies", async () => {
  const root = await fixture();
  try {
    const sources = {
      "packages/core/src/entitlement/packaged-access-trust.ts": "source fixture",
      "packages/core/src/sync/backend-route-profile.ts": "route source fixture",
      "apps/apple/StillKit/Sources/StillKit/NativeAccessConfiguration.swift": 'let key = "StillBackendRouteProfile"',
      "apps/apple/StillKit/Sources/StillKit/ApplePurchaseCatalog.swift": `public static let stillProV3 = ApplePurchaseProduct(
      productID: "still_pro_v3", entitlementID: "still_pro_v3", offeringID: "still_pro_v3", packageID: "$rc_lifetime")
      public static let historicalStillSync = ApplePurchaseProduct(productID: "still_sync")`,
      ".gitignore": ".output/\n",
    };
    for (const [path, bytes] of Object.entries(sources)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), bytes); }
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "prerequisites"], { cwd: root });
    const receipt = join(root, ".output/v3-qa/paid-sandbox/chrome/artifact-manifest.json");
    for (const [input, expected] of [
      [{ ...paidInputs, STILL_QA_INTEGRATION_BRANCH: "qa/integration" }, /need a local branch named qa\/integration/],
      [paidInputs, /main's own line/],
      [{ ...paidInputs, STILL_QA_INTEGRATION_BRANCH: "" }, /main's own line/],
    ]) {
      await mkdir(join(receipt, ".."), { recursive: true });
      await writeFile(receipt, "stale-success");
      await assert.rejects(paidSandboxMain("chrome", input, root), expected);
      await assert.rejects(readFile(receipt), /ENOENT/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("integration builds refuse a package that holds newer main than its base or a PR that was fast-forwarded instead of merged", async () => {
  const { qaIntegrationBuild } = await import("./v3-profile.mjs");
  const input = { STILL_QA_INTEGRATION_BRANCH: "qa/x" };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const scenario = async (steps, expected) => {
    const repo = await mkdtemp(join(tmpdir(), "still-qa-integration-refuse-"));
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo, encoding: "utf8", env }).trim();
    try {
      git("init", "-q", "-b", "main");
      for (const n of [1, 2, 3]) git("commit", "-q", "--allow-empty", "-m", `main ${n}`);
      steps(git);
      assert.throws(() => qaIntegrationBuild(repo, { revision: git("rev-parse", "HEAD"), dirty: false }, input), expected);
    } finally { await rm(repo, { recursive: true, force: true }); }
  };
  const newer = /contains main commits newer than its base[\s\S]*git merge --no-ff/;
  // A: the branch was cut from a PR branch and main was merged into it (first parent is the PR).
  await scenario(git => {
    git("switch", "-q", "-c", "pr", "main"); git("commit", "-q", "--allow-empty", "-m", "PR work");
    git("switch", "-q", "main"); for (let n = 4; n <= 10; n++) git("commit", "-q", "--allow-empty", "-m", `main ${n}`);
    git("update-ref", "refs/remotes/origin/main", "main");
    git("switch", "-q", "-c", "qa/x", "pr"); git("merge", "-q", "--no-ff", "-m", "Merge origin/main into qa/x", "main");
  }, newer);
  // B: the PR branch had already merged origin/main, so a plain merge fast-forwards onto the PR's own line.
  await scenario(git => {
    git("switch", "-q", "-c", "pr", "main"); git("commit", "-q", "--allow-empty", "-m", "PR work");
    git("switch", "-q", "main"); for (let n = 4; n <= 10; n++) git("commit", "-q", "--allow-empty", "-m", `main ${n}`);
    git("switch", "-q", "pr"); git("merge", "-q", "--no-ff", "-m", "Merge origin/main into pr", "main");
    git("update-ref", "refs/remotes/origin/main", "main");
    git("switch", "-q", "-c", "qa/x", "main"); git("merge", "-q", "--ff", "pr");
  }, newer);
  // C: an up-to-date PR fast-forwards, so the first-parent line holds the PR's plain commits.
  await scenario(git => {
    git("update-ref", "refs/remotes/origin/main", "main");
    git("switch", "-q", "-c", "pr", "main");
    git("commit", "-q", "--allow-empty", "-m", "PR work a"); git("commit", "-q", "--allow-empty", "-m", "PR work b");
    git("switch", "-q", "-c", "qa/x", "main"); git("merge", "-q", "--ff", "pr");
  }, /is not a merge \([0-9a-f]{12} PR work a\)[\s\S]*git merge --no-ff/);
  // The same up-to-date PR merged with --no-ff is accepted and recorded as one merged head.
  const repo = await mkdtemp(join(tmpdir(), "still-qa-integration-noff-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, encoding: "utf8", env }).trim();
  try {
    git("init", "-q", "-b", "main");
    for (const n of [1, 2, 3]) git("commit", "-q", "--allow-empty", "-m", `main ${n}`);
    git("update-ref", "refs/remotes/origin/main", "main");
    git("switch", "-q", "-c", "pr", "main"); git("commit", "-q", "--allow-empty", "-m", "PR work a");
    git("switch", "-q", "-c", "qa/x", "main"); git("merge", "-q", "--no-ff", "-m", "Merge pr", "pr");
    const built = qaIntegrationBuild(repo, { revision: git("rev-parse", "HEAD"), dirty: false }, input);
    assert.deepEqual([built.base.count, built.sequence, built.mergedHeads.map(head => head.subject)], [3, 1003, ["Merge pr"]]);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
