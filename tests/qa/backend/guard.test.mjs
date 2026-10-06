import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalOnlyRefusal, assertAllowedCli, assertLocalEnv, assertLocalOnly, assertLocalUrl, assertNotLinked, isLocalUrl,
} from "./guard.mjs";
import { DEFAULT_MIRROR, EXCLUDE, OWNER_FILE, projectIdFor, assertMirrorPath, buildMirror, claimMirror, cliEnv, writeOwnerToken, parseStatus, qaConfig, runCli, start, status, stop, trackedFiles } from "./local-stack.mjs";

const refused = fn => assert.throws(fn, LocalOnlyRefusal);

function fakeRepo({ linked = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qa-guard-"));
  for (const dir of ["supabase/migrations", "supabase/functions", "packages/core/src", "packages/shared-types/src", "packages/shared-types/fixtures"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "supabase/config.toml"), 'project_id = "still-app"\n[auth.email]\notp_length = 6\n');
  writeFileSync(join(root, "supabase/migrations/0001_x.sql"), "select 1;\n");
  writeFileSync(join(root, "supabase/functions/handler.ts"), "export {};\n");
  const git = (...args) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0, `git ${args.join(" ")}`);
  git("init", "-q");
  git("add", "-A");
  if (linked) {
    mkdirSync(join(root, "supabase/.temp"), { recursive: true });
    writeFileSync(join(root, linked), "abcdefghijklmnopqrst\n");
  }
  return root;
}

/** A test mirror path inside the allowed prefix. */
const testMirror = label => `/private/tmp/still-qa-test-${label}-${process.pid}-${Date.now()}`;

/** A mirror as start() leaves it: QA config plus an owner token. */
function fakeMirror({ projectId, token = "owner-token-1" } = {}) {
  const mirror = testMirror("m");
  projectId ??= projectIdFor(mirror);
  mkdirSync(join(mirror, "supabase"), { recursive: true });
  writeFileSync(join(mirror, "supabase/config.toml"), `project_id = "${projectId}"\n`);
  if (token) writeFileSync(join(mirror, OWNER_FILE), token);
  return mirror;
}

/** A fake spawn that records every call; docker answers from `docker`, supabase from `supabase`. */
function recorder({ docker = () => "", supabase = () => "" } = {}) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, env: options?.env });
    if (cmd === "docker") return { status: 0, stdout: docker(args) };
    if (cmd === "supabase") return { status: 0, stdout: supabase(args) };
    return assert.fail(`spawned ${cmd}`);
  };
  return { spawn, calls };
}

