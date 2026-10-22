// Migration 0025 as hosted production meets it: the database is at 0024 with the read-only QA
// check candidate already installed, so still_qa_readonly_checker EXISTS when 0025 runs (the
// role-present branch). Run by scripts/backend/rehearse-qa-readonly-checks.sh on a disposable
// GitHub-hosted runner.
//
// Modes (STILL_PROD01_TEST_MODE):
//   pre-upgrade  at 0024 with the candidate: the checker holds its 25 candidate grants and the 0025
//                gate reports exactly migration_version and view_missing (it is not vacuous).
//   upgrade      after the CLI applied 0025 as the ordinary postgres role: the gate is clean, the
//                checker holds SELECT on the view (26 grants), the view returns one row, and every
//                wider grant is caught, with the checker present AND absent: a grant to anon or to
//                an arbitrary role makes the migration's own self-check abort and the gate report
//                client_reach / view_grant (schema_grant for the schema). Each control runs in a
//                transaction that is rolled back.
// No customer data: the view reads only the product policy tables; nothing is seeded here.
import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";

const url = Deno.env.get("STILL_PROD01_TEST_DATABASE_URL");
const mode = Deno.env.get("STILL_PROD01_TEST_MODE");
const required = Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1";
const GATE = "scripts/backend/deploy/verify/0025_production_sales_summary_view.sql";
const MIGRATION = "supabase/migrations/0025_production_sales_summary_view.sql";
const CHECKER = "still_qa_readonly_checker";
const VIEW = "still_qa_checks.production_sales_summary";
const PROBE = "qa_prod01_probe_role";
const ABSENT = "qa_prod01_checker_renamed";

class Rollback {
  constructor(readonly value: unknown) {}
}

