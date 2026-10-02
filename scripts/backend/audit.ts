import postgres from "postgres";

export interface AuditSession {
  user: string;
  superuser: boolean;
  bypassrls: boolean;
  createrole: boolean;
  createdb: boolean;
  memberships: number;
}

export function requireAuditSession(session: AuditSession): void {
  if (
    session.user !== "still_security_auditor" || session.superuser ||
    session.bypassrls ||
    session.createrole || session.createdb || session.memberships !== 0
  ) {
    throw new Error("Audit credential is not the dedicated narrow role");
  }
}

export function requireCleanAudit(rows: { issue: string }[]): void {
  if (rows.length > 0) throw new Error("Security catalog drift detected");
}

/** The audit always authenticates its endpoint, including when URL options request weaker TLS. */
export function createAuditConnection(url: string, ca?: string) {
  return postgres(url, {
    prepare: false,
    max: 1,
    connect_timeout: 15,
    debug: false,
    onnotice: () => {},
    ssl: ca ? { rejectUnauthorized: true, ca } : "verify-full",
  });
}

if (import.meta.main) {
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    const url = Deno.env.get("STILL_SECURITY_AUDIT_DB_URL");
    if (!url) throw new Error("Audit credential unavailable");
    sql = createAuditConnection(
      url,
      Deno.env.get("STILL_SECURITY_AUDIT_CA_PEM"),
    );
    await sql.begin("read only", async (tx) => {
      await tx.unsafe("set local statement_timeout = '15s'");
      const rows = await tx<AuditSession[]>`
        select current_user as "user", r.rolsuper as superuser, r.rolbypassrls as bypassrls,
          r.rolcreaterole as createrole, r.rolcreatedb as createdb,
          (select count(*)::int from pg_auth_members m where m.member=r.oid) as memberships
        from pg_roles r where r.rolname=current_user
      `;
      if (rows.length !== 1) throw new Error("Audit role unavailable");
      requireAuditSession(rows[0]);
      requireCleanAudit(
        await tx<{ issue: string }[]>`select issue from still_security.audit()`,
      );
    });
  } catch {
    // Driver/provider error text can contain connection details; emit only a fixed category.
    console.error(
      "Catalog security audit failed: check the private role/routine/configuration and review catalog drift; keep paid activation held.",
    );
    Deno.exitCode = 1;
  } finally {
    try {
      await sql?.end({ timeout: 5 });
    } catch {
      console.error(
        "Catalog security audit failed: database connection cleanup failed; review the private configuration.",
      );
      Deno.exitCode = 1;
    }
  }
  if (!Deno.exitCode) console.log("Catalog security audit passed.");
}
