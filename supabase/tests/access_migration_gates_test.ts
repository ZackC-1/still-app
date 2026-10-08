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
const stem = "0019_scoped_access_rights";
const source = (path: string) =>
  Deno.readTextFile(new URL(path, import.meta.url));

type Sql = ReturnType<typeof connection>;
type Tx = postgres.TransactionSql;
function verificationIssues(value: unknown): string[] {
  const decoded: unknown = typeof value === "string"
    ? JSON.parse(value)
    : value;
  assert(
    Array.isArray(decoded) && decoded.every((code) => typeof code === "string"),
    "invalid-verification-issues",
  );
  return decoded;
}
function preservedInvariant(value: unknown): string {
  const decoded: unknown = typeof value === "string"
    ? JSON.parse(value)
    : value;
  assert(
    decoded !== null && typeof decoded === "object" && !Array.isArray(decoded),
    "invalid-preservation-invariant",
  );
  return JSON.stringify(decoded);
}
async function issues(tx: Sql | Tx) {
  const rows = await tx.unsafe(
    await source(`../../scripts/backend/deploy/verify/${stem}.sql`),
  );
  return verificationIssues(Object.values(rows[0]!)[0]);
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
    })
  );
  assert(error instanceof Error);
  assertEquals(error.message, "synthetic-rollback");
  assertEquals(await readOnly(sql), []);
}
const fixtureUser = "d2020202-0000-4000-8000-000000000019";
const fixtureOperation = "f1919191-0000-4000-8000-000000000019";
async function seedProfile(tx: Tx) {
  await tx`insert into auth.users(id,email,email_confirmed_at) values(${fixtureUser}::uuid,'access-gate@example.invalid','2026-10-01 12:00:00+00') on conflict(id) do nothing`;
  await tx`insert into public.profiles(id,settings,updated_at,settings_version,settings_server_updated_at,settings_last_write_id)
    values(${fixtureUser}::uuid,'{"globalOn":true,"services":{"youtube":true,"instagram":false,"tiktok":true,"facebook":true},"pauses":[],"updatedAt":1790000000000}',
      '2026-10-01 12:00:00+00',7,'2026-10-01 12:00:00+00','e1919191-0000-4000-8000-000000000019') on conflict(id) do nothing`;
}
async function seedPreservedRows(sql: Sql) {
  await sql.begin(async (tx) => {
    await seedProfile(tx);
    const body = JSON.stringify({
      schema: 1,
      environment: "sandbox",
      revision: 1,
      salesEnabled: true,
      channels: {
        apple: { enabled: true, offer: "still-pro-v3" },
        web: { enabled: false, offer: "still-pro-v3" },
      },
      builds: [{ surface: "apple_mobile_host", build: "synthetic-gate" }],
    });
    const validation =
      await tx`select private.product_policy_body_valid('sales','sandbox',1,${body}) as valid,
      private.product_policy_sales_activates(${body}) as activates,
      encode(sha256(convert_to(concat_ws(E'\n','still-product-policy-preview-1',${fixtureOperation}::text,'apply','sales','sandbox',${fixtureUser}::text,'0','-',
        floor(extract(epoch from '2026-10-01 13:00:00+00'::timestamptz)*1000)::bigint::text,${body}::text),'UTF8')),'hex') as preview_hash`;
    assertEquals(validation[0]?.valid, true);
    assertEquals(validation[0]?.activates, true);
    await tx`insert into public.entitlements(user_id,still_sync,source,revenuecat_subscriber_id,updated_at)
      values(${fixtureUser}::uuid,true,'webhook','synthetic-historical-purchase','2026-10-01 12:00:00+00') on conflict(user_id) do nothing`;
    await tx`insert into private.settings_anchors(user_id,lineage,secret,modern_used)
      values(${fixtureUser}::uuid,'a1919191-0000-4000-8000-000000000019',decode(repeat('19',32),'hex'),true) on conflict(user_id) do nothing`;
    await tx`insert into private.product_policy_owners(user_id) values(${fixtureUser}::uuid) on conflict(user_id) do nothing`;
    await tx`insert into private.product_policy_operations(operation_id,kind,namespace,environment,owner_subject,expected_revision,body,preview_hash,created_at,expires_at,status,applied_revision,applied_at)
      values(${fixtureOperation}::uuid,'apply','sales','sandbox',${fixtureUser}::uuid,0,${body},${
      validation[0]!.preview_hash
    },'2026-10-01 12:00:00+00','2026-10-01 13:00:00+00','applied',1,'2026-10-01 12:01:00+00') on conflict(operation_id) do nothing`;
    await tx`insert into private.product_policy_revisions(namespace,environment,revision,body,operation_id,published_at)
      values('sales','sandbox',1,${body},${fixtureOperation}::uuid,'2026-10-01 12:01:00+00') on conflict(namespace,environment,revision) do nothing`;
    await tx`insert into private.paid_cutoff(environment,product,benefits,sales_revision,operation_id,activated_at)
      values('sandbox','still-sync-v2',array['short-form-blocking'],1,${fixtureOperation}::uuid,'2026-10-01 12:01:00+00') on conflict(environment) do nothing`;
  });
  for (
    const table of [
      "auth.users",
      "public.profiles",
      "public.entitlements",
      "private.settings_anchors",
      "private.product_policy_owners",
      "private.product_policy_operations",
      "private.product_policy_revisions",
      "private.paid_cutoff",
    ]
  ) {
    const rows = await sql.unsafe(
      `select count(*)::int as count from ${table}`,
    );
    assert(
      Number(rows[0]?.count) > 0,
      `nonempty preserved fixture required: ${table}`,
    );
  }
}
async function invariant(sql: Sql | Tx) {
  const rows = await sql.unsafe(
    await source(
      "../../scripts/backend/deploy/verify/0019_scoped_access_rights.invariant.sql",
    ),
  );
  return preservedInvariant(Object.values(rows[0]!)[0]);
}
Deno.test("migration gate JSON columns retain decoded issue and invariant values", () => {
  for (
    const codes of [[], ["migration_version", "check_expression:synthetic"]]
  ) {
    assertEquals(verificationIssues(codes), codes);
    assertEquals(verificationIssues(JSON.stringify(codes)), codes);
  }
  const before = { profiles: 1, profiles_md5: "1".repeat(32) };
  const after = { ...before, profiles_md5: "2".repeat(32) };
  assertEquals(
    preservedInvariant(before),
    preservedInvariant(JSON.stringify(before)),
  );
  assert(preservedInvariant(before) !== preservedInvariant(after));
  for (const invalid of [null, true, 1, {}, [1], ["issue", false]]) {
    assertThrows(
      () => verificationIssues(invalid),
      Error,
      "invalid-verification-issues",
    );
  }
  for (const invalid of [null, true, 1, []]) {
    assertThrows(
      () => preservedInvariant(invalid),
      Error,
      "invalid-preservation-invariant",
    );
  }
});
Deno.test({
  name: "exact access migration catalog, ACL, body and drift gates",
  ignore: !enabled,
  fn: async () => {
    assert(version === "0019");
    assert(mode === "pre" || mode === "post");
    const sql = connection(target!);
    try {
      if (mode === "pre") {
        const priorIssues = await readOnly(sql);
        assert(priorIssues.includes("migration_version"));
        assertEquals(priorIssues.includes("unexpected_later_migration"), false);
        // A nonempty preserved account/legacy row fixture prevents a vacuous upgrade comparison.
        await seedPreservedRows(sql);

        return;
      }
      assertEquals(await readOnly(sql), []);
      const migration = await source(`../migrations/${stem}.sql`);
      const functions = [
        ...migration.matchAll(
          /create(?: or replace)? function\s+([\w.]+)\s*\((.*?)\).*?as \$\$(.*?)\$\$;/gis,
        ),
      ];
      assertEquals(functions.length, 4);
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
          `alter function ${signature} strict`,
          "routine_behavior:",
        );
        await negative(
          sql,
          `alter function ${signature} stable`,
          "routine_behavior:",
        );
        await negative(
          sql,
          match[0]!
            .replace(/^create function/i, "create or replace function")
            .replace(/\$\$;$/, () => "\n-- body drift control\n$$;"),
          "routine_body:",
        );
      }
      const commit = functions.find((match) =>
        match[1] === "public.commit_access_observation"
      )!;
      await negative(
        sql,
        "drop function public.commit_access_observation(uuid,text,uuid,jsonb); " +
          commit[0]!.replace(/returns jsonb/i, "returns text"),
        "routine_result:",
      );
      await negative(
        sql,
        "drop function public.confirm_access_observation(uuid,text,uuid); create procedure public.confirm_access_observation(p_holder uuid,p_environment text,p_token uuid) language plpgsql as $$ begin null; end; $$;",
        "routine_behavior:",
      );
      await negative(
        sql,
        "alter table private.access_rights drop constraint access_rights_environment_provider_key_key",
        "missing_constraint:",
      );
      await negative(
        sql,
        "alter table private.access_rights drop constraint access_rights_holder_fkey; alter table private.access_rights add constraint access_rights_holder_fkey foreign key(holder) references auth.users(id) on delete cascade",
        "missing_constraint:",
      );
      await negative(
        sql,
        "alter table private.access_rights alter column ownership_revision set default 1",
        "column_default:",
      );
      await negative(
        sql,
        "grant select on private.access_rights to public",
        "table_acl:",
      );
      await negative(
        sql,
        "grant still_entitlement_writer to authenticated",
        "client_writer_reach",
      );
      await negative(
        sql,
        "grant authenticated to still_entitlement_writer",
        "writer_membership",
      );
      await negative(
        sql,
        "create role access_gate_owner nologin; grant access_gate_owner to postgres; grant usage,create on schema private to access_gate_owner; alter table private.access_rights owner to access_gate_owner",
        "table_owner:",
      );
      await negative(
        sql,
        "create role access_gate_owner nologin; grant access_gate_owner to postgres; grant usage,create on schema public to access_gate_owner; alter function public.begin_access_observation(uuid,text) owner to access_gate_owner",
        "routine_owner:",
      );
      const tables = [
        "access_observations",
        "access_rights",
        "access_revocations",
        "access_transfer_operations",
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
      const preserved = await invariant(sql);
      const changed = await assertRejects(() =>
        sql.begin(async (tx) => {
          // Clean post mode stays clean for the later RLS suite; this fixture rolls back.
          await seedProfile(tx);
          const beforeChange = await invariant(tx);
          await tx`update public.profiles set settings='{"syntheticDrift":true}' where id=${fixtureUser}::uuid`;
          assert(
            (await invariant(tx)) !== beforeChange,
            "row-value drift must change the preservation fingerprint",
          );
          throw new Error("synthetic-rollback");
        })
      );
      assert(changed instanceof Error);
      assertEquals(changed.message, "synthetic-rollback");
      assert(
        await invariant(sql) === preserved,
        "preserved-row-invariant-changed",
      );
    } finally {
      await sql.end();
    }
  },
});

