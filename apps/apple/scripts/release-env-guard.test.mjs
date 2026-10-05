import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

// U3-W4 P6 / T13: the release-build env guard in archive.sh. It runs the guard function in
// isolation (no Xcode, no pnpm, no archive) against fixture env files created in a temp dir.
// Nothing here reads a real .env: the secrets below are made-up fixture strings, and the tests
// assert they never appear in the guard's output.

const GUARD = new URL("./release-env-guard.sh", import.meta.url).pathname;
const ARCHIVE = new URL("./archive.sh", import.meta.url).pathname;
const MARKER = new URL("./modern-sync-shipped", import.meta.url).pathname;
const URL_SECRET = "https://fixture-secret-host.invalid/path-xyzzy";
const KEY_SECRET = "FIXTURE-ANON-KEY-do-not-print-0123456789";
const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** Two package dirs with the given .env contents (name -> text), and a marker file. */
function fixture({ web = {}, ext = {}, marker = "not-shipped\n" }) {
  const root = mkdtempSync(join(tmpdir(), "still-guard-"));
  roots.push(root);
  const dirs = { web: join(root, "app-webview"), ext: join(root, "ext-safari") };
  for (const [dir, files] of [[dirs.web, web], [dirs.ext, ext]]) {
    mkdirSync(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  }
  const markerPath = join(root, "modern-sync-shipped");
  writeFileSync(markerPath, marker);
  return { ...dirs, marker: markerPath };
}

function run(f, { script = GUARD, env = {} } = {}) {
  const r = spawnSync(
    "bash",
    ["-c", 'source "$1"; release_env_guard "$2" "$3" "$4"', "guard", script, f.web, f.ext, f.marker],
    { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" },
  );
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const CONFIGURED = `VITE_SUPABASE_URL=${URL_SECRET}\nVITE_SUPABASE_ANON_KEY="${KEY_SECRET}"\n`;
const MODERN = "VITE_MODERN_SETTINGS_SYNC_ENABLED=true\n";
const noSecrets = (output) => {
  for (const secret of [URL_SECRET, KEY_SECRET, "fixture-secret-host", "xyzzy", "FIXTURE-ANON"]) {
    assert.equal(output.includes(secret), false, `output must not contain ${secret}`);
  }
};

/** A copy of the guard with one mutation, for the negative controls. */
function mutated(from, to) {
  const source = readFileSync(GUARD, "utf8");
  assert.ok(source.includes(from), `mutation target missing: ${from}`);
  const root = mkdtempSync(join(tmpdir(), "still-guard-mut-"));
  roots.push(root);
  const path = join(root, "release-env-guard.sh");
  writeFileSync(path, source.replace(from, to));
  return path;
}

describe("release env guard", () => {
  test("agreeing configured builds pass", () => {
    const f = fixture({ web: { ".env": CONFIGURED + MODERN }, ext: { ".env": CONFIGURED + MODERN } });
    const r = run(f);
    assert.equal(r.status, 0, r.output);
    noSecrets(r.output);
  });

  test("agreeing unconfigured builds pass, and the files may differ in form", () => {
    const f = fixture({ web: { ".env": "VITE_SUPABASE_URL=\n" }, ext: {} });
    assert.equal(run(f).status, 0);
  });

  test("a configured mismatch is refused", () => {
    const f = fixture({ web: { ".env": CONFIGURED }, ext: {} });
    const r = run(f);
    assert.equal(r.status, 1);
    assert.match(r.output, /app-webview is configured but ext-safari is unconfigured/);
    noSecrets(r.output);
  });

  test("a half-configured build is refused, even when both are alike", () => {
    const half = { ".env": `VITE_SUPABASE_URL=${URL_SECRET}\n` };
    const r = run(fixture({ web: half, ext: half }));
    assert.equal(r.status, 1);
    assert.match(r.output, /must be set together/);
    noSecrets(r.output);
  });

  test("a modern-flag mismatch is refused", () => {
    const f = fixture({ web: { ".env": CONFIGURED + MODERN }, ext: { ".env": CONFIGURED } });
    const r = run(f);
    assert.equal(r.status, 1);
    assert.match(r.output, /VITE_MODERN_SETTINGS_SYNC_ENABLED is on for app-webview but off for ext-safari/);
    noSecrets(r.output);
  });

  test("only the exact value true turns the flag on; later files win like Vite", () => {
    const f = fixture({
      web: { ".env": "VITE_MODERN_SETTINGS_SYNC_ENABLED=false\n", ".env.production": MODERN },
      ext: { ".env": MODERN, ".env.production.local": "export VITE_MODERN_SETTINGS_SYNC_ENABLED='1' # off\n" },
    });
    const r = run(f);
    assert.equal(r.status, 1);
    assert.match(r.output, /on for app-webview but off for ext-safari/);
  });

  test("the process environment applies to both builds alike", () => {
    const f = fixture({ web: {}, ext: {} });
    const r = run(f, { env: { VITE_SUPABASE_URL: URL_SECRET, VITE_SUPABASE_ANON_KEY: KEY_SECRET } });
    assert.equal(r.status, 0, r.output);
    noSecrets(r.output);
  });

  test("once shipped, an archive without the flag is refused; with it, accepted", () => {
    const without = fixture({ web: { ".env": CONFIGURED }, ext: { ".env": CONFIGURED }, marker: "shipped\n" });
    const refused = run(without);
    assert.equal(refused.status, 1);
    assert.match(refused.output, /already shipped/);
    noSecrets(refused.output);
    const withFlag = fixture({ web: { ".env": CONFIGURED + MODERN }, ext: { ".env": CONFIGURED + MODERN }, marker: "shipped\n" });
    assert.equal(run(withFlag).status, 0);
  });

  test("while not shipped, building without the flag is still fine", () => {
    const f = fixture({ web: { ".env": CONFIGURED }, ext: { ".env": CONFIGURED } });
    assert.equal(run(f).status, 0);
  });

  test("an unreadable marker value is refused rather than guessed", () => {
    const f = fixture({ web: {}, ext: {}, marker: "maybe\n" });
    assert.equal(run(f).status, 1);
  });

  test("the committed marker says not-shipped today, so nothing changes yet", () => {
    assert.equal(readFileSync(MARKER, "utf8").trim(), "not-shipped");
  });

  test("archive.sh runs the guard before it builds anything", () => {
    const script = readFileSync(ARCHIVE, "utf8");
    const guard = script.indexOf("release_env_guard ");
    assert.ok(guard > 0, "archive.sh calls release_env_guard");
    assert.ok(script.includes('"$HERE/modern-sync-shipped"'), "it passes the committed marker");
    assert.ok(guard < script.indexOf("pnpm --filter"), "the guard comes before the first build");
    assert.ok(guard < script.indexOf("xcodebuild archive"), "and before the archive");
  });
});

describe("negative controls: each broken guard fails the matching test", () => {
  const mismatch = () => fixture({ web: { ".env": CONFIGURED }, ext: {} });

  test("a guard that always passes lets a configured mismatch through", () => {
    const script = mutated("  local failed=0\n", "  return 0\n  local failed=0\n");
    assert.equal(run(mismatch(), { script }).status, 0);
  });

  test("without the modern-flag comparison, a flag mismatch passes", () => {
    const script = mutated('if [ "$web_mod" != "$ext_mod" ]; then', "if false; then");
    const f = fixture({ web: { ".env": MODERN }, ext: {} });
    assert.equal(run(f, { script }).status, 0);
  });

  test("without the one-way guard, a shipped marker no longer refuses a missing flag", () => {
    const script = mutated("    shipped)\n", "    NEVER-MATCHES)\n");
    const f = fixture({ web: {}, ext: {}, marker: "shipped\n" });
    const r = run(f, { script });
    assert.notEqual(r.status, 0); // the unknown marker value still refuses, but not as 'already shipped'
    assert.equal(/already shipped/.test(r.output), false);
  });

  test("a guard that echoed a value would put the fixture secret in the output", () => {
    const script = mutated('  if [ -n "$url" ] && [ -n "$key" ]; then echo configured', '  echo "$url $key" >&2\n  if [ -n "$url" ] && [ -n "$key" ]; then echo configured');
    const f = fixture({ web: { ".env": CONFIGURED }, ext: { ".env": CONFIGURED } });
    const r = run(f, { script });
    assert.equal(r.output.includes(KEY_SECRET), true, "the control shows the secret check can fail");
  });
});
