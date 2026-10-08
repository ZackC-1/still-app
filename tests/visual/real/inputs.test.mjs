import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildLineage, coverageLedger, designInputs } from "./inputs.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as inputs from "./inputs.mjs";
const require = createRequire(import.meta.url);
const playwright = createRequire(require.resolve("@playwright/test/package.json")).resolve("playwright/package.json");
const core = createRequire(playwright).resolve("playwright-core/package.json");
const pngBundle = join(dirname(core), "lib/utilsBundle.js");
const { PNG } = require(pngBundle);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = (width, height, color = 255) => { const image = new PNG({ width, height }); image.data.fill(color); return PNG.sync.write(image); };
import { inventoryProblems } from "./validate-frames.mjs";

test("installed Chromium and WebKit CLI reject absent and stale inputs before build/browser work", (t) => {
  const root = mkdtempSync(join(tmpdir(), "still-installed-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "handoff/reference"), { recursive: true });
  writeFileSync(join(root, "handoff/compare.script"), "");
  for (const runner of ["run.mjs", "webkit/run.mjs"]) {
    for (const version of ["missing", "malformed", undefined, "3.1", "3.2", "3.0.1"]) {
      writeFileSync(join(root, "handoff/reference/render-inventory.json"), version === "malformed" ? "{" : JSON.stringify({ design_version: version, device_scale_factor: 2, inventory: [] }));
      const run = spawnSync(process.execPath, [new URL(runner, import.meta.url).pathname], {
        env: { ...process.env, STILL_DESIGN_PACKAGE: version === "missing" ? join(root, "absent") : root,
          STILL_VISUAL_REFERENCE_DIR: version === "missing" ? join(root, "absent/reference") : join(root, "handoff/reference"),
          STILL_CHROMIUM_EXTENSION: join(root, "absent-build") }, encoding: "utf8",
      });
      assert.equal(run.status, 1, `${runner} ${version}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /FAIL:.*No frames compared\./s);
      assert.doesNotMatch(run.stderr, /built extension|browser|pngjs/);
    }
  }
});

test("coverage accounts for measured, blocked, unselected, unmapped and store frames independently", () => {
  const frames = ["a", "b", "c", "d", "d41-d43-d45-store-assets-and-icons/icon"].map((file) => ({ file, caption: file }));
  const cases = [{ id: "a", reference: "a" }, { id: "b", reference: "b" }, { id: "c", reference: "c" }];
  assert.deepEqual(coverageLedger(frames, cases, [{ id: "a", status: "PASS" }, { id: "b", status: "BLOCKED", reason: "requires account" }]).map((f) => f.status),
    ["PASS", "BLOCKED", "NOT_RUN", "UNMAPPED", "ASSET_REVIEW_REQUIRED"]);
});

test("coverage map rejects stale and missing latest references", () => {
  assert.deepEqual(inventoryProblems({ designVersion: "3.0.1", frames: [{ file: "a" }] }, [{ file: "a" }]), []);
  assert.deepEqual(inventoryProblems({ designVersion: "3.2", frames: [{ file: "old" }] }, [{ file: "new" }]),
    ["frame map must identify latest design version 3.0.1", "reference not mapped: new", "stale map reference: old"]);
});

test("latest references cannot authorize an older or inconsistent selected source package", (t) => {
  const root = mkdtempSync(join(tmpdir(), "still-installed-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "handoff/reference"), { recursive: true });
  mkdirSync(join(root, "tokens"));
  writeFileSync(join(root, "handoff/compare.script"), "");
  writeFileSync(join(root, "handoff/reference/render-inventory.json"), JSON.stringify({ design_version: "3.0.1", device_scale_factor: 2, inventory: [] }));
  for (const [tokens, spacing] of [["3.0.0", "3.0.0"], ["3.0.1", "3.0.0"]]) {
    writeFileSync(join(root, "tokens/tokens.json"), JSON.stringify({ version: tokens }));
    writeFileSync(join(root, "tokens/spacing.css"), `:root { --ds-version: "${spacing}"; }`);
    for (const runner of ["run.mjs", "webkit/run.mjs"]) {
      const run = spawnSync(process.execPath, [new URL(runner, import.meta.url).pathname], {
        env: { ...process.env, STILL_DESIGN_PACKAGE: root, STILL_VISUAL_REFERENCE_DIR: join(root, "handoff/reference") }, encoding: "utf8",
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /selected source tokens and spacing must identify latest design version 3\.0\.1/);
    }
  }
});

test("a blocked installed frame produces a non-passing CLI result and complete coverage", (t) => {
  const root = mkdtempSync(join(tmpdir(), "still-installed-blocked-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const references = join(root, "handoff/reference");
  const map = JSON.parse(readFileSync(new URL("frames.json", import.meta.url), "utf8"));
  const pages = new Map();
  for (const f of map.frames) {
    const [name, output] = f.file.split("/");
    mkdirSync(join(references, name), { recursive: true });
    const box = { x: 0, y: 0, width: 1, height: 1 };
    writeFileSync(join(references, name, output), png(Math.ceil(box.width) * 2, Math.ceil(box.height) * 2));
    if (!pages.has(name)) pages.set(name, { name, frames: [] });
    pages.get(name).frames.push({ output, bounding_box: box, render: { theme: f.theme } });
  }
  writeFileSync(join(references, "render-inventory.json"), JSON.stringify({ design_version: "3.0.1", device_scale_factor: 2, inventory: [...pages.values()] }));
  writeFileSync(join(root, "handoff/package.json"), "{}");
  writeFileSync(join(root, "handoff/compare.script"), "");
  mkdirSync(join(root, "tokens"));
  writeFileSync(join(root, "tokens/tokens.json"), JSON.stringify({ version: "3.0.1" }));
  writeFileSync(join(root, "tokens/spacing.css"), ':root { --ds-version: "3.0.1"; }');
  for (const dep of ["pngjs", "pixelmatch"]) {
    const dir = join(root, "handoff/node_modules", dep);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "index.js" }));
    writeFileSync(join(dir, "index.js"), dep === "pngjs" ? `module.exports = require(${JSON.stringify(pngBundle)})` : "throw new Error('blocked frames must never compare')");
  }
  mkdirSync(join(root, "build"));
  writeFileSync(join(root, "build/manifest.json"), "{}");
  const out = join(root, "output");
  const run = spawnSync(process.execPath, [new URL("run.mjs", import.meta.url).pathname, "--only", "d01-10"], {
    env: { ...process.env, STILL_DESIGN_PACKAGE: root, STILL_VISUAL_REFERENCE_DIR: references,
      STILL_CHROMIUM_EXTENSION: join(root, "build"), STILL_VISUAL_REAL_OUTPUT: out }, encoding: "utf8",
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  assert.deepEqual(report.counts, { compared: 0, pass: 0, fail: 0, blocked: 1 });
  assert.equal(report.coverage.length, 144);
  assert.equal(report.results[0].status, "BLOCKED");
});

test("a stale QA manifest cannot label different artifact bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "still-installed-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "artifact");
  mkdirSync(dir);
  writeFileSync(join(dir, "page.js"), "verified bytes");
  writeFileSync(join(root, "artifact-manifest.json"), JSON.stringify({ profile: "v3-local", sourceSha256: "source receipt",
    artifacts: { files: [{ path: "page.js", sha256: createHash("sha256").update("verified bytes").digest("hex") }] } }));
  assert.equal(buildLineage(root, dir).qaProfile.profile, "v3-local");
  mkdirSync(join(dir, "_metadata/generated_indexed_rulesets"), { recursive: true });
  writeFileSync(join(dir, "_metadata/generated_indexed_rulesets/_ruleset1"), "compiled browser rules");
  assert.equal(buildLineage(root, dir).generatedBrowserFiles.length, 1);
  writeFileSync(join(dir, "page.js"), "different bytes");
  assert.throws(() => buildLineage(root, dir), /does not describe the actual measured build/);
});

function referenceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "still-reference-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "handoff/reference/example"), { recursive: true });
  mkdirSync(join(root, "tokens"));
  writeFileSync(join(root, "tokens/tokens.json"), '{"version":"3.0.1"}');
  writeFileSync(join(root, "tokens/spacing.css"), ':root { --ds-version: "3.0.1"; }');
  writeFileSync(join(root, "handoff/package.json"), "{}");
  writeFileSync(join(root, "handoff/compare.script"), "");
  for (const dep of ["pngjs", "pixelmatch"]) {
    mkdirSync(join(root, "handoff/node_modules", dep), { recursive: true });
    writeFileSync(join(root, "handoff/node_modules", dep, "index.js"), `module.exports = require(${JSON.stringify(pngBundle)})`);
  }
  writeFileSync(join(root, "handoff/reference/render-inventory.json"), JSON.stringify({ design_version: "3.0.1", device_scale_factor: 2,
    inventory: [{ name: "Example", frames: [{ output: "frame.png", bounding_box: { x: 0.25, y: 0.375, width: 3.5, height: 4.125 }, render: { theme: "light" } }] }] }));
  const file = join(root, "handoff/reference/example/frame.png");
  writeFileSync(file, png(8, 10));
  return { root, file, env: { STILL_DESIGN_PACKAGE: root } };
}

test("installed source CSS must contain exactly one well-formed version declaration", async (t) => {
  const invalid = [
    ["duplicate stale", ':root { --ds-version: "3.0.1"; --ds-version: "3.0.0"; }'],
    ["duplicate latest", ':root { --ds-version: "3.0.1"; --ds-version: "3.0.1"; }'],
    ["malformed duplicate", ':root { --ds-version: "3.0.1"; --ds-version: bogus; }'],
    ["mismatched double quote", ':root { --ds-version: "3.0.1\'; }'],
    ["mismatched single quote", ':root { --ds-version: \'3.0.1"; }'],
    ["unquoted", ':root { --ds-version: 3.0.1; }'],
    ["missing semicolon", ':root { --ds-version: "3.0.1" }'],
    ["comment only", '/* :root { --ds-version: "3.0.1"; } */'],
  ];
  for (const [name, css] of invalid) {
    await t.test(name, (child) => {
      const f = referenceFixture(child);
      writeFileSync(join(f.root, "tokens/spacing.css"), css);
      const error = /selected source tokens and spacing must identify latest design version 3\.0\.1/;
      assert.throws(() => designInputs(f.root, f.env), error);
      for (const runner of ["run.mjs", "webkit/run.mjs"]) {
        const run = spawnSync(process.execPath, [new URL(runner, import.meta.url).pathname], {
          env: { ...process.env, ...f.env, STILL_VISUAL_REFERENCE_DIR: join(f.root, "handoff/reference"),
            STILL_CHROMIUM_EXTENSION: join(f.root, "absent-build") }, encoding: "utf8",
        });
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.match(run.stderr, error);
        assert.match(run.stderr, /No frames compared\./);
        assert.doesNotMatch(run.stderr, /built extension|browser|pngjs/);
      }
    });
  }
});

test("installed source CSS accepts matching quotes and ignores commented declarations", (t) => {
  const f = referenceFixture(t);
  for (const css of [
    ':root { --ds-version: "3.0.1"; }',
    ":root { --ds-version: '3.0.1'; }",
    '/* --ds-version: "3.0.0"; */ :root { --ds-version: "3.0.1"; }',
  ]) {
    writeFileSync(join(f.root, "tokens/spacing.css"), css);
    assert.equal(designInputs(f.root, f.env).lineage.sourcePackageVersion, "3.0.1");
  }
});

test("preflight decodes real PNGs and rejects 1x and truncated references", (t) => {
  const f = referenceFixture(t);
  assert.doesNotThrow(() => designInputs(f.root, f.env));
  writeFileSync(f.file, png(4, 5));
  assert.throws(() => designInputs(f.root, f.env), /reference PNG.*dimensions/);
  writeFileSync(f.file, png(8, 10).subarray(0, 25));
  assert.throws(() => designInputs(f.root, f.env), /invalid reference PNG/);
});

test("reference pixel changes alter lineage and invalidate an in-progress capture", (t) => {
  const f = referenceFixture(t);
  const before = designInputs(f.root, f.env);
  writeFileSync(f.file, png(8, 10, 127));
  const after = designInputs(f.root, f.env);
  assert.notDeepEqual(before.lineage.referencePngs, after.lineage.referencePngs);
  assert.equal(before.lineage.inventorySha256, after.lineage.inventorySha256);
  assert.throws(() => inputs.assertReferencesStable(before), /reference inputs changed/);
});

function artifactFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "still-build-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "artifact");
  mkdirSync(dir);
  writeFileSync(join(dir, "a.js"), "A");
  writeFileSync(join(dir, "b.js"), "B");
  const receipt = { revision: "a".repeat(40), dirty: true, profile: "v3-local", sourceSha256: sha("source A"),
    artifacts: { files: [{ path: "a.js", sha256: sha("A") }, { path: "b.js", sha256: sha("B") }] } };
  const save = () => writeFileSync(join(root, "artifact-manifest.json"), JSON.stringify(receipt));
  save();
  return { root, dir, receipt, save };
}

test("QA manifest must bijectively cover shipped paths: duplicates cannot hide an omitted file", (t) => {
  const f = artifactFixture(t);
  f.receipt.artifacts.files[1] = f.receipt.artifacts.files[0];
  f.save();
  assert.throws(() => buildLineage(f.root, f.dir), /does not describe the actual measured build/);
});

test("receipt build revision A stays distinct from capture checkout B; unreceipted source is unknown", (t) => {
  const f = artifactFixture(t);
  const checkout = new URL("../../../", import.meta.url).pathname;
  const build = buildLineage(checkout, f.dir);
  assert.equal(build.sourceCommit, f.receipt.revision);
  assert.equal(build.sourceDirty, true);
  assert.notEqual(build.captureCheckout.sourceCommit, build.sourceCommit);
  rmSync(join(f.root, "artifact-manifest.json"));
  assert.equal(buildLineage(checkout, f.dir).sourceCommit, null);
});

test("replaced shipped artifact and matching new receipt cannot inherit previous captures", (t) => {
  const f = artifactFixture(t);
  const before = buildLineage(f.root, f.dir);
  writeFileSync(join(f.dir, "a.js"), "replacement");
  f.receipt.artifacts.files[0].sha256 = sha("replacement");
  f.receipt.revision = "b".repeat(40);
  f.save();
  assert.throws(() => inputs.assertBuildStable(f.root, before), /shipped artifact changed/);
});
