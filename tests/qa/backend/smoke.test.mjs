import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smoke } from "./smoke.mjs";

const quiet = () => {};

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "qa-smoke-"));
  mkdirSync(join(root, "supabase"), { recursive: true });
  writeFileSync(join(root, "supabase/config.toml"), 'project_id = "still-app"\n');
  spawnSync("git", ["-C", root, "init", "-q"]);
  return root;
}

test("a refused start never stops anything: no supabase command and no teardown are spawned", async () => {
  const root = gitRepo();
  const mirror = `/private/tmp/still-qa-smoke-${process.pid}-${Date.now()}`;
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "docker" && args[0] === "ps" && !args.includes("-a")) return { status: 0, stdout: "supabase_db_still-qa\tpublic.ecr.aws/supabase/postgres:17" };
    return assert.fail(`spawned ${cmd} ${args.join(" ")}`);
  };
  try {
    const report = await smoke({ root, mirror, env: {}, spawn, free: () => 99e9 }, { log: quiet });
    assert.equal(report.started, false);
    assert.equal(report.stopped, false);
    assert.match(report.error, /another Supabase stack is running/);
    assert.deepEqual(calls, [["docker", "ps", "--format", "{{.Names}}\t{{.Image}}"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("stop runs only with the token this invocation's start returned, even when a later step fails", async () => {
  const stops = [];
  const status = { apiUrl: "http://127.0.0.1:54321", mailpitUrl: "http://127.0.0.1:54324", anonKey: "a", serviceRoleKey: "s", token: "mine-123" };
  const report = await smoke({ mirror: "/private/tmp/still-qa-x" }, {
    log: quiet,
    start: () => status,
    stop: options => { stops.push(options); },
    clearInbox: async () => {},
    createUser: async () => { throw new Error("seed failed"); },
  });
  assert.equal(report.started, true);
  assert.equal(report.seeded, false);
  assert.equal(report.stopped, true);
  assert.deepEqual(stops, [{ mirror: "/private/tmp/still-qa-x", token: "mine-123" }]);
});

test("a start that throws after nothing was started does not call stop", async () => {
  let stopped = 0;
  const report = await smoke({}, { log: quiet, start: () => { throw new Error("refused"); }, stop: () => { stopped++; } });
  assert.equal(stopped, 0);
  assert.equal(report.stopped, false);
});

test("when start could not tear itself down, smoke reports the owner token and does not call stop", async () => {
  let stopped = 0;
  const error = Object.assign(new Error("status failed; teardown also failed; owner token tok-9"), { qaToken: "tok-9" });
  const report = await smoke({}, { log: quiet, start: () => { throw error; }, stop: () => { stopped++; } });
  assert.equal(report.ownerToken, "tok-9");
  assert.equal(stopped, 0);
});

test("the smoke runs a settings sync round trip, checks Realtime, deletes the account, then stops", async () => {
  const calls = [];
  const status = { apiUrl: "http://127.0.0.1:54321", mailpitUrl: "http://127.0.0.1:54324", anonKey: "a", serviceRoleKey: "s", token: "mine-1" };
  let globalOn = true;
  const report = await smoke({ mirror: "/private/tmp/still-qa-x" }, {
    log: quiet,
    start: () => status,
    stop: () => {},
    clearInbox: async () => {},
    createUser: async () => "id",
    requestCode: async () => {},
    waitForCode: async () => "123456",
    verifyCode: async () => "access-token",
    adminCode: async () => "654321",
    realtimeAnswers: async () => true,
    invokeFunction: async ({ name, body, accessToken }) => {
      calls.push([name, body.action ?? (body.operations ? "write" : "-"), accessToken]);
      if (name === "delete-user") return { status: 200, data: { deleted: true } };
      if (body.operations) { globalOn = body.operations[0].value; return { status: 200, data: { status: "ready", settings: { globalOn } } }; }
      return { status: 200, data: { status: "ready", lineage: "l", receipt: "r", settingsVersion: 3, settings: { globalOn } } };
    },
  });
  assert.deepEqual(calls.map(([name, action]) => `${name}:${action}`), ["sync-settings:read", "sync-settings:write", "sync-settings:read", "delete-user:-"]);
  for (const key of ["syncRead", "syncWrite", "syncReadBack", "realtime", "deleted", "stopped"]) assert.equal(report[key], true, key);
});