Deno.test({
  name: "0025 production sales summary: gate before and after, with the checker role present",
  ignore: !required && (!url || (mode !== "pre-upgrade" && mode !== "upgrade")),
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    assert(url && (mode === "pre-upgrade" || mode === "upgrade"), "database URL and mode are required");
    if (new URL(url).hostname !== "127.0.0.1") throw new Error("Disposable loopback database required");
    const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    const gateText = await Deno.readTextFile(GATE);
    const source = await Deno.readTextFile(MIGRATION);
    const selfCheck = source.slice(source.indexOf("-- ── 4. Self-check"), source.lastIndexOf("commit;"));
    assert(selfCheck.includes("do $$") && selfCheck.includes("production sales summary grants"), "self-check block not found");
    type Tx = Pick<postgres.Sql, "unsafe">;
    const gate = async (tx: Tx) => ((await tx.unsafe(gateText))[0].issues as string[]);
    /** Runs `fn` in a transaction that is always rolled back; returns its value. */
    const rolledBack = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
      try {
        await sql.begin(async (tx) => {
          throw new Rollback(await fn(tx));
        });
      } catch (error) {
        if (error instanceof Rollback) return error.value as T;
        throw error;
      }
      throw new Error("unreachable");
    };
    const checkerGrants = async () =>
      Number((await sql`select count(*)::int as n from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) a
        where a.grantee = (select oid from pg_catalog.pg_roles where rolname = ${CHECKER})`)[0].n);
    try {
      const versions = (await sql`select version from supabase_migrations.schema_migrations order by version`)
        .map((row) => row.version as string);
      const [{ present }] = await sql`select exists (select 1 from pg_catalog.pg_roles where rolname = ${CHECKER}) as present`;
      assert(present, "the candidate must be installed first: the checker role is present in production");

      if (mode === "pre-upgrade") {
        await t.step("at 0024 the gate reports exactly the missing version and view", async () => {
          assertEquals(versions.at(-1), "0024");
          assertEquals(await gate(sql), ["migration_version", "view_missing"]);
          assertEquals(await checkerGrants(), 25);
        });
        return;
      }

      await t.step("after the apply the gate is clean and the checker holds SELECT on the view", async () => {
        assert(versions.includes("0025"), JSON.stringify(versions));
        assertEquals(await gate(sql), []);
        assertEquals(await checkerGrants(), 26);
        const [{ granted }] = await sql`select pg_catalog.has_table_privilege(${CHECKER}, ${VIEW}, 'SELECT') as granted`;
        assertEquals(granted, true);
        assertEquals((await sql.unsafe(`select * from ${VIEW}`)).length, 1);
        // The self-check passes on the real end state.
        await rolledBack((tx) => tx.unsafe(selfCheck));
      });

      // Each wider grant: the gate's exact issues, and whether the migration's self-check aborts.
      const controls: [string, string, string[], boolean][] = [
        ["SELECT to anon", `grant select on ${VIEW} to anon`, ["client_reach", "view_grant"], true],
        ["SELECT to an arbitrary role", `grant select on ${VIEW} to ${PROBE}`, ["view_grant"], true],
        ["grantable SELECT to the checker", `grant select on ${VIEW} to ${CHECKER} with grant option`, ["view_grant"], true],
        ["schema USAGE to an arbitrary role", `grant usage on schema still_qa_checks to ${PROBE}`, ["schema_grant"], false],
        ["schema USAGE to authenticated", `grant usage on schema still_qa_checks to authenticated`, ["schema_grant"], false],
      ];
      const probe = async (tx: Tx, statement: string, expected: string[], aborts: boolean) => {
        await tx.unsafe(statement);
        assertEquals(await gate(tx), expected, statement);
        await tx.unsafe("savepoint self_check");
        if (aborts) {
          await assertRejects(() => tx.unsafe(selfCheck), Error, "production sales summary grants", statement);
        } else {
          await tx.unsafe(selfCheck);
        }
        await tx.unsafe("rollback to savepoint self_check");
      };

      await t.step("with the checker present, every wider grant is reported and aborts the self-check", async () => {
        for (const [name, statement, expected, aborts] of controls) {
          await rolledBack(async (tx) => {
            await tx.unsafe(`create role ${PROBE} nologin`);
            await probe(tx, statement, expected, aborts);
          }).catch((error) => {
            throw new Error(`${name}: ${error instanceof Error ? error.message : error}`);
          });
        }
        assertEquals(await gate(sql), [], "every control rolled back");
      });

      await t.step("with the checker absent, the same grants are still reported (no NULL excuse)", async () => {
        const absent = async (tx: Tx) => {
          // The checker role is gone under its name: its old grants now belong to another role.
          await tx.unsafe(`alter role ${CHECKER} rename to ${ABSENT}`);
          await tx.unsafe(`create role ${PROBE} nologin`);
        };
        // A leftover grant held by any role other than the checker is a wider grant.
        await rolledBack(async (tx) => {
          await absent(tx);
          assertEquals(await gate(tx), ["schema_grant", "view_grant"]);
          await assertRejects(() => tx.unsafe(selfCheck), Error, "production sales summary grants");
        });
        // With those grants removed the role-absent end state is clean, and each control is caught.
        const clean = async (tx: Tx) => {
          await absent(tx);
          await tx.unsafe(`revoke select on ${VIEW} from ${ABSENT}`);
          await tx.unsafe(`revoke usage on schema still_qa_checks from ${ABSENT}`);
        };
        await rolledBack(async (tx) => {
          await clean(tx);
          assertEquals(await gate(tx), []);
          await tx.unsafe(selfCheck);
        });
        for (const [name, statement, expected, aborts] of controls) {
          if (statement.includes(CHECKER)) continue;
          await rolledBack(async (tx) => {
            await clean(tx);
            await probe(tx, statement, expected, aborts);
          }).catch((error) => {
            throw new Error(`checker absent, ${name}: ${error instanceof Error ? error.message : error}`);
          });
        }
        assertEquals(await gate(sql), [], "every control rolled back");
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
