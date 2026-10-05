import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { buildPackages, cleanEnv, PUBLIC_ENV_KEYS, sourceEntries, treeEntries, unlistedViteReferences } from "./package.mjs";
import { assertBuildHistory, bumpBuild, compareSemver, findMismatches, isShallow, parseVersions, readVersions, ROOT, setVersion, sync } from "./version.mjs";
import { createZip } from "./zip.mjs";

// The lowest appleBuild ever recorded on main when this guard was written. Raise it with every
// shipped build; it must never be lowered.
const BUILD_FLOOR = 9;

// Built from parts so this file, which ships in the source bundle, never contains the marker itself.
const MARKER = ["PLANTED", "MARKER"].join("-");

const VERSION_FILES = ["version.json", "packages/ext-chromium/package.json", "packages/ext-safari/package.json", "apps/apple/Still/Still.xcodeproj/project.pbxproj"];

function copyVersionFiles() {
  const root = mkdtempSync(join(tmpdir(), "still-version-"));
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  return root;
}

function unzipFile(zip, name) {
  const run = spawnSync("unzip", ["-p", zip, name], { encoding: "buffer" });
  assert.equal(run.status, 0, `unzip -p ${name} failed`);
  return run.stdout;
}

// ---- one version source ----

test("every consumer agrees with version.json", () => {
  assert.deepEqual(findMismatches(), []);
});

test("version.json is well formed", () => {
  assert.throws(() => parseVersions('{"extension":"2.1","apple":"2.1.0","appleBuild":9}'), /extension/);
  assert.throws(() => parseVersions('{"extension":"2.1.1","apple":"2.1.0","appleBuild":0}'), /appleBuild/);
  assert.throws(() => parseVersions('{"extension":"2.1.1","apple":"2.1.0","appleBuild":"9"}'), /appleBuild/);
});

