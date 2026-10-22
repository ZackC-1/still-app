import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { countInBundle, plausibleEmail, verdict } from "./review-email-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, "review-email-check.mjs");
const ARCHIVE = join(HERE, "archive.sh");
// Synthetic address on a reserved domain; never a real reviewer value.
const FAKE = "review-check@example.invalid";

/** A throwaway app-webview-shaped package: package.json, an optional .env and an optional built page. */
function fakePackage({ env, page } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "still-review-email-"));
  writeFileSync(join(dir, "package.json"), "{}\n");
  if (env !== undefined) writeFileSync(join(dir, ".env"), env);
  if (page !== undefined) {
    mkdirSync(join(dir, "dist", "assets"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.html"), page);
    // The leftover chunk Vite also writes is not what the web view loads, so it never counts.
    writeFileSync(join(dir, "dist", "assets", "index.js"), `const a = \`${FAKE}\`;`);
  }
  return dir;
}

const run = (mode, dir, env = {}) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITE_")));
  return spawnSync(process.execPath, [CHECK, mode, dir], { encoding: "utf8", env: { ...clean, ...env } });
};

describe("review sign-in email check", () => {
  test("accepts only a single plausible address", () => {
    assert.equal(plausibleEmail(FAKE), true);
    for (const bad of ["", " ", "no-at-sign", "a@b", "two words@example.invalid", `${FAKE},${FAKE}`, undefined, null])
      assert.equal(plausibleEmail(bad), false, String(bad));
  });

  test("counts the address only in the page the web view loads", () => {
    const dir = fakePackage({ page: `<script type="module">new A({email:\`${FAKE}\`})</script>` });
    try {
      assert.equal(countInBundle(join(dir, "dist"), FAKE), 1);
      assert.equal(countInBundle(join(dir, "dist"), "other@example.invalid"), 0);
      assert.equal(countInBundle(join(dir, "dist"), ""), 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("verdicts refuse missing, malformed, absent-from-bundle and duplicated values without echoing them", () => {
    const one = fakePackage({ page: `x${FAKE}x` });
    const two = fakePackage({ page: `x${FAKE}x${FAKE}x` });
    const none = fakePackage({ page: "nothing here" });
    try {
      assert.equal(verdict("env", "", null).ok, false);
      assert.equal(verdict("env", "not an address", null).ok, false);
      assert.equal(verdict("env", FAKE, null).ok, true);
      assert.equal(verdict("bundle", FAKE, join(one, "dist")).ok, true);
      assert.match(verdict("bundle", FAKE, join(two, "dist")).message, /2 times/);
      assert.match(verdict("bundle", FAKE, join(none, "dist")).message, /0 times/);
      assert.match(verdict("bundle", FAKE, join(none, "missing-dist")).message, /build it first/);
      for (const [mode, value, dist] of [["env", FAKE, null], ["bundle", FAKE, join(two, "dist")], ["env", "bad value", null]])
        assert.ok(!verdict(mode, value, dist).message.includes(value), "the value is never printed");
    } finally { [one, two, none].forEach((d) => rmSync(d, { recursive: true, force: true })); }
  });

  test("the CLI reads the exported value first, then the package .env, and prints no value", () => {
    const fromFile = fakePackage({ env: `VITE_REVIEW_SIGNIN_EMAIL=${FAKE}\n`, page: `x${FAKE}x` });
    const empty = fakePackage({ env: "VITE_REVIEW_SIGNIN_EMAIL=\n", page: `x${FAKE}x` });
    try {
      for (const mode of ["env", "bundle"]) {
        const ok = run(mode, fromFile);
        assert.equal(ok.status, 0, ok.stderr);
        assert.ok(!`${ok.stdout}${ok.stderr}`.includes(FAKE));
      }
      const missing = run("env", empty);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /missing or empty/);
      const exported = run("bundle", empty, { VITE_REVIEW_SIGNIN_EMAIL: FAKE });
      assert.equal(exported.status, 0, exported.stderr);
      // An exported value that differs from what was built is caught by the count.
      const stale = run("bundle", fromFile, { VITE_REVIEW_SIGNIN_EMAIL: "other@example.invalid" });
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /0 times/);
      assert.ok(!stale.stderr.includes("other@example.invalid"));
      assert.equal(run("nonsense", fromFile).status, 2);
    } finally { [fromFile, empty].forEach((d) => rmSync(d, { recursive: true, force: true })); }
  });

  test("archive.sh checks the address before building and the built page after the web build", () => {
    const script = readFileSync(ARCHIVE, "utf8");
    const envCheck = script.indexOf('review-email-check.mjs" env');
    const webBuild = script.indexOf("pnpm --filter @still/app-webview build");
    const bundleCheck = script.indexOf('review-email-check.mjs" bundle');
    assert.ok(envCheck > 0 && bundleCheck > 0, "both checks run");
    assert.ok(envCheck < webBuild, "the env check runs before anything is built");
    assert.ok(webBuild < bundleCheck, "the bundle check runs after the web build");
    assert.ok(bundleCheck < script.indexOf("xcodebuild archive"), "and before the archive");
    assert.ok(script.includes("set -euo pipefail"), "a refusal stops the script");
  });
});
