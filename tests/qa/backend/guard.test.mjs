import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalOnlyRefusal, assertAllowedCli, assertLocalEnv, assertLocalOnly, assertLocalUrl, assertNotLinked, isLocalUrl,
} from "./guard.mjs";
import { EXCLUDE, QA_PROJECT_ID, buildMirror, parseStatus, qaConfig, runCli, start, stop } from "./local-stack.mjs";

const refused = fn => assert.throws(fn, LocalOnlyRefusal);

function fakeRepo({ linked = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qa-guard-"));
  for (const dir of ["supabase/migrations", "supabase/functions", "packages/core/src", "packages/shared-types/src", "packages/shared-types/fixtures"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "supabase/config.toml"), 'project_id = "still-app"\n[auth.email]\notp_length = 6\n');
  writeFileSync(join(root, "supabase/migrations/0001_x.sql"), "select 1;\n");
  if (linked) {
    mkdirSync(join(root, "supabase/.temp"), { recursive: true });
    writeFileSync(join(root, linked), "abcdefghijklmnopqrst\n");
  }
  return root;
}

test("a linked checkout is refused, whichever link marker is present", () => {
  for (const marker of ["supabase/.temp/project-ref", "supabase/.temp/pooler-url", "supabase/.temp/linked-project.json"]) {
    const root = fakeRepo({ linked: marker });
    try {
      refused(() => assertNotLinked(root));
      refused(() => assertLocalOnly({ root, env: {} }));
      refused(() => buildMirror({ root, mirror: join(root, "..", `mirror-${Date.now()}`) }));
      refused(() => start({ root, mirror: join(tmpdir(), `qa-never-${Date.now()}`), env: {}, spawn: () => assert.fail("spawned"), free: () => 99e9 }));
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

test("the mirror config gets the QA project id and the QA-only code template, never twice", () => {
  const out = qaConfig('project_id = "still-app"\n[api]\nport = 54321\n');
  assert.match(out, new RegExp(`^project_id = "${QA_PROJECT_ID}"$`, "m"));
  assert.doesNotMatch(out, /still-app/);
  assert.match(out, /\[auth\.email\.template\.magic_link\][\s\S]*qa-code\.html/);
  refused(() => qaConfig('[api]\nport = 1\n'));
  refused(() => qaConfig('project_id = "a"\nproject_id = "b"\n'));
  refused(() => qaConfig('project_id = "a"\n[auth.email.template.magic_link]\nsubject = "x"\n'));
});

test("the repository's own config never carries the QA template", () => {
  const repoConfig = readFileSync(new URL("../../../supabase/config.toml", import.meta.url), "utf8");
  assert.doesNotMatch(repoConfig, /qa-code\.html|QA mirror only/);
});

test("buildMirror copies outside the checkout and leaves no link marker or secret file", () => {
  const root = fakeRepo();
  mkdirSync(join(root, "supabase/functions/.temp"), { recursive: true });
  writeFileSync(join(root, "supabase/functions/.env"), "SECRET=1\n");
  const mirror = join(tmpdir(), `qa-mirror-${Date.now()}`);
  try {
    refused(() => buildMirror({ root, mirror: join(root, "inside") }));
    buildMirror({ root, mirror });
    assert.ok(existsSync(join(mirror, "supabase/migrations/0001_x.sql")));
    assert.ok(existsSync(join(mirror, "supabase/templates/qa-code.html")));
    assert.equal(existsSync(join(mirror, "supabase/functions/.env")), false);
    assert.equal(existsSync(join(mirror, "supabase/functions/.temp")), false);
    assert.match(readFileSync(join(mirror, "supabase/config.toml"), "utf8"), /project_id = "still-qa"/);
    assert.match(readFileSync(join(root, "supabase/config.toml"), "utf8"), /project_id = "still-app"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("start refuses while another Supabase stack runs, or under 10 GB free, before touching anything", () => {
  const root = fakeRepo();
  const mirror = join(tmpdir(), `qa-start-${Date.now()}`);
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

test("stop runs --no-backup and fails when QA containers or volumes remain", () => {
  const root = fakeRepo();
  const mirror = join(tmpdir(), `qa-stop-${Date.now()}`);
  mkdirSync(join(mirror, "supabase"), { recursive: true });
  writeFileSync(join(mirror, "supabase/config.toml"), 'project_id = "still-qa"\n');
  const calls = [];
  const spawn = remaining => (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "supabase") return { status: 0, stdout: "" };
    if (args[0] === "volume") return { status: 0, stdout: remaining.join("\n") };
    return { status: 0, stdout: "" };
  };
  try {
    assert.throws(() => stop({ root, mirror, env: {}, spawn: spawn(["supabase_db_still-qa"]) }), /teardown incomplete/);
    assert.deepEqual(calls[0], ["supabase", "stop", "--workdir", mirror, "--no-backup"]);
    assert.ok(existsSync(mirror), "the mirror is kept when teardown is incomplete");
    stop({ root, mirror, env: {}, spawn: spawn(["supabase_db_still-app"]) });
    assert.equal(existsSync(mirror), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});