test("a disagreeing consumer is reported, and sync repairs it", () => {
  const root = copyVersionFiles();
  try {
    const pkg = join(root, "packages/ext-chromium/package.json");
    writeFileSync(pkg, readFileSync(pkg, "utf8").replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    const pbx = join(root, "apps/apple/Still/Still.xcodeproj/project.pbxproj");
    writeFileSync(pbx, readFileSync(pbx, "utf8").replace("MARKETING_VERSION = 2.1.0;", "MARKETING_VERSION = 8.8.8;"));
    const problems = findMismatches(root);
    assert.equal(problems.length, 2, problems.join("\n"));
    sync(root);
    assert.deepEqual(findMismatches(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changing a version in version.json reaches the manifest source and every Xcode target", () => {
  const root = copyVersionFiles();
  try {
    setVersion("extension", "2.2.0", root);
    setVersion("apple", "2.2.0", root);
    assert.equal(JSON.parse(readFileSync(join(root, "packages/ext-chromium/package.json"), "utf8")).version, "2.2.0");
    assert.equal(JSON.parse(readFileSync(join(root, "packages/ext-safari/package.json"), "utf8")).version, "2.2.0");
    const pbx = readFileSync(join(root, "apps/apple/Still/Still.xcodeproj/project.pbxproj"), "utf8");
    assert.equal(pbx.match(/MARKETING_VERSION = 2\.2\.0;/g).length, 8);
    assert.equal(pbx.match(/MARKETING_VERSION = 2\.1\.0;/g), null);
    assert.deepEqual(findMismatches(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setVersion refuses to go backwards", () => {
  const root = copyVersionFiles();
  try {
    assert.throws(() => setVersion("extension", "2.0.9", root), /refusing to lower/);
    assert.equal(compareSemver("2.10.0", "2.9.0"), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the build counter only goes up ----

test("the current build number is at or above the recorded floor", () => {
  assert.ok(readVersions().appleBuild >= BUILD_FLOOR);
});

test("bumping the build counter increases it in every Xcode target and survives a version change", () => {
  const root = copyVersionFiles();
  try {
    const before = readVersions(root).appleBuild;
    assert.equal(bumpBuild(root), before + 1);
    setVersion("apple", "3.0.0", root);
    assert.equal(readVersions(root).appleBuild, before + 1, "a new marketing version must not reset the counter");
    const pbx = readFileSync(join(root, "apps/apple/Still/Still.xcodeproj/project.pbxproj"), "utf8");
    assert.equal(pbx.match(new RegExp(`CURRENT_PROJECT_VERSION = ${before + 1};`, "g")).length, 8);
    assert.deepEqual(findMismatches(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version.json's appleBuild never decreased anywhere in git history", () => {
  // Fails (never skips) on a shallow clone: a truncated history would make this check pass vacuously.
  assert.ok(assertBuildHistory() >= BUILD_FLOOR);
});

test("a shallow clone is detected and the history check refuses to pass", () => {
  assert.equal(isShallow(ROOT), false, "run the release tests with full history (fetch-depth: 0 in CI)");
  const base = mkdtempSync(join(tmpdir(), "still-shallow-"));
  try {
    const clone = join(base, "clone");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${ROOT}`, clone]);
    assert.equal(isShallow(clone), true);
    assert.throws(() => assertBuildHistory(clone), /shallow clone/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---- deterministic archives ----

test("zip bytes depend only on names and contents, not on order or timestamps", () => {
  const dir = mkdtempSync(join(tmpdir(), "still-zip-"));
  try {
    for (const [name, text] of [["b.txt", "bbbb bbbb bbbb bbbb"], ["a/c.txt", "cc"], ["a/a.txt", ""]]) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const first = createZip(treeEntries(dir));
    utimesSync(join(dir, "b.txt"), new Date(2001, 1, 1), new Date(2001, 1, 1));
    utimesSync(join(dir, "a/c.txt"), new Date(2030, 5, 5), new Date(2030, 5, 5));
    const second = createZip([...treeEntries(dir)].reverse());
    assert.ok(first.equals(second));
    const file = join(dir, "t.zip");
    writeFileSync(file, first);
    assert.equal(spawnSync("unzip", ["-tq", file]).status, 0, "a standard unzip must accept the archive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the AMO source bundle comes from tracked files only and carries build instructions", () => {
  const names = sourceEntries(ROOT, { allowDirty: true }).map((e) => e.name);
  assert.ok(names.includes("pnpm-lock.yaml"));
  assert.ok(names.includes("packages/ext-chromium/wxt.config.ts"));
  assert.ok(names.includes("version.json"));
  assert.ok(!names.some((n) => /(^|\/)\.env($|\.(?!example$))/.test(n)), "no .env file may be bundled");
  assert.ok(!names.some((n) => n.startsWith("apps/") || n.startsWith("supabase/") || n.includes("node_modules")));
});

// ---- the real packages ----

test("unlisted VITE_ variables read by shipped source stop the build, and the repo has none", () => {
  assert.deepEqual(unlistedViteReferences(ROOT), []);
  assert.ok(PUBLIC_ENV_KEYS.includes("VITE_MODERN_SETTINGS_SYNC_ENABLED"));
  const root = mkdtempSync(join(tmpdir(), "still-env-"));
  try {
    mkdirSync(join(root, "packages/ext-chromium/entrypoints"), { recursive: true });
    writeFileSync(join(root, "packages/ext-chromium/entrypoints/new.ts"), "const x = import.meta.env.VITE_BRAND_NEW_FLAG;\nconst y = import.meta.env.VITE_SUPABASE_URL;\n");
    mkdirSync(join(root, "packages/ext-chromium/entrypoints/__tests__"), { recursive: true });
    writeFileSync(join(root, "packages/ext-chromium/entrypoints/__tests__/t.test.ts"), "VITE_ONLY_IN_TESTS");
    writeFileSync(join(root, "packages/ext-chromium/entrypoints/page.html"), "<title>%VITE_FROM_HTML%</title>");
    writeFileSync(join(root, "packages/ext-chromium/entrypoints/view.tsx"), "export const a = import.meta.env.WXT_TSX_FLAG;");
    for (const ext of ["jsx", "mts", "cts", "cjs"]) writeFileSync(join(root, `packages/ext-chromium/entrypoints/f.${ext}`), `x(VITE_IN_${ext.toUpperCase()});`);
    assert.deepEqual(unlistedViteReferences(root), ["VITE_BRAND_NEW_FLAG", "VITE_FROM_HTML", "VITE_IN_CJS", "VITE_IN_CTS", "VITE_IN_JSX", "VITE_IN_MTS", "WXT_TSX_FLAG"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build environments drop VITE_ and WXT_ variables from the shell", () => {
  process.env.WXT_RELEASE_TEST_LEAK = "x";
  process.env.VITE_RELEASE_TEST_LEAK = "x";
  try {
    const env = cleanEnv({ VITE_SUPABASE_URL: "given" });
    assert.equal(env.WXT_RELEASE_TEST_LEAK, undefined);
    assert.equal(env.VITE_RELEASE_TEST_LEAK, undefined);
    assert.equal(env.VITE_SUPABASE_URL, "given");
    assert.ok(env.PATH);
  } finally {
    delete process.env.WXT_RELEASE_TEST_LEAK;
    delete process.env.VITE_RELEASE_TEST_LEAK;
  }
});

test("a symlink is refused rather than followed when zipping", () => {
  const dir = mkdtempSync(join(tmpdir(), "still-link-"));
  try {
    writeFileSync(join(dir, "real.txt"), "x");
    symlinkSync("/etc/hosts", join(dir, "link.txt"));
    assert.throws(() => treeEntries(dir), /symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cloneRepo(base) {
  const clone = join(base, "clone");
  execFileSync("git", ["clone", "--quiet", `file://${ROOT}`, clone]);
  return clone;
}

/** Put a fake `pnpm` first on PATH for the duration of `fn`; it records its calls and runs `body`. */
function withFakePnpm(body, fn) {
  const bin = mkdtempSync(join(tmpdir(), "still-fakepnpm-"));
  const calls = join(bin, "calls.log");
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\n${body}\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${saved}`;
  try {
    return fn(() => (existsSync(calls) ? readFileSync(calls, "utf8") : ""));
  } finally {
    process.env.PATH = saved;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("a tracked symlink is refused before anything is installed or built, and --out stays empty", () => {
  const base = mkdtempSync(join(tmpdir(), "still-trackedlink-"));
  try {
    const clone = cloneRepo(base);
    symlinkSync("/etc/hosts", join(clone, "packages/ext-chromium/public/tracked-link"));
    execFileSync("git", ["add", "-A"], { cwd: clone });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "tracked symlink"], { cwd: clone });
    const out = join(base, "out");
    withFakePnpm("process.exit(1);", (calls) => {
      assert.throws(() => buildPackages({ out, root: clone }), /symlink/);
      assert.equal(calls(), "", "pnpm must not run before the symlink refusal");
    });
    assert.equal(existsSync(out) ? readdirSync(out).length : 0, 0, "--out must contain nothing");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a run that fails after the Chrome zip is ready leaves --out untouched", () => {
  const base = mkdtempSync(join(tmpdir(), "still-staging-"));
  try {
    const out = join(base, "out");
    const version = readVersions().extension;
    // Fake build: Chrome gets the right manifest version, Firefox a wrong one.
    const body = `const script = process.argv[4];
if (script === "build" || script === "build:firefox") {
  const dir = process.cwd() + "/packages/ext-chromium/dist/" + (script === "build" ? "chrome-mv3" : "firefox-mv3");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + "/manifest.json", JSON.stringify({ version: script === "build" ? ${JSON.stringify(version)} : "0.0.0" }));
}`;
    withFakePnpm(body, () => assert.throws(() => buildPackages({ out, root: ROOT, allowDirty: true }), /firefox manifest version 0\.0\.0/));
    assert.equal(existsSync(out) ? readdirSync(out).length : 0, 0, "no zip may be written when a later check fails");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("building twice gives byte-identical packages, and nothing untracked, stale or ignored in the checkout reaches them", { timeout: 600_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "still-packages-"));
  // Everything is planted inside a throwaway clone, so a developer's own files are never touched and a
  // killed run leaves nothing behind in the real checkout.
  const clone = cloneRepo(base);
  const ext = join(clone, "packages/ext-chromium");
  const planted = {
    untracked: join(ext, "public/PLANTED-untracked.txt"),
    link: join(ext, "public/PLANTED-link"),
    staleDist: join(ext, "dist/chrome-mv3/PLANTED-stale.txt"),
    staleFirefox: join(ext, "dist/firefox-mv3/PLANTED-stale.txt"),
    env: join(ext, ".env.local"),
  };
  const plant = () => {
    mkdirSync(join(ext, "dist/chrome-mv3"), { recursive: true });
    mkdirSync(join(ext, "dist/firefox-mv3"), { recursive: true });
    writeFileSync(planted.untracked, MARKER);
    symlinkSync("/etc/hosts", planted.link);
    writeFileSync(planted.staleDist, MARKER);
    writeFileSync(planted.staleFirefox, MARKER);
    writeFileSync(planted.env, `VITE_POSTHOG_KEY=${MARKER}\n`);
  };
  const unplant = () => Object.values(planted).forEach((path) => rmSync(path, { force: true }));
  try {
    const env = { VITE_SUPABASE_URL: "https://still-audit.invalid", VITE_SUPABASE_ANON_KEY: "public-audit-placeholder" };
    plant();
    const a = buildPackages({ out: join(base, "a"), root: clone, env, allowDirty: true });
    unplant();
    const b = buildPackages({ out: join(base, "b"), root: clone, env, allowDirty: true });
    assert.deepEqual(a, b);
    const versions = readVersions();
    assert.deepEqual(Object.keys(a.files), [`still-chrome-${versions.extension}.zip`, `still-firefox-${versions.extension}.zip`, `still-source-${versions.extension}.zip`]);
    for (const name of Object.keys(a.files)) {
      assert.ok(readFileSync(join(base, "a", name)).equals(readFileSync(join(base, "b", name))), `${name} differs between builds (planted files must not matter)`);
    }
    for (const name of Object.keys(a.files)) {
      const everything = spawnSync("unzip", ["-p", join(base, "a", name)], { encoding: "buffer", maxBuffer: 1 << 29 }).stdout;
      assert.ok(!everything.includes(MARKER), `${name} contains a planted file`);
      const listing = spawnSync("unzip", ["-Z1", join(base, "a", name)], { encoding: "utf8" }).stdout;
      assert.ok(!listing.includes("PLANTED"), `${name} lists a planted file`);
    }
    assert.equal(readFileSync(join(base, "a", "SHA256SUMS.json"), "utf8"), readFileSync(join(base, "b", "SHA256SUMS.json"), "utf8"));

    // The version inside every output is the one in version.json.
    for (const target of ["chrome", "firefox"]) {
      const manifest = JSON.parse(unzipFile(join(base, "a", `still-${target}-${versions.extension}.zip`), "manifest.json"));
      assert.equal(manifest.version, versions.extension);
    }
    const sourceZip = join(base, "a", `still-source-${versions.extension}.zip`);
    assert.equal(JSON.parse(unzipFile(sourceZip, "version.json")).extension, versions.extension);
    const instructions = unzipFile(sourceZip, "AMO-BUILD-INSTRUCTIONS.md").toString();
    assert.match(instructions, new RegExp(`version ${versions.extension.replaceAll(".", "\\.")}`));
    for (const key of PUBLIC_ENV_KEYS) assert.ok(instructions.includes(`${key}=`), `instructions list ${key}`);
    const sums = readFileSync(join(base, "a", "SHA256SUMS.txt"), "utf8");
    assert.equal(sums.trim().split("\n").length, 3);
    assert.ok(!sums.includes(base) && !readFileSync(join(base, "a", "SHA256SUMS.json"), "utf8").includes(base), "no machine path in the hash manifest");
  } finally {
    unplant();
    rmSync(base, { recursive: true, force: true });
  }
});

test("the Safari extension build carries the Apple version", { timeout: 300_000 }, () => {
  const run = spawnSync("pnpm", ["--filter", "@still/ext-safari", "build"], { cwd: ROOT, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITE_"))) });
  assert.equal(run.status, 0);
  const manifest = JSON.parse(readFileSync(join(ROOT, "packages/ext-safari/dist/safari-mv3/manifest.json"), "utf8"));
  assert.equal(manifest.version, readVersions().apple);
});