async function blockedBy(sql: Sql, pid: number, blocker: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row =
      await sql`select ${blocker}::int=any(pg_catalog.pg_blocking_pids(${pid}::int)) as blocked`;
    if (row[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("expected database lock barrier was not reached");
}
async function advisoryWait(sql: Sql, pid: number, key: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row =
      await sql`select exists(select 1 from pg_catalog.pg_locks where pid=${pid}::int and locktype='advisory' and objid=${key}::oid and not granted) as blocked`;
    if (row[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("expected advisory lock barrier was not reached");
}
function capture(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
Deno.test({
  name:
    "0019 overlapping absence and foreign snapshots avoid the old lock-order deadlock",
  ignore: !enabled || mode !== "post",
  fn: async (t) => {
    assertEquals(version, "0019");
    const sql = connection(target!),
      a = connection(target!),
      b = connection(target!);
    const migration = await source(
      "../migrations/0019_scoped_access_rights.sql",
    );
    const commit = [
      ...migration.matchAll(
        /create function\s+public\.commit_access_observation\s*\(.*?as \$\$.*?\$\$;/gis,
      ),
    ][0]?.[0];
    assert(commit);
    const reviewed = commit.replace(
      /^create function/i,
      "create or replace function",
    );
    const lockStart = reviewed.indexOf("  -- Lock or insert one sorted union");
    const bodyStart = reviewed.indexOf(
      "    if stored.holder is distinct from p_holder",
      lockStart,
    );
    assert(lockStart > 0 && bodyStart > lockStart);
    // Controls restore the earlier listed-only loop, with or without the former existing-row prelock.
    const listedLoop =
      `  -- Insert missing identities in the same key order; foreign/deleted owners stay unchanged.
  for item in select value from jsonb_array_elements(p_snapshot) order by value->>'key' loop
    insert into private.access_rights(environment, provider_key, provider_product, holder, active, verified_at)
      values(p_environment, item->>'key', item->>'product', p_holder, true, v_verified)
      on conflict(environment, provider_key) do nothing;
    select * into stored from private.access_rights
      where environment = p_environment and provider_key = item->>'key' for update;
`;
    const oldOrder = reviewed.slice(0, lockStart) + listedLoop +
      reviewed.slice(bodyStart);
    const prelockOrder = reviewed.slice(0, lockStart) +
      `  perform r.right_id from private.access_rights r
    where r.environment = p_environment and (r.holder = p_holder
      or exists(select 1 from jsonb_array_elements(p_snapshot) s where s->>'key' = r.provider_key))
    order by r.provider_key for update;
` + listedLoop + reviewed.slice(bodyStart);
    const barrier =
      "  insert into private.access_revocations(holder, environment, right_id, revision)";
    assertEquals(reviewed.split(barrier).length, 2);
    const A = "a1919191-0000-4000-8000-000000000001",
      B = "b1919191-0000-4000-8000-000000000002";
    const X = "1".repeat(64), Z = "f".repeat(64);
    try {
      await sql`insert into auth.users(id,email,email_confirmed_at) values(${A}::uuid,'lock-a@example.invalid',clock_timestamp()),(${B}::uuid,'lock-b@example.invalid',clock_timestamp())`;
      for (const appearing of [false, true]) {
        for (const control of [false, true]) {
          await t.step(
            `${appearing ? "mid-call row appearance" : "owned-row absence"}: ${
              control ? "earlier order yields 40P01" : "sorted union succeeds"
            }`,
            async () => {
              await sql`delete from private.access_revocations where right_id in (select right_id from private.access_rights where environment='sandbox' and provider_key in (${X},${Z}))`;
              await sql`delete from private.access_rights where environment='sandbox' and provider_key in (${X},${Z})`;
              if (!appearing) {
                await sql`insert into private.access_rights(environment,provider_key,provider_product,holder,active,verified_at) values('sandbox',${X},'still_pro_v3',${A}::uuid,true,1000)`;
              }
              // Test-only barriers make the exact SQL race deterministic. Every variant is restored.
              let variant = control
                ? (appearing ? prelockOrder : oldOrder)
                : reviewed;
              if (appearing) {
                const loopMarker = control
                  ? "  -- Insert missing identities"
                  : "  for v_key in";
                variant = variant.replace(
                  loopMarker,
                  `  if p_holder = '${B}'::uuid then perform pg_catalog.pg_advisory_xact_lock(1919002); end if;
  if p_holder = '${A}'::uuid and jsonb_array_length(p_snapshot) = 2 then perform pg_catalog.pg_advisory_xact_lock(1919003); end if;
` + loopMarker,
                ).replace(
                  "  end loop;\n" + barrier,
                  `    if p_holder = '${B}'::uuid and stored.provider_key = '${X}' then perform pg_catalog.pg_advisory_xact_lock(1919004); end if;
  end loop;\n` + barrier,
                );
              } else {
                variant = variant.replace(
                  barrier,
                  "  perform pg_catalog.pg_advisory_xact_lock(1919001);\n" +
                    barrier,
                );
              }
              await sql.unsafe(variant);
              const tokenA =
                (await sql`select public.begin_access_observation(${A}::uuid,'sandbox') as token`)[
                  0
                ]!.token;
              const tokenB =
                (await sql`select public.begin_access_observation(${B}::uuid,'sandbox') as token`)[
                  0
                ]!.token;
              const gate = await sql.reserve(),
                left = await a.reserve(),
                right = await b.reserve();
              const pending: ReturnType<typeof capture>[] = [];
              try {
                const gatePid = Number(
                  (await gate`select pg_catalog.pg_backend_pid() as pid`)[0]!
                    .pid,
                );
                const leftPid = Number(
                  (await left`select pg_catalog.pg_backend_pid() as pid`)[0]!
                    .pid,
                );
                const rightPid = Number(
                  (await right`select pg_catalog.pg_backend_pid() as pid`)[0]!
                    .pid,
                );
                for (
                  const key of appearing
                    ? [1919002, 1919003, 1919004]
                    : [1919001]
                ) {
                  await gate`select pg_catalog.pg_advisory_lock(${key}::bigint)`;
                }
                const run = async (
                  session: typeof left,
                  holder: string,
                  token: unknown,
                  keys: string[],
                ) => {
                  await session.unsafe("begin");
                  try {
                    await session.unsafe("set local statement_timeout='10s'");
                    const result =
                      await session`select public.commit_access_observation(${holder}::uuid,'sandbox',${
                        String(token)
                      }::uuid,${
                        session.json(
                          keys.map((key) => ({ key, product: "still_pro_v3" })),
                        )
                      }::jsonb) as result`;
                    await session.unsafe("commit");
                    return result;
                  } catch (error) {
                    await session.unsafe("rollback");
                    throw error;
                  }
                };
                if (appearing) {
                  pending.push(capture(run(right, B, tokenB, [X, Z])));
                  await advisoryWait(sql, rightPid, 1919002); // B has not inserted; the former prelock saw no rows.
                  await run(left, A, tokenA, [Z]); // Actual A commit creates the higher row mid-call.
                  const nextTokenA =
                    (await sql`select public.begin_access_observation(${A}::uuid,'sandbox') as token`)[
                      0
                    ]!.token;
                  pending.push(capture(run(left, A, nextTokenA, [X, Z])));
                  await advisoryWait(sql, leftPid, 1919003); // Former prelock holds Z; union has no premature lock.
                  await gate`select pg_catalog.pg_advisory_unlock(1919002)`;
                  await advisoryWait(sql, rightPid, 1919004); // B now owns the newly inserted lower X.
                  await gate`select pg_catalog.pg_advisory_unlock(1919003)`;
                  await blockedBy(sql, leftPid, rightPid); // A waits for lower X; old prelock still holds Z.
                  await gate`select pg_catalog.pg_advisory_unlock(1919004)`;
                } else {
                  pending.push(capture(run(left, A, tokenA, [Z])));
                  await blockedBy(sql, leftPid, gatePid); // A has inserted Z; old order has not locked X.
                  pending.push(capture(run(right, B, tokenB, [X, Z])));
                  await blockedBy(sql, rightPid, leftPid); // Old B owns X and waits Z; union B waits X.
                  await gate`select pg_catalog.pg_advisory_unlock(1919001)`;
                }
                const outcomes = await Promise.all(pending);
                if (control) {
                  assert(
                    outcomes.some((result) =>
                      !result.ok && result.error &&
                      typeof result.error === "object" &&
                      "code" in result.error && result.error.code === "40P01"
                    ),
                    "old ordering must reproduce the exact PostgreSQL deadlock",
                  );
                } else {
                  assert(
                    outcomes.every((result) => result.ok),
                    "sorted union must complete both transactions",
                  );
                  const rows =
                    await sql`select provider_key,holder,active,ownership_revision from private.access_rights where environment='sandbox' and provider_key in (${X},${Z}) order by provider_key`;
                  assertEquals(
                    rows.map(
                      (row) => [
                        row.provider_key,
                        row.holder,
                        row.active,
                        Number(row.ownership_revision),
                      ],
                    ),
                    appearing
                      ? [[X, B, true, 0], [Z, A, true, 0]]
                      : [[X, A, false, 1], [Z, A, true, 0]],
                  );
                }
              } finally {
                await gate`select pg_catalog.pg_advisory_unlock_all()`;
                await Promise.all(pending);
                left.release();
                right.release();
                gate.release();
                await sql.unsafe(reviewed);
              }
            },
          );
        }
      }
      assertEquals(await readOnly(sql), []);
    } finally {
      await sql.unsafe(reviewed);
      await sql`delete from private.access_revocations where right_id in (select right_id from private.access_rights where environment='sandbox' and provider_key in (${X},${Z}))`;
      await sql`delete from private.access_rights where environment='sandbox' and provider_key in (${X},${Z})`;
      await sql`delete from auth.users where id in (${A}::uuid,${B}::uuid)`;
      await a.end();
      await b.end();
      await sql.end();
    }
  },
});
