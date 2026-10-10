// Runs one catalogue check (catalogue.mjs) against the hosted database as the narrow read-only
// role, inside a read-only transaction that is always rolled back, and prints a privacy-safe
// report (report.mjs). Started only by .github/workflows/supabase-readonly-checks.yml after the
// owner approves the run in the protected `supabase-readonly-checks` environment.
//
// Layers that keep this read-only, independently of each other:
//   1. inputs are a closed check id and QA labels only (resolveRequest); no SQL or ids;
//   2. every query passes the single-SELECT allow-list guard again at run time;
//   3. queries always use the extended protocol (server-side binds, `simple: false`), which
//      refuses more than one statement even when a query has no parameters;
//   4. BEGIN READ ONLY, local statement/lock timeouts, then an explicit rollback;
//   5. the session must prove it is the narrow role: no membership or elevated attribute, exactly
//      SELECT on the check views, no write and no direct read on any Still/Auth relation;
//   6. the role itself defaults to read-only transactions and can read only QA-scoped views.
import type postgres from "postgres";
import { createAuditConnection } from "../audit.ts";
import { InputError, queryParams, resolveRequest } from "./catalogue.mjs";
import { assertSingleSelect, CHECK_VIEWS } from "./sql-guard.mjs";
import { renderReport } from "./report.mjs";

export const CHECKER_ROLE = "still_qa_readonly_checker";

export const LABEL_SQL =
  "select a.holder, a.auth_present from still_qa_checks.account_status a where a.label = $1";

/** Reads the session's own authority. A fixed reviewed catalog query; returns one row. */
export const SESSION_SQL = `
select current_user as "user", r.rolsuper as superuser, r.rolbypassrls as bypassrls,
  r.rolcreaterole as createrole, r.rolcreatedb as createdb, r.rolreplication as replication,
  r.rolinherit as inherit,
  -- The checker belongs to no role. PostgreSQL 16+ gives the creating operator (postgres) ADMIN
  -- on the role it created, without INHERIT or SET; that is the only membership allowed on it.
  (select count(*)::int from pg_catalog.pg_auth_members m where m.member = r.oid
     or (m.roleid = r.oid and not (m.member = (select oid from pg_catalog.pg_roles where rolname = 'postgres')
       and m.admin_option and not m.inherit_option and not m.set_option))) as memberships,
  pg_catalog.current_setting('transaction_read_only') as read_only,
  (select count(*)::int from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) a
    where a.grantee = r.oid) as own_grants,
  (select count(*)::int from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
    lateral pg_catalog.aclexplode(c.relacl) a
    where a.grantee = r.oid and (n.nspname <> 'still_qa_checks' or c.relkind <> 'v'
      or a.privilege_type <> 'SELECT' or a.is_grantable)) as foreign_grants,
  (select count(*)::int from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and n.nspname in ('auth', 'public', 'private', 'storage', 'supabase_migrations', 'still_qa_checks')
      and (pg_catalog.has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or pg_catalog.has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES'))) as writable,
  (select count(*)::int from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and n.nspname in ('auth', 'public', 'private', 'storage', 'supabase_migrations')
      and (pg_catalog.has_table_privilege(c.oid, 'SELECT')
        or pg_catalog.has_any_column_privilege(c.oid, 'SELECT'))) as direct_reads,
  (select count(*)::int from pg_catalog.pg_namespace n
    where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
      and pg_catalog.has_schema_privilege(n.oid, 'CREATE')) as create_schemas
from pg_catalog.pg_roles r where r.rolname = current_user`;

export interface CheckerSession {
  user: string;
  superuser: boolean;
  bypassrls: boolean;
  createrole: boolean;
  createdb: boolean;
  replication: boolean;
  inherit: boolean;
  memberships: number;
  read_only: string;
  own_grants: number;
  foreign_grants: number;
  writable: number;
  direct_reads: number;
  create_schemas: number;
}

export class CheckError extends Error {}

