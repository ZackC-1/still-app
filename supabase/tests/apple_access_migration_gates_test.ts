// Actual SQL/catalog negative controls. Cloud-only: skipped runs are not SQL evidence.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type postgres from "postgres";
import { connection } from "./synthetic_settings_helpers.ts";

const target = Deno.env.get("STILL_ACCESS_TEST_DATABASE_URL");
const mode = Deno.env.get("STILL_ACCESS_MIGRATION_MODE");
const version = Deno.env.get("STILL_ACCESS_MIGRATION_VERSION");
const enabled = !!target &&
  Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted" &&
  Deno.build.os === "linux";
if (Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1" && !enabled) {
  throw new Error("required-cloud-tests-disabled");
}
const stem = "0020_apple_scoped_access";
const source = (path: string) =>
  Deno.readTextFile(new URL(path, import.meta.url));

type Sql = ReturnType<typeof connection>;
type Tx = postgres.TransactionSql;
async function issues(tx: Sql | Tx) {
  const rows = await tx.unsafe(
    await source(`../../scripts/backend/deploy/verify/${stem}.sql`),
  );
  return decodeIssues(rows);
}
function decodeIssues(rows: readonly Record<string, unknown>[]) {
  assertEquals(rows.length, 1, "invalid catalog issue rows");
  const values = Object.values(rows[0]!);
  assertEquals(values.length, 1, "invalid catalog issue columns");
  const value = values[0];
  const decoded: unknown = typeof value === "string"
    ? JSON.parse(value)
    : value;
  assert(
    Array.isArray(decoded) && decoded.every((code) => typeof code === "string"),
    "invalid catalog issue list",
  );
  return decoded as string[];
}
// Non-DB regression for postgres.js JSON/JSONB auto-decoding. These pure checks
// exercise the decoder used by issues() without file, network or DB permissions.
Deno.test("Apple catalog issues preserves decoded and textual JSON arrays", () => {
  for (
    const expected of [[], ["migration_version"], [
      "routine_acl:one",
      "routine_body:two",
    ]]
  ) {
    for (const value of [expected, JSON.stringify(expected)]) {
      assertEquals(decodeIssues([{ issues: value }]), expected);
    }
  }
});
Deno.test("Apple catalog issues rejects malformed rows and non-string issue lists", () => {
  for (
    const rows of [
      [],
      [{ issues: [], extra: [] }],
      [{ issues: null }],
      [{ issues: {} }],
      [{ issues: 0 }],
      [{ issues: ["routine_acl:one", 1] }],
      [{ issues: "null" }],
      [{ issues: "{}" }],
      [{ issues: "[1]" }],
      [{ issues: "not-json" }],
      [{ issues: [] }, { issues: [] }],
    ]
  ) {
    assertThrows(() => decodeIssues(rows));
  }
});
function bodyDriftDdl(source: string): string {
  return source.replace(/^create function/i, "create or replace function")
    .replace(/\$\$;$/, () => "\n-- body drift control\n$$;");
}
Deno.test("body drift DDL preserves both SQL dollar-quote delimiters", () => {
  const source =
    "create function public.synthetic(p text) returns text language plpgsql as $$begin return p; end;$$;";
  assertEquals(
    bodyDriftDdl(source),
    "create or replace function public.synthetic(p text) returns text language plpgsql as $$begin return p; end;\n-- body drift control\n$$;",
  );
});
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
    })
  );
  assert(error instanceof Error);
  assertEquals(error.message, "synthetic-rollback");
  assertEquals(await readOnly(sql), []);
}
Deno.test({
  name: "exact access migration catalog, ACL, body and drift gates",
  ignore: !enabled,
  fn: async () => {
    assertEquals(version, "0020");
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
          await sql`select public.commit_access_observation('d2020202-0000-4000-8000-000000000019','sandbox',${
            token[0]!.token
          }::uuid,${
            sql.json([{ key: "f".repeat(64), product: "still_pro_v3" }])
          }::jsonb)`;
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
      assertEquals(functions.length, 8);
      for (const match of functions) {
        const signature = `${match[1]}(${
          match[2]!
            .split(",")
            .map((arg) => arg.trim().replace(/^\w+\s+/, ""))
            .join(",")
        })`;
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
          bodyDriftDdl(match[0]!),
          "routine_body:",
        );
      }
      for (const match of functions) {
        const name = match[1]!;
        const signature = `${name}(${
          match[2]!.split(",").map((arg) => arg.trim().replace(/^\w+\s+/, ""))
            .join(",")
        })`;
        await negative(
          sql,
          `create function ${name}(boolean) returns boolean language sql security definer set search_path='' as 'select true'; grant execute on function ${name}(boolean) to authenticated`,
          "routine_overload:",
        );
        // Recreate with identical body but wrong result, then rollback. Existing dependents are unchanged.
        const returns = /\)\s*returns\s+(\w+)/i.exec(match[0]!)![1]!;
        const changed = returns === "jsonb" ? "text" : "jsonb";
        await negative(
          sql,
          `drop function ${signature}; ${
            match[0]!.replace(/(\)\s*returns\s+)\w+/i, `$1${changed}`)
          }`,
          "routine_result:",
        );
        await negative(
          sql,
          `drop function ${signature}; create procedure ${
            signature.replace(/\(.*$/, "")
          }(${match[2]}) language plpgsql as 'begin null; end;'`,
          "routine_kind:",
        );
        await negative(
          sql,
          `drop function ${signature}; ${
            match[0]!.replace(/\(\s*\w+/, "(changed_name")
          }`,
          "routine_arg_names:",
        );
      }
      const tables = [
        "apple_access_observations",
        "apple_access_link_operations",
      ];
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
          `grant select (${
            columns[0]!.attname
          }) on private.${table} to authenticated`,
          "column_acl:",
        );
        const checks =
          await sql`select conname,pg_catalog.pg_get_expr(conbin,conrelid) as expression from pg_catalog.pg_constraint where conrelid=${`private.${table}`}::regclass and contype='c' order by conname limit 1`;
        assert(checks.length === 1);
        await negative(
          sql,
          `alter table private.${table} drop constraint ${
            checks[0]!.conname
          }; alter table private.${table} add constraint ${
            checks[0]!.conname
          } check ((${checks[0]!.expression}) or true)`,
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
