// End-to-end smoke of the QA backend: start -> seed -> Mailpit code -> verify -> admin code ->
// verify -> stop. Teardown runs only when THIS invocation's start() succeeded, using the owner token
// start() returned, so a refused start (for example because another lane's stack is running) can
// never stop or delete anyone else's stack.
import { adminCode, createUser, requestCode, verifyCode } from "./auth.mjs";
import { start as startStack, stop as stopStack } from "./local-stack.mjs";
import { clearInbox, waitForCode } from "./mailpit.mjs";

export async function emailCode(s, email, deps = {}) {
  const since = Date.now() - 1000;
  await (deps.requestCode ?? requestCode)({ apiUrl: s.apiUrl, anonKey: s.anonKey, email });
  return (deps.waitForCode ?? waitForCode)({ mailpitUrl: s.mailpitUrl, email, since });
}

/** `options` pass through to start/stop (root, mirror, env, spawn, free); `deps` replace helpers in tests. */
export async function smoke(options = {}, deps = {}) {
  const start = deps.start ?? startStack;
  const stop = deps.stop ?? stopStack;
  const log = deps.log ?? (line => console.log(line));
  const report = { started: false, seeded: false, mailpitCode: false, mailpitVerified: false, adminCode: false, adminVerified: false, stopped: false };
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
    report.adminVerified = typeof await verify({ apiUrl: s.apiUrl, anonKey: s.anonKey, email, code: fallback }) === "string";
  } catch (error) {
    report.error = String(error?.message ?? error);
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
