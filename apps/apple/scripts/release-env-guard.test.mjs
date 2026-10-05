import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// U3-W4 P6 / T13: the release-build env guard. It runs the guard in isolation (no Xcode, no pnpm,
// no archive) against fixture env files created in a temp dir. Nothing here reads a real .env: the
// secrets below are made-up fixture strings, and the tests assert they never appear in any output.
//
// The guard decides with the REAL Vite and WXT env loaders (release-env-state.mjs). The
// differential tests below run those loaders independently and assert the guard's verdict agrees.

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPTS, "../../..");
const GUARD = join(SCRIPTS, "release-env-guard.sh");
const ARCHIVE = join(SCRIPTS, "archive.sh");
const MARKER = join(SCRIPTS, "modern-sync-shipped");
const PBXPROJ = join(SCRIPTS, "../Still/Still.xcodeproj/project.pbxproj");
const URL_SECRET = "https://fixture-secret-host.invalid/path-xyzzy";
const KEY_SECRET = "FIXTURE-ANON-KEY-do-not-print-0123456789";
const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const temp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

/** Two package dirs with the given env files (name -> text), and a marker file. */
function fixture({ web = {}, ext = {}, marker = "not-shipped\n", packageJson = true }) {
  const root = temp("still-guard-");
  const dirs = { web: join(root, "app-webview"), ext: join(root, "ext-safari") };
  for (const [dir, files] of [[dirs.web, web], [dirs.ext, ext]]) {
    mkdirSync(dir);
    if (packageJson) writeFileSync(join(dir, "package.json"), "{}\n");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  }
  const markerPath = join(root, "modern-sync-shipped");
  if (marker !== null) writeFileSync(markerPath, marker);
  return { ...dirs, marker: markerPath };
}

