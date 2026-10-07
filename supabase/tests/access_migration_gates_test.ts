// Actual SQL/catalog negative controls. Cloud-only: skipped runs are not SQL evidence.
import { assert, assertEquals, assertRejects } from "@std/assert";
import type postgres from "postgres";
import { connection } from "./synthetic_settings_helpers.ts";

const target = Deno.env.get("STILL_ACCESS_TEST_DATABASE_URL");
const mode = Deno.env.get("STILL_ACCESS_MIGRATION_MODE");
const version = Deno.env.get("STILL_ACCESS_MIGRATION_VERSION");
const enabled =
  !!target &&
  Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted" &&
  Deno.build.os === "linux";
const stem =
  version === "0019" ? "0019_scoped_access_rights" : "0020_apple_scoped_access";
const source = (path: string) =>
  Deno.readTextFile(new URL(path, import.meta.url));

type Sql = ReturnType<typeof connection>;
type Tx = postgres.TransactionSql;
async function issues(tx: Sql | Tx) {
  const rows = await tx.unsafe(
    await source(`../../scripts/backend/deploy/verify/${stem}.sql`),
  );
  return JSON.parse(String(Object.values(rows[0]!)[0])) as string[];
}
async function readOnly(sql: Sql) {
  return await sql.begin(async (tx) => {
    await tx`set transaction read only`;
    return await issues(tx);
  });
}
async function negative(sql: Sql, mutation: string, code: string) {
  const error = await assertRejects(() =>
    sql.begin(async (tx) => {
      await tx.unsafe(mutation);
      assert(
        (await issues(tx)).some((value) => value.startsWith(code)),
        `drift was not detected: ${code}`,
      );
      throw new Error("synthetic-rollback");
    }),
  );
  assert(error instanceof Error);
  assertEquals(error.message, "synthetic-rollback");
  assertEquals(await readOnly(sql), []);
}
Deno.test({
  name: "exact access migration catalog, ACL, body and drift gates",
  ignore: !enabled,
  fn: async () => {
    assert(version === "0019" || version === "0020");
    assert(mode === "pre" || mode === "post");
    const sql = connection(target!);
    try {
      if (mode === "pre") {
        assert((await readOnly(sql)).includes("migration_version"));
        // A nonempty preserved account/legacy row fixture prevents a vacuous upgrade comparison.
        await sql`insert into auth.users(id,email,email_confirmed_at) values('d2020202-0000-4000-8000-000000000019','access-gate@example.invalid',clock_timestamp()) on conflict(id) do nothing`;
        if (version === "0020") {
          const token =
            await sql`select public.begin_access_observation('d2020202-0000-4000-8000-000000000019','sandbox') as token`;
          await sql`select public.commit_access_observation('d2020202-0000-4000-8000-000000000019','sandbox',${token[0]!.token}::uuid,${JSON.stringify([{ key: "d".repeat(64), product: "still_pro_v3" }])}::jsonb)`;
        }
        return;
      }
      assertEquals(await readOnly(sql), []);
      const migration = await source(`../migrations/${stem}.sql`);
      const functions = [
        ...migration.matchAll(
          /create(?: or replace)? function\s+([\w.]+)\s*\((.*?)\).*?as \$\$(.*?)\$\$;/gis,
        ),
      ];
      assert(functions.length >= 4);
      for (const match of functions) {
        const signature = `${match[1]}(${match[2]!
          .split(",")
          .map((arg) => arg.trim().replace(/^\w+\s+/, ""))
          .join(",")})`;
        await negative(
          sql,
          `grant execute on function ${signature} to anon`,
          "routine_acl:",
        );
        await negative(
          sql,
          `alter function ${signature} security invoker`,
          "routine_definer:",
        );
        await negative(
          sql,
          `alter function ${signature} set search_path=public`,
          "routine_path:",
        );
        await negative(
          sql,
          match[0]!
            .replace(/^create function/i, "create or replace function")
            .replace(/\$\$;$/, "\n-- body drift control\n$$;"),
          "routine_body:",
        );
      }
      const tables =
        version === "0019"
          ? [
              "access_observations",
              "access_rights",
              "access_revocations",
              "access_transfer_operations",
            ]
          : ["apple_access_observations", "apple_access_link_operations"];
      for (const table of tables) {
        await negative(
          sql,
          `alter table private.${table} disable row level security`,
          "table_rls:",
        );
        await negative(
          sql,
          `grant select on private.${table} to still_entitlement_writer`,
          "table_acl:",
        );
        const columns =
          await sql`select attname from pg_catalog.pg_attribute where attrelid=${`private.${table}`}::regclass and attnum>0 and not attisdropped order by attnum limit 1`;
        await negative(
          sql,
          `grant select (${columns[0]!.attname}) on private.${table} to authenticated`,
          "column_acl:",
        );
        const checks =
          await sql`select conname,pg_catalog.pg_get_expr(conbin,conrelid) as expression from pg_catalog.pg_constraint where conrelid=${`private.${table}`}::regclass and contype='c' order by conname limit 1`;
        assert(checks.length === 1);
        await negative(
          sql,
          `alter table private.${table} drop constraint ${checks[0]!.conname}; alter table private.${table} add constraint ${checks[0]!.conname} check ((${checks[0]!.expression}) or true)`,
          "check_expression:",
        );
        await negative(
          sql,
          `alter table private.${table} add column access_drift text`,
          "table_shape:",
        );
        await negative(
          sql,
          `create policy access_drift on private.${table} for select to authenticated using (true)`,
          "table_policy:",
        );
      }
    } finally {
      await sql.end();
    }
  },
});
