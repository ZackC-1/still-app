import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const paidInputs = { ...inputs, STILL_QA_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  STILL_QA_ACCESS_ENVIRONMENT: "sandbox", STILL_QA_ACCESS_PUBLIC_KEYS: JSON.stringify([sandboxKey]),
  STILL_QA_REVENUECAT_PUBLIC_API_KEY: "appl_public_fixture" };

const paid = await import("../../apps/apple/scripts/paid-sandbox-qa.mjs");
const { execFileSync } = await import("node:child_process");
const { readFile } = await import("node:fs/promises");

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
      for (const file of overlay.overlayFiles) { assert.match(file.beforeSha256, /^[a-f0-9]{64}$/); assert.notEqual(file.beforeSha256, file.sha256); }
      for (const part of ["iOS (App)", "iOS (Extension)", "macOS (App)", "macOS (Extension)"]) {
        const text = await readFile(join(clone, `apps/apple/Still/${part}/Info.plist`), "utf8");
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
      sourceSha256: before.sha256, backendUrl: paidInputs.STILL_QA_SUPABASE_URL, artifacts: { totalBytes: 0, files: [] }, paidBuild: build });
    assert.equal(manifest.runtime.paidTierEnabled, true); assert.equal(manifest.trust.sandboxProofAccepted, true);
    assert.equal(manifest.paidBuild.flags.nativePaid, true);
    assert.doesNotMatch(JSON.stringify(manifest), /abcdefghijklmnopqrst|appl_public_fixture|sb_publishable/);
    assert.throws(() => artifactManifest({ profile: "paid-sandbox", surface: "safari", sourceSha256: before.sha256,
      paidBuild: { ...build, flags: { ...build.flags, nativePaid: false } } }), /mixed/);
    assert.throws(() => artifactManifest({ profile: "paid-sandbox", surface: "chrome", sourceSha256: before.sha256, paidBuild: build }), /identity/);
    assert.throws(() => artifactManifest({ profile: "paid-sandbox", surface: "safari", sourceSha256: "0".repeat(64), paidBuild: build }), /identity/);
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
