#!/usr/bin/env node
// QA local backend (L8) command line. Local disposable stack only; see local-stack.mjs and guard.mjs.
//
//   node tests/qa/backend/qa-backend.mjs start            start the QA stack (refuses if another runs);
//                                                         prints the owner token stop needs
//   node tests/qa/backend/qa-backend.mjs status           print local URLs
//   node tests/qa/backend/qa-backend.mjs code <email>     request a sign-in code and print it (from Mailpit)
//   node tests/qa/backend/qa-backend.mjs admin-code <email>   the same without email (admin generate link)
//   node tests/qa/backend/qa-backend.mjs smoke            start -> seed -> Mailpit code -> verify -> admin code -> sync round trip -> delete-user -> stop
//   node tests/qa/backend/qa-backend.mjs stop <token>     stop with --no-backup and verify nothing is left
//
// Lost token: confirm no other lane is using the QA stack, then
//   node tests/qa/backend/qa-backend.mjs stop "$(cat /private/tmp/still-qa-backend/.qa-owner)"
// Never run `supabase stop` by hand. A leftover empty /private/tmp/still-qa-backend.lock directory
// (a run killed while building its mirror; no stack exists then) may be removed with rmdir.
import { adminCode } from "./auth.mjs";
import { assertLocalOnly } from "./guard.mjs";
import { REPO, start, status, stop } from "./local-stack.mjs";
import { emailCode, smoke } from "./smoke.mjs";

const [command, arg] = process.argv.slice(2);
assertLocalOnly({ root: REPO });

const urls = s => JSON.stringify({ apiUrl: s.apiUrl, mailpitUrl: s.mailpitUrl, dbUrl: s.dbUrl }, null, 2);

switch (command) {
  case "start": { const s = start(); console.log(urls(s)); console.log(`owner token (needed by stop): ${s.token}`); break; }
  case "status": console.log(urls(status())); break;
  case "code": console.log(await emailCode(status(), arg)); break;
  case "admin-code": { const s = status(); console.log(await adminCode({ apiUrl: s.apiUrl, serviceRoleKey: s.serviceRoleKey, email: arg })); break; }
  case "smoke": { const report = await smoke(); if (!["started", "seeded", "mailpitCode", "mailpitVerified", "adminCode", "adminVerified", "syncRead", "syncWrite", "syncReadBack", "realtime", "deleted", "stopped"].every(k => report[k])) process.exitCode = 1; break; }
  case "stop": console.log(JSON.stringify(stop({ token: arg }))); break;
  default:
    console.error("usage: qa-backend.mjs start|status|code <email>|admin-code <email>|smoke|stop <token>");
    process.exitCode = 2;
}