/** Refuses any session that is not exactly the narrow read-only checker. */
export function requireCheckerSession(session: CheckerSession | undefined): void {
  if (
    !session || session.user !== CHECKER_ROLE || session.superuser !== false ||
    session.bypassrls !== false || session.createrole !== false ||
    session.createdb !== false || session.replication !== false ||
    session.inherit !== false || session.memberships !== 0 ||
    session.read_only !== "on" || session.own_grants !== CHECK_VIEWS.length ||
    session.foreign_grants !== 0 || session.writable !== 0 ||
    session.direct_reads !== 0 || session.create_schemas !== 0
  ) {
    throw new CheckError(
      "The database session is not the narrow read-only checker; nothing was read.",
    );
  }
}

type Request = ReturnType<typeof resolveRequest>;
type Sql = ReturnType<typeof postgres>;
class Rollback {
  constructor(readonly value: { holders: string[]; results: unknown[] }) {}
}

/**
 * postgres.js would use the simple (multi-statement) protocol for a query without parameters.
 * `simple: false` is a supported runtime option that its type declarations omit.
 */
const EXTENDED = { prepare: false, simple: false } as { prepare: boolean };


/** Runs the check in one read-only transaction and always rolls it back. */
export async function runCheck(sql: Sql, request: Request) {
  for (const query of request.check.queries) {
    assertSingleSelect(query.sql, queryParams(query, request.labels.length).length);
  }
  assertSingleSelect(LABEL_SQL, 1);
  try {
    await sql.begin("read only", async (tx) => {
      await tx.unsafe("set local search_path = pg_catalog");
      await tx.unsafe("set local statement_timeout = '15s'");
      await tx.unsafe("set local lock_timeout = '1s'");
      const [session] = await tx.unsafe(SESSION_SQL, [], EXTENDED);
      requireCheckerSession(session as unknown as CheckerSession);
      const holders: string[] = [];
      for (const label of request.labels) {
        const rows = await tx.unsafe(LABEL_SQL, [label], EXTENDED);
        if (rows.length !== 1) {
          throw new CheckError(
            `QA label ${label} is not in the registry; the owner registers it once (see the runbook).`,
          );
        }
        if (!rows[0].auth_present && !request.check.allowDeletedAccount) {
          throw new CheckError(
            `QA label ${label} has no Auth account (deleted?); only the deletion check accepts that.`,
          );
        }
        holders.push(String(rows[0].holder));
      }
      const results = [];
      for (const query of request.check.queries) {
        const params = queryParams(query, holders.length).map((i) => holders[i]);
        results.push({ query, rows: [...(await tx.unsafe(query.sql, params, EXTENDED))] });
      }
      throw new Rollback({ holders, results });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
  throw new CheckError("The read-only transaction ended without a result.");
}

/** A fixed, value-free description of a failure: never driver text, hosts or parameters. */
export function describeFailure(error: unknown): string {
  if (error instanceof CheckError || error instanceof InputError) return error.message;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return `The database refused the read (SQLSTATE ${code}); nothing was changed.`;
  }
  return "The read-only check could not complete (connection, TLS or configuration); nothing was changed.";
}

if (import.meta.main) {
  const env = (name: string) => Deno.env.get(name) ?? "";
  let sql: Sql | undefined;
  try {
    const request = resolveRequest({
      check: env("QA_CHECK_ID"),
      account: env("QA_CHECK_ACCOUNT") || "none",
      accountB: env("QA_CHECK_ACCOUNT_B") || "none",
    });
    const url = env("STILL_QA_CHECKS_DB_URL");
    if (!url) throw new CheckError("Read-only check credential unavailable in this environment.");
    sql = createAuditConnection(url, env("STILL_QA_CHECKS_CA_PEM") || undefined);
    const { holders, results } = await runCheck(sql, request);
    const report = renderReport({ ...request, holders, results });
    console.log(report);
    const summary = env("GITHUB_STEP_SUMMARY");
    if (summary) await Deno.writeTextFile(summary, `${report}\n`, { append: true });
  } catch (error) {
    console.error(`Read-only QA check failed: ${describeFailure(error)}`);
    Deno.exitCode = 1;
  } finally {
    try {
      await sql?.end({ timeout: 5 });
    } catch {
      console.error("Read-only QA check: closing the database connection failed.");
      Deno.exitCode = 1;
    }
  }
}
