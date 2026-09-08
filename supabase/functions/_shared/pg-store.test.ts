// Pins the missing-user error classification at the driver boundary (R19): ONLY the
// entitlements_user_id_fkey foreign-key violation (SQLSTATE 23503) maps to MissingUserError.
// Anything else — other FK violations, connection outages, plain errors — must pass through
// unclassified so the webhook keeps its fail-and-release retriability for genuine failures.

import { assertEquals, assertRejects } from "@std/assert";
import { PgEntitlementStore, PgRateLimiter } from "./pg-store.ts";
import { MissingUserError } from "./store.ts";

const USER = "11111111-1111-1111-1111-111111111111";

type Sql = ConstructorParameters<typeof PgEntitlementStore>[0];

/** A stand-in sql tag whose every query rejects with the given error. */
function rejectingSql(error: unknown): Sql {
  return (() => Promise.reject(error)) as unknown as Sql;
}

/** The postgres driver surfaces server error fields (code = SQLSTATE, constraint_name) on the
 *  thrown PostgresError; a plain Error with those fields assigned is shape-equivalent. */
function driverError(fields: Record<string, string>): Error {
  return Object.assign(new Error("driver error"), fields);
}

Deno.test("setEntitlement maps the missing-auth-user FK violation to MissingUserError", async () => {
  const fk = driverError({ code: "23503", constraint_name: "entitlements_user_id_fkey" });
  const store = new PgEntitlementStore(rejectingSql(fk));
  const thrown = await assertRejects(
    () => store.setEntitlement(USER, true, "webhook", null),
    MissingUserError,
  );
  assertEquals(thrown.cause, fk);
});

Deno.test("setEntitlement passes every other store error through unclassified", async () => {
  const otherErrors = [
    driverError({ code: "23503", constraint_name: "some_other_fkey" }), // a different FK
    driverError({ code: "23503" }), // FK class without a constraint name
    driverError({ code: "08006" }), // connection_failure — a genuine outage stays retriable
    new Error("plain failure"),
  ];
  for (const error of otherErrors) {
    const store = new PgEntitlementStore(rejectingSql(error));
    const thrown = await assertRejects(() => store.setEntitlement(USER, true, "webhook", null));
    assertEquals(thrown, error);
    assertEquals(thrown instanceof MissingUserError, false);
  }
});

Deno.test("rate limiter fails closed without copying driver parameters into handler logs", async () => {
  const limiter = new PgRateLimiter(rejectingSql(driverError({
    detail: "synthetic raw address 203.0.113.42",
    query: "synthetic parameter-bearing query",
  })));
  const error = await assertRejects(
    () => limiter.consume("reconcile:ip:203.0.113.42", 60, 60),
    Error,
  );
  assertEquals(error.message, "Rate limiter unavailable");
  assertEquals(error.cause, undefined);
  assertEquals(Object.keys(error), []);
});

Deno.test("rate limiter rejects a missing RPC result instead of allowing traffic", async () => {
  const sql = (() => Promise.resolve([])) as unknown as Sql;
  await assertRejects(() =>
    new PgRateLimiter(sql).consume(`reconcile:user:${USER}`, 10, 60)
  );
});
