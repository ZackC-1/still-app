// End-to-end smoke of the QA backend: start -> seed -> Mailpit code -> verify -> admin code ->
// verify -> stop. Teardown runs only when THIS invocation's start() succeeded, using the owner token
// start() returned, so a refused start (for example because another lane's stack is running) can
// never stop or delete anyone else's stack.
import { randomUUID } from "node:crypto";
import { adminCode, createUser, invokeFunction, realtimeAnswers, requestCode, verifyCode } from "./auth.mjs";
import { start as startStack, stop as stopStack } from "./local-stack.mjs";
import { clearInbox, waitForCode } from "./mailpit.mjs";

export async function emailCode(s, email, deps = {}) {
  const since = Date.now() - 1000;
  await (deps.requestCode ?? requestCode)({ apiUrl: s.apiUrl, anonKey: s.anonKey, email });
  return (deps.waitForCode ?? waitForCode)({ mailpitUrl: s.mailpitUrl, email, since });
}

/** A sync-settings write that turns the global switch off, built from a ready read envelope. */
export function syncWriteRequest(read) {
  return {
    protocol: 2,
    writeId: randomUUID(),
    expectedLineage: read?.lineage,
    receipt: read?.receipt,
    operations: [{ path: "globalOn", value: false, baseRevision: read?.settingsVersion, localStep: 1 }],
  };
}

/** `options` pass through to start/stop (root, mirror, env, spawn, free); `deps` replace helpers in tests. */
export async function smoke(options = {}, deps = {}) {
  const start = deps.start ?? startStack;
  const stop = deps.stop ?? stopStack;
  const log = deps.log ?? (line => console.log(line));
  const report = { started: false, seeded: false, mailpitCode: false, mailpitVerified: false, adminCode: false, adminVerified: false, syncRead: false, syncWrite: false, syncReadBack: false, realtime: false, deleted: false, stopped: false };
  let owned = null;
  try {
    const s = start(options);
    owned = s.token;
    report.started = true;
    await (deps.clearInbox ?? clearInbox)({ mailpitUrl: s.mailpitUrl });
    const run = Date.now().toString(36);
    await (deps.createUser ?? createUser)({ apiUrl: s.apiUrl, serviceRoleKey: s.serviceRoleKey, email: `qa-seed-${run}@example.test` });
    report.seeded = true;
    const email = `qa-${run}@example.test`;
    const verify = deps.verifyCode ?? verifyCode;
    const code = await emailCode(s, email, deps);
    report.mailpitCode = /^\d{6}$/.test(code);
    report.mailpitVerified = typeof await verify({ apiUrl: s.apiUrl, anonKey: s.anonKey, email, code }) === "string";
    const fallback = await (deps.adminCode ?? adminCode)({ apiUrl: s.apiUrl, serviceRoleKey: s.serviceRoleKey, email });
    report.adminCode = /^\d{6}$/.test(fallback);
    const accessToken = await verify({ apiUrl: s.apiUrl, anonKey: s.anonKey, email, code: fallback });
    report.adminVerified = typeof accessToken === "string";
    // Settings sync round trip and account deletion, as the signed-in QA journeys use them.
    const call = (name, body) => (deps.invokeFunction ?? invokeFunction)({ apiUrl: s.apiUrl, anonKey: s.anonKey, accessToken, name, body });
    const read = await call("sync-settings", { protocol: 2, action: "read" });
    report.syncRead = read.status === 200 && read.data?.status === "ready";
    const request = syncWriteRequest(read.data);
    const written = await call("sync-settings", request);
    report.syncWrite = written.status === 200 && written.data?.settings?.globalOn === false;
    const back = await call("sync-settings", { protocol: 2, action: "read" });
    report.syncReadBack = back.status === 200 && back.data?.settings?.globalOn === false;
    report.realtime = await (deps.realtimeAnswers ?? realtimeAnswers)({ apiUrl: s.apiUrl, anonKey: s.anonKey });
    const removed = await call("delete-user", {});
    report.deleted = removed.status === 200 && removed.data?.deleted === true;
  } catch (error) {
    report.error = String(error?.message ?? error);
    // start() could not tear its own stack down: surface the token so a person can stop it.
    if (error?.qaToken) report.ownerToken = error.qaToken;
  } finally {
    if (owned) {
      try {
        stop({ ...options, token: owned });
        report.stopped = true;
      } catch (error) {
        report.stopError = String(error?.message ?? error);
      }
    }
    log(JSON.stringify(report, null, 2));
  }
  return report;
}
