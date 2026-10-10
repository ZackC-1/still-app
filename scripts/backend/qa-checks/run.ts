// Runs one catalogue check (catalogue.mjs) against the hosted database as the narrow read-only
// role, inside a read-only transaction that is always rolled back. Started only by
// .github/workflows/supabase-readonly-checks.yml after the owner approves the run in the protected
// `supabase-readonly-checks` environment.
//
// The repository is public, so Actions logs, step summaries and artifacts are world-readable.
// The log and summary therefore get ONE line: the check id and pass / fail / needs-review. The full
// report is encrypted with age to the owner-approved public key (repository variable
// STILL_QA_READONLY_REPORT_PUBKEY) before it leaves this process; only Claude's private key reads it.
//
// Layers that keep this read-only, independently of each other:
//   1. inputs are a closed check id and QA labels only (resolveRequest); no SQL or ids;
//   2. every query passes the single-SELECT allow-list guard again at run time;
//   3. queries always use the extended protocol (server-side binds, `simple: false`), which
//      refuses more than one statement even when a query has no parameters;
//   4. BEGIN READ ONLY, local statement/lock timeouts, then an explicit rollback;
//   5. the session must prove it is the narrow role (requireCheckerSession);
//   6. the role itself defaults to read-only transactions and can read only QA-scoped views.
import { createHmac } from "node:crypto";
import type postgres from "postgres";
import { createAuditConnection } from "../audit.ts";
import { InputError, LABELS, OPTIONAL_LABELS, PRODUCTION_QUERIES, queryParams, resolveRequest } from "./catalogue.mjs";
import { assertSingleSelect, CHECK_VIEWS } from "./sql-guard.mjs";
import { renderReport } from "./report.mjs";

export const CHECKER_ROLE = "still_qa_readonly_checker";

/** The role's exact per-role settings (candidate SQL). Anything else means it was changed. */
export const EXPECTED_ROLE_CONFIG = [
  "default_transaction_read_only=on",
  "idle_in_transaction_session_timeout=30s",
  "lock_timeout=1s",
  "log_parameter_max_length=0",
  "log_parameter_max_length_on_error=0",
  "statement_timeout=15s",
].join("|");

/**
 * SECURITY DEFINER functions outside pg_catalog/information_schema that the role may execute.
 * Reviewed: none on Supabase PostgreSQL 17.6 with migrations 0001-0021. Add an entry only after
 * reviewing that the function cannot write or reveal customer data.
 */
export const DEFINER_ALLOW_LIST: readonly string[] = [];

export const LABEL_SQL =
  "select a.holder, a.auth_present, a.in_scope from still_qa_checks.account_status a where a.label = $1";

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
      and (n.nspname in ('auth', 'public', 'private', 'storage', 'supabase_migrations')
        or (n.nspname = 'still_qa_checks' and c.relname in ('qa_accounts', 'qa_alias_owner', 'qa_scope', 'qa_rights_scope')))
      and (pg_catalog.has_table_privilege(c.oid, 'SELECT')
        or pg_catalog.has_any_column_privilege(c.oid, 'SELECT'))) as direct_reads,
  (select count(*)::int from pg_catalog.pg_namespace n
    where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
      and pg_catalog.has_schema_privilege(n.oid, 'CREATE')) as create_schemas,
  pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE') as database_create,
  (select count(*)::int from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
      and pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
      and n.nspname || '.' || p.proname <> all (array[${DEFINER_ALLOW_LIST.map((f) => `'${f}'`).join(", ")}]::text[])) as definer_execute,
  coalesce((select pg_catalog.string_agg(c, '|' order by c) from pg_catalog.pg_db_role_setting s,
    lateral pg_catalog.unnest(s.setconfig) c where s.setrole = r.oid and s.setdatabase = 0), '') as role_config,
  (select count(*)::int from pg_catalog.pg_db_role_setting s where s.setrole = r.oid and s.setdatabase <> 0) as database_role_config
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
  database_create: boolean;
  definer_execute: number;
  role_config: string;
  database_role_config: number;
}

export class CheckError extends Error {}
/** An optional QA label (the Preserved QA account) that is not registered: not a failure. */
export class UnavailableError extends Error {}