function run(f, { script = GUARD, env = {}, trace = false, after = "" } = {}) {
  const r = spawnSync(
    "bash",
    [...(trace ? ["-x"] : []), "-c", `source "$1"; release_env_guard "$2" "$3" "$4"; status=$?; ${after || ":"}; exit $status`, "guard", script, f.web, f.ext, f.marker],
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

// The independent oracle: the real loaders, called directly (no guard code), then the same rules.
const ORACLE = `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
const [repo, web, ext] = process.argv.slice(1);
const req = (pkg) => createRequire(join(repo, "packages", pkg, "package.json"));
const vite = await import(pathToFileURL(req("app-webview").resolve("vite")).href);
const wxtEntry = req("ext-safari").resolve("wxt");
const { loadEnv } = await import(pathToFileURL(join(dirname(wxtEntry), "core/utils/env.mjs")).href);
const state = (e) => ({
  cfg: e.VITE_SUPABASE_URL && e.VITE_SUPABASE_ANON_KEY ? "configured" : !e.VITE_SUPABASE_URL && !e.VITE_SUPABASE_ANON_KEY ? "unconfigured" : "partial",
  modern: e.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" ? "on" : "off",
  atomic: e.VITE_APPLE_ATOMIC_SETTINGS === "true" ? "on" : "off",
});
const w = state(vite.loadEnv("production", web, "VITE_"));
process.chdir(ext);
loadEnv("production", "safari");
const x = state(vite.loadEnv("production", ext, "VITE_"));
console.log(JSON.stringify({ w, x }));
`;
function oracle(f, env = {}) {
  const r = spawnSync("node", ["--input-type=module", "-e", ORACLE, REPO, f.web, f.ext], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const { w, x } = JSON.parse(r.stdout);
  const agree = w.cfg !== "partial" && x.cfg !== "partial" && w.cfg === x.cfg && w.modern === x.modern && w.atomic === x.atomic;
  return { w, x, passes: agree };
}

/** A copy of guard + state helper (symlinked packages for dependency resolution) with mutations. */
function mutatedBundle({ guard, state } = {}) {
  const root = temp("still-guard-mut-");
  const scripts = join(root, "apps/apple/scripts");
  mkdirSync(scripts, { recursive: true });
  symlinkSync(join(REPO, "packages"), join(root, "packages"));
  for (const [name, mutation] of [["release-env-guard.sh", guard], ["release-env-state.mjs", state]]) {
    let text = readFileSync(join(SCRIPTS, name), "utf8");
    const pairs = !mutation ? [] : Array.isArray(mutation[0]) ? mutation : [mutation];
    for (const [from, to] of pairs) {
      assert.ok(text.includes(from), `mutation target missing in ${name}: ${from}`);
      text = text.replace(from, to);
    }
    writeFileSync(join(scripts, name), text);
  }
  return join(scripts, "release-env-guard.sh");
}

describe("release env guard", () => {
  test("agreeing configured builds pass", () => {
    const f = fixture({ web: { ".env": CONFIGURED + MODERN }, ext: { ".env": CONFIGURED + MODERN } });
    const r = run(f);
    assert.equal(r.status, 0, r.output);
    noSecrets(r.output);
  });

  test("agreeing unconfigured builds pass", () => {
    const f = fixture({ web: { ".env": "VITE_SUPABASE_URL=\n" }, ext: {} });
    assert.equal(run(f).status, 0);
  });

  test("a configured mismatch is refused", () => {
    const r = run(fixture({ web: { ".env": CONFIGURED }, ext: {} }));
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
    const r = run(fixture({ web: { ".env": CONFIGURED + MODERN }, ext: { ".env": CONFIGURED } }));
    assert.equal(r.status, 1);
    assert.match(r.output, /VITE_MODERN_SETTINGS_SYNC_ENABLED is on for app-webview but off for ext-safari/);
    noSecrets(r.output);
  });

  test("an Apple atomic-flag mismatch is refused", () => {
    const r = run(fixture({ web: { ".env": "VITE_APPLE_ATOMIC_SETTINGS=true\n" }, ext: {} }));
    assert.equal(r.status, 1);
    assert.match(r.output, /VITE_APPLE_ATOMIC_SETTINGS is on for app-webview but off for ext-safari/);
  });

  test("the process environment applies to both builds alike", () => {
    const r = run(fixture({}), { env: { VITE_SUPABASE_URL: URL_SECRET, VITE_SUPABASE_ANON_KEY: KEY_SECRET } });
    assert.equal(r.status, 0, r.output);
    noSecrets(r.output);
  });

  test("once shipped: refused without the flag, refused when unconfigured, accepted with both", () => {
    const shipped = (web, ext) => fixture({ web: { ".env": web }, ext: { ".env": ext }, marker: "shipped\n" });
    const noFlag = run(shipped(CONFIGURED, CONFIGURED));
    assert.equal(noFlag.status, 1);
    assert.match(noFlag.output, /already shipped/);
    noSecrets(noFlag.output);
    const unconfigured = run(shipped(MODERN, MODERN));
    assert.equal(unconfigured.status, 1);
    assert.match(unconfigured.output, /both builds must be configured/);
    assert.equal(run(shipped(CONFIGURED + MODERN, CONFIGURED + MODERN)).status, 0);
  });

  test("while not shipped, building without the flag is still fine", () => {
    assert.equal(run(fixture({ web: { ".env": CONFIGURED }, ext: { ".env": CONFIGURED } })).status, 0);
  });

  test("an unreadable marker value, a missing marker and a non-file marker are all refused", () => {
    assert.equal(run(fixture({ marker: "maybe\n" })).status, 1);
    const missing = run(fixture({ marker: null }));
    assert.equal(missing.status, 1);
    assert.match(missing.output, /missing or not a regular file/);
    const dirMarker = fixture({});
    rmSync(dirMarker.marker);
    mkdirSync(dirMarker.marker);
    assert.equal(run(dirMarker).status, 1);
  });

  test("both package directories must exist and hold a package.json", () => {
    const noPackage = run(fixture({ packageJson: false }));
    assert.equal(noPackage.status, 1);
    assert.match(noPackage.output, /not a package directory/);
    const f = fixture({});
    const gone = run({ ...f, ext: join(dirname(f.ext), "does-not-exist") });
    assert.equal(gone.status, 1);
    assert.match(gone.output, /not a package directory/);
  });

  test("the committed marker says not-shipped today, so nothing changes yet", () => {
    assert.equal(readFileSync(MARKER, "utf8").trim(), "not-shipped");
  });

  test("run directly (as the Xcode phase does), the exit code is the verdict", () => {
    const run1 = (f) => spawnSync("/bin/bash", [GUARD, f.web, f.ext, f.marker], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(run1(fixture({})).status, 0);
    const refused = run1(fixture({ web: { ".env": CONFIGURED }, ext: {} }));
    assert.equal(refused.status, 1);
    noSecrets(`${refused.stdout}${refused.stderr}`);
  });

  test("archive.sh runs the guard before it builds anything", () => {
    const script = readFileSync(ARCHIVE, "utf8");
    const guard = script.indexOf("release_env_guard ");
    assert.ok(guard > 0, "archive.sh calls release_env_guard");
    assert.ok(script.includes('"$HERE/modern-sync-shipped"'), "it passes the committed marker");
    assert.ok(guard < script.indexOf("pnpm --filter"), "the guard comes before the first build");
    assert.ok(guard < script.indexOf("xcodebuild archive"), "and before the archive");
  });

  test("a raw xcodebuild Release archive runs the guard in both extension-resources phases", () => {
    const phases = readFileSync(PBXPROJ, "utf8")
      .split("\n")
      .filter((line) => line.includes("shellScript") && line.includes("@still/ext-safari build"));
    assert.equal(phases.length, 2, "the iOS and macOS extension-resources phases");
    for (const phase of phases) {
      const guard = phase.indexOf("release-env-guard.sh");
      assert.ok(guard > 0, "the phase runs the guard");
      assert.ok(phase.includes('if [ \\"${CONFIGURATION:-}\\" = \\"Release\\" ]'), "gated on Release");
      assert.ok(phase.includes("modern-sync-shipped"), "with the committed marker");
      assert.ok(guard < phase.indexOf("@still/ext-safari build"), "before the extension build");
      assert.ok(phase.includes("set -euo pipefail"), "a refusal fails the phase");
    }
  });
});

describe("it reads env the way the real loaders do (differential)", () => {
  /** The guard's verdict equals the verdict the real loaders imply; returns the oracle for checks. */
  function agrees(f, env = {}) {
    const expected = oracle(f, env);
    const r = run(f, { env });
    assert.equal(r.status === 0, expected.passes, `guard ${r.status}, loaders ${JSON.stringify(expected)}\n${r.output}`);
    noSecrets(r.output);
    return { expected, r };
  }

  test("a quoted value with a trailing comment", () => {
    agrees(fixture({ web: { ".env": CONFIGURED + 'VITE_MODERN_SETTINGS_SYNC_ENABLED="true" # on\n' }, ext: { ".env": CONFIGURED + MODERN } }));
    agrees(fixture({ web: { ".env": CONFIGURED + "VITE_MODERN_SETTINGS_SYNC_ENABLED=true # on\n" }, ext: { ".env": CONFIGURED + MODERN } }));
  });

  test("spaces around =", () => {
    agrees(fixture({ web: { ".env": CONFIGURED + "VITE_MODERN_SETTINGS_SYNC_ENABLED = true\n" }, ext: { ".env": CONFIGURED + MODERN } }));
    agrees(fixture({ web: { ".env": `VITE_SUPABASE_URL = ${URL_SECRET}\nVITE_SUPABASE_ANON_KEY = ${KEY_SECRET}\n` }, ext: { ".env": CONFIGURED } }));
  });

  test("backticks", () => {
    agrees(fixture({ web: { ".env": CONFIGURED + "VITE_MODERN_SETTINGS_SYNC_ENABLED=`true`\n" }, ext: { ".env": CONFIGURED + MODERN } }));
    agrees(fixture({ web: { ".env": `VITE_SUPABASE_URL=\`${URL_SECRET}\`\nVITE_SUPABASE_ANON_KEY=\`${KEY_SECRET}\`\n` }, ext: { ".env": CONFIGURED } }));
  });

  test(".env.safari overrides for ext-safari only (WXT loads it; the web build never does)", () => {
    const f = fixture({
      web: { ".env": CONFIGURED + MODERN },
      ext: { ".env": CONFIGURED, ".env.safari": MODERN },
    });
    const { expected } = agrees(f);
    assert.equal(expected.x.modern, "on", "WXT picks up .env.safari");
    // And a safari-only file on the web package is not read by Vite, so it never counts.
    const webOnlySafari = fixture({ web: { ".env": CONFIGURED, ".env.safari": MODERN }, ext: { ".env": CONFIGURED + MODERN } });
    assert.equal(agrees(webOnlySafari).expected.w.modern, "off");
    agrees(fixture({ web: { ".env": CONFIGURED + MODERN }, ext: { ".env": CONFIGURED + MODERN, ".env.production.safari.local": "VITE_MODERN_SETTINGS_SYNC_ENABLED=false\n" } }));
  });

  test("an exported empty variable: Vite lets it win, WXT ignores it", () => {
    const f = fixture({ web: { ".env": CONFIGURED }, ext: { ".env": CONFIGURED } });
    const { expected } = agrees(f, { VITE_SUPABASE_URL: "" });
    assert.equal(expected.w.cfg, "partial", "Vite: the empty process variable wins");
    assert.equal(expected.x.cfg, "configured", "WXT: the empty process variable is replaced by the file");
    assert.equal(expected.passes, false);
    agrees(f, { VITE_MODERN_SETTINGS_SYNC_ENABLED: "" });
  });

  test("a non-empty process variable beats the files in both loaders", () => {
    agrees(fixture({ web: { ".env": CONFIGURED + MODERN }, ext: { ".env": CONFIGURED + MODERN } }), { VITE_MODERN_SETTINGS_SYNC_ENABLED: "false" });
    agrees(fixture({ web: { ".env": CONFIGURED }, ext: { ".env": CONFIGURED } }), { VITE_MODERN_SETTINGS_SYNC_ENABLED: "true" });
  });

  test("exact-value rules: only true is on; later files win", () => {
    agrees(fixture({
      web: { ".env": "VITE_MODERN_SETTINGS_SYNC_ENABLED=false\n", ".env.production": MODERN },
      ext: { ".env": MODERN, ".env.production.local": "export VITE_MODERN_SETTINGS_SYNC_ENABLED='1' # off\n" },
    }));
    agrees(fixture({ web: { ".env": CONFIGURED + "VITE_MODERN_SETTINGS_SYNC_ENABLED=TRUE\n" }, ext: { ".env": CONFIGURED } }));
  });
});

describe("xtrace never leaks", () => {
  test("under bash -x the guard prints no fixture value, and tracing resumes afterwards", () => {
    const f = fixture({ web: { ".env": CONFIGURED + MODERN }, ext: { ".env": CONFIGURED + MODERN } });
    const r = run(f, {
      trace: true,
      env: { VITE_SUPABASE_URL: URL_SECRET, VITE_SUPABASE_ANON_KEY: KEY_SECRET },
      after: 'echo "tracing-resumed:$-"',
    });
    assert.equal(r.status, 0, r.output);
    noSecrets(r.output);
    assert.match(r.output, /tracing-resumed:\S*x/, "xtrace is restored after the guard returns");
  });
});

describe("negative controls: each broken guard fails the matching test", () => {
  const mismatch = () => fixture({ web: { ".env": CONFIGURED }, ext: {} });

  test("a guard that always passes lets a configured mismatch through", () => {
    const script = mutatedBundle({ guard: ["  local failed=0 dir\n", "  return 0\n  local failed=0 dir\n"] });
    assert.equal(run(mismatch(), { script }).status, 0);
  });

  test("without the modern-flag comparison, a flag mismatch passes", () => {
    const script = mutatedBundle({ guard: ['if [ "$web_mod" != "$ext_mod" ]; then', "if false; then"] });
    assert.equal(run(fixture({ web: { ".env": MODERN }, ext: {} }), { script }).status, 0);
  });

  test("without the atomic comparison, an atomic mismatch passes", () => {
    const script = mutatedBundle({ guard: ['if [ "$web_atom" != "$ext_atom" ]; then', "if false; then"] });
    assert.equal(run(fixture({ web: { ".env": "VITE_APPLE_ATOMIC_SETTINGS=true\n" }, ext: {} }), { script }).status, 0);
  });

  test("without the one-way guard, a shipped marker no longer explains a missing flag", () => {
    const script = mutatedBundle({ guard: ["    shipped)\n", "    NEVER-MATCHES)\n"] });
    const r = run(fixture({ marker: "shipped\n" }), { script });
    assert.equal(/already shipped/.test(r.output), false);
  });

  test("without the fail-closed marker check, a missing marker passes", () => {
    // Both the explicit check and the unreadable-file fallback removed: a missing marker reads as "not-shipped".
    const script = mutatedBundle({
      guard: [
        ['if [ ! -f "$marker" ]; then', "if false; then"],
        ['shipped="$(tr -d \'[:space:]\' < "$marker" 2>/dev/null)" || shipped="unreadable"', 'shipped="$(tr -d \'[:space:]\' < "$marker" 2>/dev/null)" || shipped="not-shipped"'],
      ],
    });
    assert.equal(run(fixture({ marker: null }), { script }).status, 0);
  });

  test("without the package check, a directory with no package.json passes", () => {
    const script = mutatedBundle({ guard: ['if [ ! -d "$dir" ] || [ ! -f "$dir/package.json" ]; then', "if false; then"] });
    assert.equal(run(fixture({ packageJson: false }), { script }).status, 0);
  });

  test("a reimplemented loader that misses .env.safari would pass what the real loaders refuse", () => {
    // Stand-in for the old bash parser: ignore WXT's loader entirely.
    const script = mutatedBundle({ state: ['wxtLoadEnv("production", "safari");', "/* WXT loader skipped */"] });
    const f = fixture({ web: { ".env": CONFIGURED + MODERN }, ext: { ".env": CONFIGURED, ".env.safari": MODERN } });
    assert.equal(run(f).status, 0, "the real guard sees .env.safari and agrees");
    assert.equal(run(fixture({ web: { ".env": CONFIGURED }, ext: { ".env": CONFIGURED, ".env.safari": MODERN } })).status, 1);
    assert.equal(run(fixture({ web: { ".env": CONFIGURED }, ext: { ".env": CONFIGURED, ".env.safari": MODERN } }), { script }).status, 0);
  });

  test("a guard that leaked a value (state helper stdout) would show it under bash -x only if xtrace stayed on", () => {
    const leak = ['process.stdout.write(`${out.join("\\n")}\\n`);', 'process.stdout.write(`leak=${process.env.VITE_SUPABASE_URL}\\n${out.join("\\n")}\\n`);'];
    const f = fixture({ web: { ".env": CONFIGURED }, ext: { ".env": CONFIGURED } });
    const env = { VITE_SUPABASE_URL: URL_SECRET };
    // The guard that switches xtrace off: nothing leaks even with a leaking helper.
    const guarded = run(f, { script: mutatedBundle({ state: leak }), trace: true, env });
    noSecrets(guarded.output);
    // The same, with xtrace left on: the trace of the parsing loop shows the secret.
    const unguarded = run(f, {
      script: mutatedBundle({ state: leak, guard: ["  { set +x; } 2>/dev/null\n", "  :\n"] }),
      trace: true,
      env,
    });
    assert.equal(unguarded.output.includes("fixture-secret-host"), true, "the control proves the check can fail");
  });
});
