import { assertEquals, assertThrows } from "@std/assert";
import { CHECK_VIEWS } from "./sql-guard.mjs";
import { CHECKER_ROLE, CheckError, describeFailure, requireCheckerSession } from "./run.ts";

const narrow = {
  user: CHECKER_ROLE,
  superuser: false,
  bypassrls: false,
  createrole: false,
  createdb: false,
  replication: false,
  inherit: false,
  memberships: 0,
  read_only: "on",
  own_grants: CHECK_VIEWS.length,
  foreign_grants: 0,
  writable: 0,
  direct_reads: 0,
  create_schemas: 0,
};

Deno.test("the session proof accepts only the exact narrow read-only checker", () => {
  requireCheckerSession(narrow);
  assertThrows(() => requireCheckerSession(undefined), CheckError);
  for (const user of ["postgres", "service_role", "still_security_auditor", "authenticated"]) {
    assertThrows(() => requireCheckerSession({ ...narrow, user }), CheckError);
  }
  for (const key of ["superuser", "bypassrls", "createrole", "createdb", "replication", "inherit"] as const) {
    assertThrows(() => requireCheckerSession({ ...narrow, [key]: true }), CheckError);
  }
  for (
    const [key, value] of [
      ["memberships", 1],
      ["read_only", "off"],
      ["own_grants", CHECK_VIEWS.length + 1],
      ["own_grants", CHECK_VIEWS.length - 1],
      ["foreign_grants", 1],
      ["writable", 1],
      ["direct_reads", 1],
      ["create_schemas", 1],
    ] as const
  ) {
    assertThrows(() => requireCheckerSession({ ...narrow, [key]: value }), CheckError);
  }
});

Deno.test("failures are described without driver text, hosts or values", () => {
  const leaky = Object.assign(new Error("password authentication failed for db.example.supabase.co user x@y"), {
    code: "28P01",
  });
  assertEquals(describeFailure(leaky), "The database refused the read (SQLSTATE 28P01); nothing was changed.");
  const network = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
  assertEquals(
    describeFailure(network),
    "The read-only check could not complete (connection, TLS or configuration); nothing was changed.",
  );
});