/** Names (never values) of the narrowness conditions a session fails. */
export function sessionProblems(session: CheckerSession | undefined): string[] {
  if (!session) return ["no-session"];
  const problems: string[] = [];
  if (session.user !== CHECKER_ROLE) problems.push("wrong-role");
  for (const key of ["superuser", "bypassrls", "createrole", "createdb", "replication", "inherit", "database_create"] as const) {
    if (session[key] !== false) problems.push(key);
  }
  if (session.memberships !== 0) problems.push("membership");
  if (session.read_only !== "on") problems.push("not-read-only");
  if (session.own_grants !== CHECK_VIEWS.length || session.foreign_grants !== 0) problems.push("grants");
  if (session.writable !== 0) problems.push("writable-relation");
  if (session.direct_reads !== 0) problems.push("direct-read");
  if (session.create_schemas !== 0) problems.push("schema-create");
  if (session.definer_execute !== 0) problems.push("definer-execute");
  if (session.role_config !== EXPECTED_ROLE_CONFIG || session.database_role_config !== 0) problems.push("role-settings");
  return problems;
}

/** Refuses any session that is not exactly the narrow read-only checker. */
export function requireCheckerSession(session: CheckerSession | undefined): void {
  const problems = sessionProblems(session);
  if (problems.length) {
    throw new CheckError(`The database session is not the narrow read-only checker (${problems.join(", ")}); nothing was read.`);
  }
}

type Request = ReturnType<typeof resolveRequest>;
type Sql = ReturnType<typeof postgres>;
type Rows = Record<string, unknown>[];
export interface CheckRun {
  holders: string[];
  results: { query: Request["check"]["queries"][number]; rows: Rows }[];
  productionRows?: Rows[];
}
class Rollback {
  constructor(readonly value: CheckRun) {}
}

/**
 * postgres.js would use the simple (multi-statement) protocol for a query without parameters.
 * `simple: false` is a supported runtime option that its type declarations omit.
 */
const EXTENDED = { prepare: false, simple: false } as { prepare: boolean };

/** Runs the check in one read-only transaction and always rolls it back. */
export async function runCheck(sql: Sql, request: Request): Promise<CheckRun> {
  for (const query of request.check.queries) {
    assertSingleSelect(query.sql, queryParams(query, request.labels.length).length);
  }
  for (const query of PRODUCTION_QUERIES) assertSingleSelect(query.sql, 0);
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
        if (rows.length !== 1 && OPTIONAL_LABELS.includes(label)) {
          throw new UnavailableError(
            `${LABELS[label as keyof typeof LABELS]} (${label}) is not registered (not a QA alias); this check cannot read it.`,
          );
        }
        if (rows.length !== 1) {
          throw new CheckError(`QA label ${label} is not registered; the owner registers it once (see the runbook).`);
        }
        const deletedAllowed = request.check.allowDeletedAccount && !rows[0].auth_present;
        if (!rows[0].in_scope && !deletedAllowed) {
          throw new CheckError(
            `QA label ${label} is not in QA scope (deleted, not an owner QA alias, or not a sandbox member).`,
          );
        }
        if (!rows[0].auth_present && !request.check.allowDeletedAccount) {
          throw new CheckError(`QA label ${label} has no Auth account; only the deletion check accepts that.`);
        }
        holders.push(String(rows[0].holder));
      }
      const results = [];
      for (const query of request.check.queries) {
        const params = queryParams(query, holders.length).map((i) => holders[i]);
        results.push({ query, rows: [...(await tx.unsafe(query.sql, params, EXTENDED))] as Rows });
      }
      const productionRows = request.check.production
        ? await Promise.all(PRODUCTION_QUERIES.map(async (q) => [...(await tx.unsafe(q.sql, [], EXTENDED))] as Rows))
        : undefined;
      throw new Rollback({ holders, results, productionRows });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
  throw new CheckError("The read-only transaction ended without a result.");
}

const canonical = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value instanceof Date ? value.toISOString() : value;

/** Keyed digest of production state: comparable across runs, meaningless without the key. */
export function productionDigest(rows: Rows[], refKey: string): string {
  if (!/^[0-9a-f]{64}$/.test(refKey)) throw new CheckError("Reference key missing or malformed.");
  const text = JSON.stringify(rows.map((set) => set.map((row) => Object.entries(row).map(([k, v]) => [k, canonical(v)]))));
  return createHmac("sha256", Buffer.from(refKey, "hex")).update(text).digest("hex");
}

export type ProductionStatus = "recorded" | "unchanged" | "changed" | "no-baseline";

/** Compares a digest with the recorded baseline file content ({"v":1,"digest":"..."}). */
export function compareProduction(digest: string, baselineText: string | undefined): ProductionStatus {
  if (!baselineText) return "no-baseline";
  try {
    const baseline = JSON.parse(baselineText);
    if (baseline?.v !== 1 || !/^[0-9a-f]{64}$/.test(baseline?.digest ?? "")) return "no-baseline";
    return baseline.digest === digest ? "unchanged" : "changed";
  } catch {
    return "no-baseline";
  }
}

export type Verdict = "pass" | "fail" | "needs-review" | "unavailable";

