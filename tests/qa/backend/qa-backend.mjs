#!/usr/bin/env node
// QA local backend (L8) command line. Local disposable stack only; see local-stack.mjs and guard.mjs.
//
//   node tests/qa/backend/qa-backend.mjs start            start the QA stack (refuses if another runs)
//   node tests/qa/backend/qa-backend.mjs status           print local URLs (keys are the CLI's local demo keys)
//   node tests/qa/backend/qa-backend.mjs code <email>     request a sign-in code and print it (from Mailpit)
//   node tests/qa/backend/qa-backend.mjs admin-code <email>   the same without email (admin generate link)
//   node tests/qa/backend/qa-backend.mjs smoke            start -> seed -> Mailpit code -> verify -> admin code -> stop
//   node tests/qa/backend/qa-backend.mjs stop             stop with --no-backup and verify nothing is left
import { adminCode, createUser, requestCode, verifyCode } from "./auth.mjs";
import { assertLocalOnly } from "./guard.mjs";
import { REPO, start, status, stop } from "./local-stack.mjs";
import { clearInbox, waitForCode } from "./mailpit.mjs";

const [command, arg] = process.argv.slice(2);
assertLocalOnly({ root: REPO });

async function emailCode(s, email) {
  const since = Date.now() - 1000;
  await requestCode({ apiUrl: s.apiUrl, anonKey: s.anonKey, email });
  return waitForCode({ mailpitUrl: s.mailpitUrl, email, since });
}

async function smoke() {
  const report = { started: false, seeded: false, mailpitCode: false, mailpitVerified: false, adminCode: false, adminVerified: false, stopped: false };
  try {
    const s = start();
    report.started = true;
    await clearInbox({ mailpitUrl: s.mailpitUrl });
    const run = Date.now().toString(36);
    await createUser({ apiUrl: s.apiUrl, serviceRoleKey: s.serviceRoleKey, email: `qa-seed-${run}@example.test` });
    report.seeded = true;
    const email = `qa-${run}@example.test`;
    const code = await emailCode(s, email);
    report.mailpitCode = /^\d{6}$/.test(code);
    report.mailpitVerified = typeof await verifyCode({ apiUrl: s.apiUrl, anonKey: s.anonKey, email, code }) === "string";
    const fallback = await adminCode({ apiUrl: s.apiUrl, serviceRoleKey: s.serviceRoleKey, email });
    report.adminCode = /^\d{6}$/.test(fallback);
    report.adminVerified = typeof await verifyCode({ apiUrl: s.apiUrl, anonKey: s.anonKey, email, code: fallback }) === "string";
  } finally {
    try {
      stop();
      report.stopped = true;
    } catch (error) {
      console.error(String(error));
    }
    console.log(JSON.stringify(report, null, 2));
  }
  if (!Object.values(report).every(Boolean)) process.exitCode = 1;
}

switch (command) {
  case "start": { const s = start(); console.log(JSON.stringify({ apiUrl: s.apiUrl, mailpitUrl: s.mailpitUrl, dbUrl: s.dbUrl }, null, 2)); break; }
  case "status": { const s = status(); console.log(JSON.stringify({ apiUrl: s.apiUrl, mailpitUrl: s.mailpitUrl, dbUrl: s.dbUrl }, null, 2)); break; }
  case "code": { const s = status(); console.log(await emailCode(s, arg)); break; }
  case "admin-code": { const s = status(); console.log(await adminCode({ apiUrl: s.apiUrl, serviceRoleKey: s.serviceRoleKey, email: arg })); break; }
  case "smoke": await smoke(); break;
  case "stop": console.log(JSON.stringify(stop())); break;
  default:
    console.error("usage: qa-backend.mjs start|status|code <email>|admin-code <email>|smoke|stop");
    process.exitCode = 2;
}