test("a linked checkout is refused, whichever link marker is present", () => {
  for (const marker of ["supabase/.temp/project-ref", "supabase/.temp/pooler-url", "supabase/.temp/linked-project.json"]) {
    const root = fakeRepo({ linked: marker });
    try {
      refused(() => assertNotLinked(root));
      refused(() => assertLocalOnly({ root, env: {} }));
      refused(() => buildMirror({ root, mirror: testMirror("linked") }));
      refused(() => start({ root, mirror: testMirror("never"), env: {}, spawn: () => assert.fail("spawned"), free: () => 99e9 }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("an unlinked checkout passes", () => {
  const root = fakeRepo();
  try { assertNotLinked(root); assertLocalOnly({ root, env: {} }); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("any SUPABASE_* variable is refused, including the access token", () => {
  for (const name of ["SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_PROJECT_ID", "supabase_url", "SUPABASE_AUTH_EXTERNAL_APPLE_SECRET"]) {
    refused(() => assertLocalEnv({ [name]: "x" }));
  }
});

test("hosted Supabase addresses in any variable are refused", () => {
  for (const value of ["https://abcdefgh.supabase.co", "postgres://u:p@aws-0-us-west-2.pooler.supabase.com:5432/postgres", "db.abcd.supabase.co"]) {
    refused(() => assertLocalEnv({ VITE_SUPABASE_URL_X: value }));
    refused(() => assertLocalEnv({ SOMETHING: value }));
  }
});

test("database and API URL variables must be local", () => {
  refused(() => assertLocalEnv({ DATABASE_URL: "postgres://user@db.example.com:5432/x" }));
  refused(() => assertLocalEnv({ PGHOST: "db.example.com" }));
  refused(() => assertLocalEnv({ VITE_SUPABASE_URL: "https://example.com" }));
  assertLocalEnv({ DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", PGHOST: "localhost", VITE_SUPABASE_URL: "http://127.0.0.1:54321" });
});

test("this shell's environment passes or is refused for a stated reason", () => {
  try { assertLocalEnv(process.env); } catch (error) { assert.ok(error instanceof LocalOnlyRefusal); }
});

test("only localhost URLs are local", () => {
  for (const ok of ["http://127.0.0.1:54321", "http://localhost:54324/", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"]) assert.ok(isLocalUrl(ok), ok);
  for (const bad of ["https://abc.supabase.co", "http://127.0.0.1.evil.test", "http://user:pw@127.0.0.1:1", "postgresql://postgres:postgres@db.example.com:5432/postgres", "file:///etc/hosts", "not a url", "http://10.0.0.1"]) {
    assert.equal(isLocalUrl(bad), false, bad);
    refused(() => assertLocalUrl(bad));
  }
});

test("the CLI may run only start, status -o json and stop --no-backup on the mirror", () => {
  const w = "/private/tmp/still-qa-backend";
  assertAllowedCli(["start", "--workdir", w, "--exclude", EXCLUDE], w, EXCLUDE);
  assertAllowedCli(["status", "--workdir", w, "-o", "json"], w, EXCLUDE);
  assertAllowedCli(["stop", "--workdir", w, "--no-backup"], w, EXCLUDE);
  for (const args of [
    ["link", "--project-ref", "abc"], ["db", "push"], ["db", "push", "--dry-run"], ["functions", "deploy"],
    ["secrets", "set", "A=b"], ["login"], ["stop", "--workdir", w], ["stop", "--all"], ["start", "--workdir", "/elsewhere", "--exclude", EXCLUDE],
    ["status", "--workdir", w, "-o", "json", "--linked"], ["start", "--workdir", w, "--exclude", EXCLUDE, "--db-url=postgres://x"],
    ["migration", "list"], ["start"],
  ]) {
    refused(() => assertAllowedCli(args, w, EXCLUDE));
    refused(() => runCli(args, { mirror: w, spawn: () => assert.fail("spawned a refused command") }));
  }
});

test("the mirror config gets the mirror's project id and the QA-only code template", () => {
  const out = qaConfig('project_id = "still-app"\n[api]\nport = 54321\n', "still-qa-backend");
  assert.match(out, /^project_id = "still-qa-backend"$/m);
  assert.doesNotMatch(out, /still-app/);
  assert.match(out, /\[auth\.email\.template\.magic_link\][\s\S]*qa-code\.html/);
  refused(() => qaConfig('[api]\nport = 1\n', "still-qa-backend"));
  refused(() => qaConfig('project_id = "a"\nproject_id = "b"\n', "still-qa-backend"));
  refused(() => qaConfig('project_id = "a"\n', "still-app"));
});

const tables = text => text.split("\n").filter(line => /^\s*\[/.test(line)).map(line => line.trim());

test("the actual repository config becomes a QA config with one code template and no SMTP", () => {
  const real = readFileSync(new URL("../../../supabase/config.toml", import.meta.url), "utf8");
  const out = qaConfig(real, "still-qa-backend");
  assert.equal(tables(out).filter(t => t === "[auth.email.template.magic_link]").length, 1);
  assert.equal(tables(out).filter(t => t === "[auth.email.template.confirmation]").length, 1);
  assert.equal(tables(out).some(t => /smtp/.test(t)), false);
  assert.match(out, /^project_id = "still-qa-backend"$/m);
  // Every other table of the real config survives unchanged in order.
  assert.deepEqual(tables(out).filter(t => !/template\.(magic_link|confirmation)/.test(t)), tables(real).filter(t => !/^\[auth\.email\.(smtp|template\.(magic_link|confirmation))\]$/.test(t)));
});

test("a config that already sets a sign-in template or SMTP is rewritten: ours replaces it, SMTP is removed", () => {
  const shape = [
    'project_id = "still-app"', "[auth.email]", "enable_signup = true", "otp_length = 6",
    "[auth.email.smtp]", "enabled = true", 'host = "smtp.sendgrid.net"', "port = 587", 'pass = "env(SENDGRID_API_KEY)"',
    "[auth.email.template.magic_link]", 'subject = "Your link"', 'content_path = "./supabase/templates/magic.html"',
    "[auth.email.template.invite]", 'subject = "Invite"', "[auth.sms]", "enable_signup = false",
  ].join("\n");
  const out = qaConfig(shape, "still-qa-backend");
  assert.doesNotMatch(out, /sendgrid|SENDGRID|magic\.html|\[auth\.email\.smtp\]/);
  assert.deepEqual(tables(out), ["[auth.email]", "[auth.email.template.invite]", "[auth.sms]", "[auth.email.template.magic_link]", "[auth.email.template.confirmation]"]);
  assert.match(out, /\[auth\.sms\]\nenable_signup = false/);
  for (const unsafe of [
    'project_id = "a"\n[auth.email]\nsmtp.host = "x"\n',
    'project_id = "a"\n[auth.email]\nsmtp = { host = "x" }\n',
    'project_id = "a"\n[auth.email.smtp.extra]\nx = 1\n',
    'project_id = "a"\n[auth.email]\ntemplate.magic_link.subject = "x"\n',
  ]) refused(() => qaConfig(unsafe, "still-qa-backend"));
});

test("the repository's own config never carries the QA template", () => {
  const repoConfig = readFileSync(new URL("../../../supabase/config.toml", import.meta.url), "utf8");
  assert.doesNotMatch(repoConfig, /qa-code\.html|QA mirror only/);
});

test("buildMirror copies outside the checkout and leaves no link marker or secret file", () => {
  const root = fakeRepo();
  mkdirSync(join(root, "supabase/functions/.temp"), { recursive: true });
  writeFileSync(join(root, "supabase/functions/.env"), "SECRET=1\n");
  writeFileSync(join(root, "supabase/functions/untracked.ts"), "export const local = 1;\n");
  const mirror = testMirror("build");
  try {
    refused(() => buildMirror({ root, mirror: join(root, "inside") }));
    const token = buildMirror({ root, mirror });
    assert.match(token, /^[0-9a-f-]{36}$/);
    assert.equal(readFileSync(join(mirror, OWNER_FILE), "utf8"), token);
    assert.ok(existsSync(join(mirror, "supabase/functions/handler.ts")), "tracked files are copied");
    assert.equal(existsSync(join(mirror, "supabase/functions/untracked.ts")), false, "untracked files are not");
    assert.ok(existsSync(join(mirror, "supabase/migrations/0001_x.sql")));
    assert.ok(existsSync(join(mirror, "supabase/templates/qa-code.html")));
    assert.equal(existsSync(join(mirror, "supabase/functions/.env")), false);
    assert.equal(existsSync(join(mirror, "supabase/functions/.temp")), false);
    assert.match(readFileSync(join(mirror, "supabase/config.toml"), "utf8"), new RegExp(`project_id = "${projectIdFor(mirror)}"`));
    assert.match(readFileSync(join(root, "supabase/config.toml"), "utf8"), /project_id = "still-app"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("start refuses while another Supabase stack runs, or under 10 GB free, before touching anything", () => {
  const root = fakeRepo();
  const mirror = testMirror("start");
  const spawned = [];
  const docker = names => (cmd, args) => {
    spawned.push([cmd, ...args]);
    if (cmd !== "docker") assert.fail(`ran ${cmd}`);
    return { status: 0, stdout: names.join("\n") };
  };
  try {
    refused(() => start({ root, mirror, env: {}, spawn: docker(["supabase_db_still-app\tpublic.ecr.aws/supabase/postgres:17", "other\tnginx"]), free: () => 99e9 }));
    refused(() => start({ root, mirror, env: {}, spawn: docker(["u5w2-erasure-pg\tpublic.ecr.aws/supabase/postgres:17.6.1.167"]), free: () => 99e9 }));
    refused(() => start({ root, mirror, env: {}, spawn: docker([]), free: () => 9.9 * 1024 ** 3 }));
    assert.equal(existsSync(mirror), false);
    assert.ok(spawned.every(([cmd]) => cmd === "docker"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parseStatus requires every value and refuses non-local URLs", () => {
  const ok = { API_URL: "http://127.0.0.1:54321", DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", MAILPIT_URL: "http://127.0.0.1:54324", ANON_KEY: "a", SERVICE_ROLE_KEY: "s" };
  assert.equal(parseStatus(JSON.stringify(ok)).mailpitUrl, "http://127.0.0.1:54324");
  assert.equal(parseStatus(JSON.stringify({ ...ok, MAILPIT_URL: undefined, INBUCKET_URL: "http://127.0.0.1:54324" })).mailpitUrl, "http://127.0.0.1:54324");
  refused(() => parseStatus(JSON.stringify({ ...ok, API_URL: "https://abc.supabase.co" })));
  assert.throws(() => parseStatus(JSON.stringify({ ...ok, SERVICE_ROLE_KEY: "" })));
});

test("stop needs the owner token, runs --no-backup and fails when QA containers or volumes remain", () => {
  const root = fakeRepo();
  const mirror = fakeMirror();
  const leftover = names => recorder({ docker: args => args[0] === "volume" ? names.join("\n") : "" });
  try {
    for (const token of [undefined, "", "someone-else"]) {
      const r = leftover([]);
      refused(() => stop({ root, mirror, env: {}, spawn: r.spawn, token }));
      assert.deepEqual(r.calls, [], "nothing is spawned without the owner token");
    }
    const incomplete = leftover([`supabase_db_${projectIdFor(mirror)}`]);
    assert.throws(() => stop({ root, mirror, env: {}, spawn: incomplete.spawn, token: "owner-token-1" }), /teardown incomplete/);
    assert.deepEqual([incomplete.calls[0].cmd, ...incomplete.calls[0].args], ["supabase", "stop", "--workdir", mirror, "--no-backup"]);
    assert.ok(existsSync(mirror), "the mirror is kept when teardown is incomplete");
    // Another mirror's or lane's project is not this mirror's leftover.
    stop({ root, mirror, env: {}, spawn: leftover(["supabase_db_still-app", "supabase_db_still-qa-other", `supabase_db_${projectIdFor(mirror)}x`]).spawn, token: "owner-token-1" });
    assert.equal(existsSync(mirror), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("status, stop and runCli refuse a mirror whose config is not the QA project, before spawning", () => {
  const root = fakeRepo();
  const cases = [fakeMirror({ projectId: "still-app" }), fakeMirror({ projectId: "still-qa-backend" }),
    fakeMirror({ projectId: "still-qa\"\nproject_id = \"still-app" })];
  try {
    for (const mirror of cases) {
      const r = recorder();
      refused(() => status({ root, mirror, env: {}, spawn: r.spawn }));
      refused(() => stop({ root, mirror, env: {}, spawn: r.spawn, token: "owner-token-1" }));
      refused(() => runCli(["status", "--workdir", mirror, "-o", "json"], { mirror, env: {}, spawn: r.spawn }));
      assert.deepEqual(r.calls, []);
      assert.ok(existsSync(mirror), "a refused stop deletes nothing");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const mirror of cases) rmSync(mirror, { recursive: true, force: true });
  }
});

test("mirrors may only be the default or /private/tmp/still-qa-<name>, never the checkout or above it", () => {
  const root = "/private/tmp/still-qa-repo/checkout";
  assertMirrorPath(DEFAULT_MIRROR, root);
  assertMirrorPath("/private/tmp/still-qa-test-1", root);
  for (const bad of ["/", "/private/tmp", "/private/tmp/still-qa-", "/private/tmp/still-qa-a/b", "/tmp/still-qa-x", "/Users/zack", "/private/tmp/other",
    "/private/tmp/still-qa-repo", root]) {
    refused(() => assertMirrorPath(bad, root));
  }
  const r = recorder();
  refused(() => stop({ root: "/private/tmp/still-qa-repo/checkout", mirror: "/private/tmp", env: {}, spawn: r.spawn, token: "t" }));
  assert.deepEqual(r.calls, []);
});

test("runCli refuses a SUPABASE_* environment before spawning, and its scrub removes them anyway", () => {
  const mirror = fakeMirror();
  try {
    const r = recorder({ supabase: () => "{}" });
    refused(() => runCli(["status", "--workdir", mirror, "-o", "json"], { mirror, spawn: r.spawn,
      env: { SUPABASE_ACCESS_TOKEN: "sbp_x", PATH: "/usr/bin" } }));
    assert.deepEqual(r.calls, []);
    assert.deepEqual(Object.keys(cliEnv({ SUPABASE_ACCESS_TOKEN: "sbp_x", supabase_db_password: "p", PATH: "/usr/bin", HOME: "/Users/x" })).sort(), ["HOME", "PATH"]);
    runCli(["status", "--workdir", mirror, "-o", "json"], { mirror, spawn: r.spawn, env: { PATH: "/usr/bin", HOME: "/Users/x" } });
    assert.deepEqual(Object.keys(r.calls[0].env).sort(), ["HOME", "PATH"]);
  } finally { rmSync(mirror, { recursive: true, force: true }); }
});

test("runCli refuses a mirror outside the allowed paths and a non-local environment before spawning", () => {
  const r = recorder();
  const outside = mkdtempSync(join(tmpdir(), "qa-outside-"));
  mkdirSync(join(outside, "supabase"), { recursive: true });
  writeFileSync(join(outside, "supabase/config.toml"), 'project_id = "still-qa"\n');
  const mirror = fakeMirror();
  try {
    refused(() => runCli(["status", "--workdir", outside, "-o", "json"], { mirror: outside, env: {}, spawn: r.spawn }));
    refused(() => runCli(["status", "--workdir", mirror, "-o", "json"], { mirror, env: { DATABASE_URL: "postgres://db.example.com/x" }, spawn: r.spawn }));
    refused(() => runCli(["status", "--workdir", mirror, "-o", "json"], { mirror, env: { DOCKER_HOST: "tcp://docker.example.com:2376" }, spawn: r.spawn }));
    assert.deepEqual(r.calls, []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("git ls-files runs without any GIT_* variable", () => {
  let seen;
  const files = trackedFiles("/x", (cmd, args, options) => { seen = { cmd, args, env: options.env }; return { status: 0, stdout: "a\0b\0" }; },
    { GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", git_index_file: "/i", PATH: "/usr/bin" });
  assert.deepEqual(files, ["a", "b"]);
  assert.equal(seen.cmd, "git");
  assert.deepEqual(Object.keys(seen.env), ["PATH"]);
});

test("an owned mirror is never wiped: a second build refuses and leaves the token unchanged", () => {
  const root = fakeRepo();
  const mirror = testMirror("lock");
  try {
    const token = buildMirror({ root, mirror });
    refused(() => buildMirror({ root, mirror }));
    assert.equal(readFileSync(join(mirror, OWNER_FILE), "utf8"), token);
    assert.ok(existsSync(join(mirror, "supabase/config.toml")), "the owned mirror's files are intact");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("a claim fails if another run created the mirror or wrote a token first", () => {
  const raced = testMirror("raced");
  const tokened = testMirror("tokened");
  mkdirSync(raced);
  try {
    refused(() => claimMirror(raced));
    assert.equal(existsSync(join(raced, OWNER_FILE)), false);
    const first = claimMirror(tokened);
    refused(() => claimMirror(tokened));
    refused(() => writeOwnerToken(tokened));
    assert.equal(readFileSync(join(tokened, OWNER_FILE), "utf8"), first);
  } finally {
    rmSync(raced, { recursive: true, force: true });
    rmSync(tokened, { recursive: true, force: true });
  }
});

test("a stale unowned mirror is replaced, and the new claim gets a fresh token", () => {
  const root = fakeRepo();
  const mirror = testMirror("stale");
  mkdirSync(join(mirror, "supabase"), { recursive: true });
  writeFileSync(join(mirror, "leftover.txt"), "x");
  try {
    const token = buildMirror({ root, mirror });
    assert.equal(existsSync(join(mirror, "leftover.txt")), false);
    assert.equal(readFileSync(join(mirror, OWNER_FILE), "utf8"), token);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("if status fails after a successful start, start tears down with its own token", () => {
  const root = fakeRepo();
  const mirror = testMirror("lost");
  const r = recorder({ supabase: args => args[0] === "status" ? "not json" : "" });
  try {
    assert.throws(() => start({ root, mirror, env: {}, spawn: r.spawn, free: () => 99e9 }), /did not return JSON/);
    const supabase = r.calls.filter(c => c.cmd === "supabase").map(c => c.args[0]);
    assert.deepEqual(supabase, ["start", "status", "stop"]);
    assert.deepEqual(r.calls.find(c => c.cmd === "supabase" && c.args[0] === "stop").args, ["stop", "--workdir", mirror, "--no-backup"]);
    assert.equal(existsSync(mirror), false, "teardown removed the mirror");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("if that teardown fails too, the owner token is surfaced on the error", () => {
  const root = fakeRepo();
  const mirror = testMirror("lost2");
  const r = recorder({
    supabase: args => args[0] === "status" ? "not json" : "",
    docker: args => args[0] === "volume" ? `supabase_db_${projectIdFor(mirror)}` : "",
  });
  try {
    let caught;
    try { start({ root, mirror, env: {}, spawn: r.spawn, free: () => 99e9 }); } catch (error) { caught = error; }
    assert.ok(caught, "start threw");
    const token = readFileSync(join(mirror, OWNER_FILE), "utf8");
    assert.equal(caught.qaToken, token);
    assert.match(caught.message, new RegExp(`owner token ${token}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("DOCKER_CONTEXT must be unset, default or orbstack", () => {
  for (const ok of ["", "default", "orbstack"]) assertLocalEnv({ DOCKER_CONTEXT: ok });
  for (const bad of ["remote-prod", "desktop-linux-ssh", "colima"]) refused(() => assertLocalEnv({ DOCKER_CONTEXT: bad }));
});

test("DOCKER_HOST must be a unix socket or loopback", () => {
  assertLocalEnv({ DOCKER_HOST: "unix:///Users/x/.orbstack/run/docker.sock" });
  assertLocalEnv({ DOCKER_HOST: "tcp://127.0.0.1:2375" });
  for (const bad of ["tcp://docker.example.com:2376", "ssh://user@host", "tcp://10.0.0.5:2375", "unix://relative.sock"]) {
    refused(() => assertLocalEnv({ DOCKER_HOST: bad }));
  }
});

test("each mirror is its own Supabase project, named after the mirror", () => {
  assert.equal(projectIdFor(DEFAULT_MIRROR), "still-qa-backend");
  assert.equal(projectIdFor("/private/tmp/still-qa-run-7"), "still-qa-run-7");
  for (const bad of ["/private/tmp/still-app", "/private/tmp/still-qa-", "/private/tmp/still-qa-UPPER", "/private/tmp/still-qa-a_b"]) refused(() => projectIdFor(bad));
});

test("a config the QA copy cannot use fails before claiming: no mirror, lock or token is left", () => {
  const root = fakeRepo();
  writeFileSync(join(root, "supabase/config.toml"), 'project_id = "still-app"\n[auth.email]\nsmtp.host = "smtp.example.com"\n');
  const mirror = testMirror("cfg");
  try {
    refused(() => buildMirror({ root, mirror }));
    assert.equal(existsSync(mirror), false);
    assert.equal(existsSync(`${mirror}.lock`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("a failure after the claim releases the mirror, so the next start is not wedged", () => {
  const root = fakeRepo();
  rmSync(join(root, "supabase/functions/handler.ts"));  // tracked but missing: the copy fails after the claim
  const mirror = testMirror("wedge");
  try {
    assert.throws(() => buildMirror({ root, mirror }), /ENOENT/);
    assert.equal(existsSync(mirror), false, "the claimed mirror was removed");
    assert.equal(existsSync(`${mirror}.lock`), false);
    writeFileSync(join(root, "supabase/functions/handler.ts"), "export {};\n");
    const token = buildMirror({ root, mirror });
    assert.equal(readFileSync(join(mirror, OWNER_FILE), "utf8"), token);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("while another run holds the build lock, buildMirror refuses without touching the mirror", () => {
  const root = fakeRepo();
  const mirror = testMirror("locked");
  mkdirSync(mirror);
  writeFileSync(join(mirror, "stale.txt"), "x");
  mkdirSync(`${mirror}.lock`);
  try {
    refused(() => buildMirror({ root, mirror }));
    assert.ok(existsSync(join(mirror, "stale.txt")), "the mirror was not replaced");
    assert.ok(existsSync(`${mirror}.lock`), "another run's lock is left alone");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
    rmSync(`${mirror}.lock`, { recursive: true, force: true });
  }
});