/** Fixed catalogue notes (no values), e.g. that the optional Preserved QA account is not registered. */
export function notesFor(request: Request, run: CheckRun): string[] {
  return request.check.notes?.(run.results.map((r) => r.rows)) ?? [];
}

export function verdictFor(request: Request, run: CheckRun, production?: ProductionStatus): Verdict {
  const decided = request.check.verdict?.(run.results.map((r) => r.rows), production);
  return decided ?? "needs-review";
}

/** A fixed, value-free description of a failure: never driver text, hosts or parameters. */
export function describeFailure(error: unknown): string {
  if (error instanceof CheckError || error instanceof InputError) return error.message;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return `The database refused the read (SQLSTATE ${code}); nothing was changed.`;
  }
  return "The read-only check could not complete (connection, TLS, encryption or configuration); nothing was changed.";
}

const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

/** Encrypts the report to the approved age recipient; plaintext never touches disk. */
export async function encryptReport(report: string, { ageBin, recipient, outFile }: { ageBin: string; recipient: string; outFile: string }) {
  if (!AGE_RECIPIENT.test(recipient)) throw new CheckError("Report public key missing or malformed (STILL_QA_READONLY_REPORT_PUBKEY).");
  const child = new Deno.Command(ageBin, {
    args: ["--encrypt", "--recipient", recipient, "--output", outFile],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(report));
  await writer.close();
  const { success } = await child.status;
  if (!success) throw new CheckError("Encrypting the report failed; nothing was published.");
}

if (import.meta.main) {
  const env = (name: string) => Deno.env.get(name) ?? "";
  const programId = /^(setup|DB-[0-9]{2})$/.test(env("QA_CHECK_ID")) ? env("QA_CHECK_ID") : "unknown";
  let sql: Sql | undefined;
  let line: string;
  try {
    const request = resolveRequest({
      check: env("QA_CHECK_ID"),
      account: env("QA_CHECK_ACCOUNT") || "none",
      accountB: env("QA_CHECK_ACCOUNT_B") || "none",
    });
    const refKey = env("STILL_QA_CHECKS_REF_KEY");
    if (!/^[0-9a-f]{64}$/.test(refKey)) throw new CheckError("Reference key missing or malformed (STILL_QA_READONLY_REF_KEY).");
    const recipient = env("STILL_QA_CHECKS_REPORT_PUBKEY");
    if (!AGE_RECIPIENT.test(recipient)) throw new CheckError("Report public key missing or malformed (STILL_QA_READONLY_REPORT_PUBKEY).");
    const url = env("STILL_QA_CHECKS_DB_URL");
    if (!url) throw new CheckError("Read-only check credential unavailable in this environment.");
    sql = createAuditConnection(url, env("STILL_QA_CHECKS_CA_PEM") || undefined);
    const run = await runCheck(sql, request);
    let production: ProductionStatus | undefined;
    if (request.check.production && run.productionRows) {
      const digest = productionDigest(run.productionRows, refKey);
      if (request.check.production === "record") {
        await Deno.writeTextFile(`${env("STILL_QA_CHECKS_BASELINE_OUT")}/baseline.json`, JSON.stringify({ v: 1, digest }));
        production = "recorded";
      } else {
        const file = `${env("STILL_QA_CHECKS_BASELINE_IN")}/baseline.json`;
        const text = await Deno.readTextFile(file).catch(() => undefined);
        production = compareProduction(digest, text);
      }
    }
    const verdict = verdictFor(request, run, production);
    const notes = notesFor(request, run);
    const report = renderReport({ ...request, holders: run.holders, results: run.results, refKey, production, verdict, notes });
    await encryptReport(report, {
      ageBin: env("STILL_QA_AGE_BIN"),
      recipient,
      outFile: `${env("STILL_QA_CHECKS_REPORT_DIR")}/report.age`,
    });
    // Notes are fixed catalogue text (label names only), safe for the public log.
    line = `Read-only QA check ${programId}: ${verdict} (full report: encrypted artifact)${notes.map((n) => ` Note: ${n}`).join("")}`;
    if (verdict === "fail") Deno.exitCode = 1;
  } catch (error) {
    if (error instanceof UnavailableError) {
      line = `Read-only QA check ${programId}: unavailable (${error.message})`;
    } else {
      line = `Read-only QA check ${programId}: fail (${describeFailure(error)})`;
      Deno.exitCode = 1;
    }
  } finally {
    try {
      await sql?.end({ timeout: 5 });
    } catch {
      Deno.exitCode = 1;
    }
  }
  console.log(line);
  const summary = env("GITHUB_STEP_SUMMARY");
  if (summary) await Deno.writeTextFile(summary, `${line}\n`, { append: true }).catch(() => {});
}
