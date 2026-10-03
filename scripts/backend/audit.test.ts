import { assertThrows } from "@std/assert";
import { requireAuditSession, requireCleanAudit } from "./audit.ts";

const narrow = {
  user: "still_security_auditor",
  superuser: false,
  bypassrls: false,
  createrole: false,
  createdb: false,
  memberships: 0,
};
Deno.test("audit refuses powerful, inherited and mismatched credentials before invoking the routine", () => {
  requireAuditSession(narrow);
  for (
    const user of [
      "postgres",
      "service_role",
      "still_entitlement_writer",
      "authenticated",
    ]
  ) {
    assertThrows(() => requireAuditSession({ ...narrow, user }));
  }
  for (
    const key of ["superuser", "bypassrls", "createrole", "createdb"] as const
  ) {
    assertThrows(() => requireAuditSession({ ...narrow, [key]: true }));
  }
  assertThrows(() => requireAuditSession({ ...narrow, memberships: 1 }));
});
Deno.test("audit treats any reported drift as a failure, and preserves clean positive control", () => {
  requireCleanAudit([]);
  assertThrows(() => requireCleanAudit([{ issue: "client_server_rpc" }]));
});
