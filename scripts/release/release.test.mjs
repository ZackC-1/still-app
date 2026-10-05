import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildPackages, sourceEntries, treeEntries } from "./package.mjs";
import { bumpBuild, compareSemver, findMismatches, parseVersions, readVersions, ROOT, setVersion, sync } from "./version.mjs";
import { createZip } from "./zip.mjs";

// The lowest appleBuild ever recorded on main when this guard was written. Raise it with every
// shipped build; it must never be lowered.
const BUILD_FLOOR = 9;

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

test("version.json's appleBuild never decreased anywhere in git history", (t) => {
  let hashes;
  try {
    hashes = execFileSync("git", ["log", "--format=%H", "--reverse", "--", "version.json"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return t.skip("no git history available");
  }
  let previous = 0;
  for (const hash of hashes) {
    const value = JSON.parse(execFileSync("git", ["show", `${hash}:version.json`], { cwd: ROOT, encoding: "utf8" })).appleBuild;
    assert.ok(value >= previous, `appleBuild fell from ${previous} to ${value} at ${hash}`);
    previous = value;
  }
  assert.ok(readVersions().appleBuild >= previous, "working copy is below the last committed build number");
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

test("building twice gives byte-identical packages with consistent versions", { timeout: 600_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "still-packages-"));
  try {
    const env = { VITE_SUPABASE_URL: "https://still-audit.invalid", VITE_SUPABASE_ANON_KEY: "public-audit-placeholder" };
    const a = buildPackages({ out: join(base, "a"), env, doBuild: true, allowDirty: true });
    const b = buildPackages({ out: join(base, "b"), env, doBuild: true, allowDirty: true });
    assert.deepEqual(a, b);
    const versions = readVersions();
    assert.deepEqual(Object.keys(a.files), [`still-chrome-${versions.extension}.zip`, `still-firefox-${versions.extension}.zip`, `still-source-${versions.extension}.zip`]);
    for (const name of Object.keys(a.files)) {
      assert.ok(readFileSync(join(base, "a", name)).equals(readFileSync(join(base, "b", name))), `${name} differs between builds`);
    }
    assert.equal(readFileSync(join(base, "a", "SHA256SUMS.json"), "utf8"), readFileSync(join(base, "b", "SHA256SUMS.json"), "utf8"));

    // The version inside every output is the one in version.json.
    for (const target of ["chrome", "firefox"]) {
      const manifest = JSON.parse(unzipFile(join(base, "a", `still-${target}-${versions.extension}.zip`), "manifest.json"));
      assert.equal(manifest.version, versions.extension);
    }
    const sourceZip = join(base, "a", `still-source-${versions.extension}.zip`);
    assert.equal(JSON.parse(unzipFile(sourceZip, "version.json")).extension, versions.extension);
    assert.match(unzipFile(sourceZip, "AMO-BUILD-INSTRUCTIONS.md").toString(), new RegExp(`version ${versions.extension.replaceAll(".", "\\.")}`));
    const sums = readFileSync(join(base, "a", "SHA256SUMS.txt"), "utf8");
    assert.equal(sums.trim().split("\n").length, 3);
    assert.ok(!sums.includes(base) && !readFileSync(join(base, "a", "SHA256SUMS.json"), "utf8").includes(base), "no machine path in the hash manifest");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the Safari extension build carries the Apple version", { timeout: 300_000 }, () => {
  const run = spawnSync("pnpm", ["--filter", "@still/ext-safari", "build"], { cwd: ROOT, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITE_"))) });
  assert.equal(run.status, 0);
  const manifest = JSON.parse(readFileSync(join(ROOT, "packages/ext-safari/dist/safari-mv3/manifest.json"), "utf8"));
  assert.equal(manifest.version, readVersions().apple);
});
