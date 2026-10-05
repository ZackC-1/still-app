// Migration 0015 (per-field settings sync) against a real, disposable Supabase database.
//
// Runs only when STILL_U3_MIGRATION_TEST_DATABASE_URL points at the loopback database created for
// the test (a rehearsal on a GitHub-hosted runner, or an explicitly approved local run). A skipped
// run is not evidence. Nothing here is hosted or production evidence.
//
// Modes (STILL_U3_MIGRATION_TEST_MODE):
//   upgrade  `supabase db reset --version 0014`, settings_sync_migration_seed.sql, then
//            `supabase migration up`: proves 0015 preserves rows and that released apps keep
//            syncing the accounts they already use.
//   clean    `supabase db reset` to head; the test seeds the same rows itself.
//
// Client calls go through a real `authenticator` login that switches role as PostgREST does. The
// per-field path logs in as still_settings_writer. The ordinary postgres role (which holds the admin
// option on it) gives it a disposable synthetic login here and removes it again at the end. That
// proves the authority only: production never sends a cleartext password in SQL text (see the
// owner steps in scripts/backend/README.md).
import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import { PgSettingsStore } from "../functions/_shared/pg-settings-store.ts";
import { PgRateLimiter } from "../functions/_shared/pg-store.ts";
import {
  type SettingsStore,
  syncSettings,
} from "../functions/_shared/settings-store.ts";
import { readSettingsOperationRequest } from "../../packages/shared-types/src/settings-operation.ts";
import { connection, write } from "./synthetic_settings_helpers.ts";

const databaseUrl = Deno.env.get("STILL_U3_MIGRATION_TEST_DATABASE_URL");
const mode = Deno.env.get("STILL_U3_MIGRATION_TEST_MODE");
const gatewayPassword = Deno.env.get("STILL_GRANTS_GATEWAY_PASSWORD") ??
  "postgres";
const WRITER_PASSWORD = "u3m-synthetic-settings-writer-only";
const ENTITLEMENT_PASSWORD = "u3m-synthetic-entitlement-writer-only";
const MIGRATION = "0015_settings_sync_per_field.sql";

const CURRENT = "d1d1d1d1-0000-4000-8000-000000000001"; // 2.x document, version 7
const OLDER = "d2d2d2d2-0000-4000-8000-000000000002"; // document without pauses
const MINIMAL = "d3d3d3d3-0000-4000-8000-000000000003"; // {"globalOn":true}
const PAID = "d4d4d4d4-0000-4000-8000-000000000004"; // historical purchase
const EMPTY = "d5d5d5d5-0000-4000-8000-000000000005"; // never saved settings
const RACE = "d6d6d6d6-0000-4000-8000-000000000006"; // created by the test

const WRITER_HELPERS = [
  "private.lock_settings(uuid,uuid,text)",
  "private.claim_settings_write(uuid,uuid,jsonb)",
  "private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb)",
];
const OWNER_HELPERS = [
  "private.cleanup_settings_writes()",
  "private.settings_json_bounded(jsonb)",
  "private.settings_fields()",
  "private.settings_canonical_valid(jsonb,bigint)",
];
const FREE_SYNC = "public.write_profile_settings(jsonb,uuid)";
// Every routine that must search pg_temp last: all functions in private (the non-definer helpers run
// inside the definers) and every SECURITY DEFINER in public. Names as regprocedure prints them.
const PG_TEMP_LAST = [
  "private.claim_settings_write(uuid,uuid,jsonb)",
  "private.cleanup_settings_writes()",
  "private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb)",
  "private.lock_settings(uuid,uuid,text)",
  "private.settings_canonical_valid(jsonb,bigint)",
  "private.settings_fields()",
  "private.settings_json_bounded(jsonb)",
  "claim_revenuecat_event(text,text,jsonb)",
  "cleanup_rate_limit_counters()",
  "complete_revenuecat_event(text,uuid)",
  "consume_rate_limit(text,integer,integer)",
  "get_current_rule_set()",
  "record_revenuecat_event(text,text,jsonb)",
  "release_revenuecat_event(text,uuid)",
  "set_entitlement(uuid,boolean,text,text)",
  "sync_rate_limit_account()",
  "write_profile_settings(jsonb,uuid)",
];
const LIMITER = "public.consume_rate_limit(text,integer,integer)";
const ROLES = [
  "public",
  "anon",
  "authenticated",
  "service_role",
  "still_entitlement_writer",
  "still_settings_writer",
];

const options = { prepare: false, max: 1, onnotice: () => {} } as const;
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type PgError = Error & { code?: string };

async function migrationSource(): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../migrations/${MIGRATION}`, import.meta.url),
  );
}
async function seedSource(): Promise<string> {
  return await Deno.readTextFile(
    new URL("./settings_sync_migration_seed.sql", import.meta.url),
  );
}
/** The migration with exactly one reviewed statement removed: the negative-control mutant. */
/** The migration with exactly one reviewed statement replaced. */
async function replacing(
  statement: string,
  replacement: string,
): Promise<string> {
  const source = await migrationSource();
  assertEquals(
    source.split(statement).length,
    2,
    `statement occurs once: ${statement}`,
  );
  // split/join: String.replace would read the `$$` in a replacement as a pattern.
  return source.split(statement).join(replacement);
}
async function without(statement: string): Promise<string> {
  const source = await migrationSource();
  assertEquals(
    source.split(statement).length,
    2,
    `statement occurs once: ${statement}`,
  );
  return source.replace(statement, "");
}
async function rejection(run: () => Promise<unknown>): Promise<PgError> {
  return (await assertRejects(run)) as PgError;
}

// Every ACL, configuration, body hash, default ACL, membership, writer setting and retention job
// that 0015 can affect, in both schemas it touches.
async function catalogState(sql: Sql | Tx) {
  return (await sql`
    select jsonb_build_object(
      'routines', (select jsonb_agg(jsonb_build_object('routine', p.oid::regprocedure::text,
        'owner', pg_catalog.pg_get_userbyid(p.proowner), 'acl', p.proacl::text,
        'config', p.proconfig, 'definer', p.prosecdef, 'source', md5(p.prosrc))
        order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')),
      'relations', (select jsonb_agg(jsonb_build_object('relation', n.nspname || '.' || c.relname,
        'kind', c.relkind, 'owner', pg_catalog.pg_get_userbyid(c.relowner), 'acl', c.relacl::text,
        'rls', c.relrowsecurity, 'columns', (select jsonb_agg(jsonb_build_object(
          'column', a.attname, 'acl', a.attacl::text) order by a.attnum)
          from pg_catalog.pg_attribute a
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped))
        order by n.nspname, c.relname)
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S', 'i')),
      'defaults', (select jsonb_agg(jsonb_build_object('creator', d.defaclrole::regrole::text,
        'schema', d.defaclnamespace, 'kind', d.defaclobjtype, 'acl', d.defaclacl::text)
        order by d.defaclrole::regrole::text, d.defaclnamespace, d.defaclobjtype)
        from pg_catalog.pg_default_acl d),
      'schemas', (select jsonb_agg(jsonb_build_object('schema', nspname,
        'owner', pg_catalog.pg_get_userbyid(nspowner), 'acl', nspacl::text) order by nspname)
        from pg_catalog.pg_namespace where nspname in ('public', 'private')),
      'memberships', (select jsonb_agg(jsonb_build_object('role', m.roleid::regrole::text,
        'member', m.member::regrole::text, 'admin', m.admin_option,
        'inherit', m.inherit_option, 'set', m.set_option)
        order by m.roleid::regrole::text, m.member::regrole::text)
        from pg_catalog.pg_auth_members m),
      'writer', (select jsonb_build_object('attributes', jsonb_build_array(r.rolsuper, r.rolinherit,
        r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolreplication, r.rolbypassrls),
        'settings', (select s.setconfig from pg_catalog.pg_db_role_setting s
          where s.setrole = r.oid and s.setdatabase = 0))
        from pg_catalog.pg_roles r where r.rolname = 'still_settings_writer'),
      'jobs', (select jsonb_agg(jsonb_build_object('id', j.jobid, 'name', j.jobname,
        'schedule', j.schedule, 'command', j.command, 'user', j.username, 'active', j.active)
        order by j.jobid) from cron.job j)
    ) as state
  `)[0].state;
}

/** The settings row, its retained write identities and its anchor, as plain comparable values. */
async function snapshot(sql: Sql, subject: string) {
  return {
    row: [
      ...await sql`select pg_catalog.row_to_json(p)::text as raw from public.profiles p where id = ${subject}`,
    ],
    identities: [
      ...await sql`select write_id::text, body::text, created_at::text from private.settings_writes where user_id = ${subject} order by write_id`,
    ],
    anchor: [
      ...await sql`select lineage::text, modern_used from private.settings_anchors where user_id = ${subject}`,
    ],
  };
}

Deno.test({
  name:
    "U3-W1: 0015 adds the private per-field path and keeps free sync for released apps",
  ignore: !databaseUrl || !mode,
  async fn(t) {
    assert(mode === "upgrade" || mode === "clean", "mode is upgrade or clean");
    const target = new URL(databaseUrl!);
    assert(
      target.hostname === "127.0.0.1" && target.port === "54322",
      "only the disposable loopback database is accepted",
    );
    const admin = postgres(databaseUrl!, options);
    const gateway = postgres(
      Object.assign(new URL(databaseUrl!), {
        username: "authenticator",
        password: gatewayPassword,
      }).href,
      options,
    );
    const asClient = <T>(
      role: string,
      sub: string | null,
      run: (tx: Tx) => Promise<T>,
    ) =>
      gateway.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${
          JSON.stringify(sub ? { sub, role } : { role })
        }, true)`;
        await tx.unsafe(`set local role ${role}`);
        return await run(tx);
      });
    const legacyWrite = (subject: string, body: unknown, id: string) =>
      asClient(
        "authenticated",
        subject,
        async (tx) =>
          (await tx`select * from public.write_profile_settings(${
            JSON.stringify(body)
          }::text::jsonb, ${id}::uuid)`)[0],
      );
    const opened: { writer: Sql | null } = { writer: null };

    try {
      const preconditions = await t.step(
        "preconditions: ordinary non-superuser postgres applied 0014 and 0015",
        async () => {
          assertEquals(
            (await admin`select current_user::text as role, rolsuper from pg_catalog.pg_roles where rolname = current_user`)[
              0
            ],
            { role: "postgres", rolsuper: false },
          );
          const versions =
            (await admin`select version from supabase_migrations.schema_migrations order by version`)
              .map((r) => r.version);
          for (const required of ["0012", "0013", "0014", "0015"]) {
            assert(versions.includes(required), `${required} applied`);
          }
          assertEquals(
            (await gateway`select session_user::text as login`)[0].login,
            "authenticator",
          );
        },
      );
      if (!preconditions) return;

      await t.step(
        "seeded released-app rows survive byte-for-byte",
        async () => {
          if (mode === "clean") await admin.unsafe(await seedSource());
          const state = (await admin`select * from u3m_fixture.pre_state`)[0];
          // Upgrade proves the seed ran before 0015 created anything; clean is the head state.
          assertEquals(state, {
            private_schema: mode === "clean",
            writer_role: mode === "clean",
          });
          const rows =
            await admin`select f.name, f.digest = b.digest as same from u3m_fixture.fingerprints f full join u3m_fixture.baseline b using (name) order by 1`;
          assertEquals(rows.length, 6);
          for (const row of rows) assertEquals(row.same, true, row.name);
          assertEquals((await admin`select * from u3m_fixture.row_counts`)[0], {
            profiles: 4,
            entitlements: 1,
            rate_limit_counters: 1,
          });
          assertEquals(
            (await admin`select count(*)::int as n from private.settings_anchors`)[
              0
            ].n,
            0,
            "no account is marked as using per-field sync by the migration",
          );
        },
      );

      await t.step(
        "catalog privilege matrix is exactly the intended one",
        async () => {
          const matrix: string[] = [];
          const expected = (role: string, routine: string) => {
            if (WRITER_HELPERS.includes(routine)) {
              return role === "still_settings_writer";
            }
            if (routine === FREE_SYNC) return role === "authenticated";
            if (routine === LIMITER) {
              return role === "still_entitlement_writer" ||
                role === "still_settings_writer";
            }
            return false; // owner-only helpers
          };
          for (
            const routine of [
              ...WRITER_HELPERS,
              ...OWNER_HELPERS,
              FREE_SYNC,
              LIMITER,
            ]
          ) {
            for (const role of ROLES) {
              const allowed =
                (await admin`select has_function_privilege(${role}, ${routine}, 'EXECUTE') as allowed`)[
                  0
                ].allowed;
              matrix.push(`${role} EXECUTE ${routine} = ${allowed}`);
              assertEquals(
                allowed,
                expected(role, routine),
                `${role} ${routine}`,
              );
            }
          }
          for (
            const table of [
              "private.settings_anchors",
              "private.settings_writes",
            ]
          ) {
            for (const role of ROLES) {
              assertEquals(
                (await admin`select has_table_privilege(${role}, ${table}, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_any_column_privilege(${role}, ${table}, 'SELECT,INSERT,UPDATE,REFERENCES') as allowed`)[
                  0
                ].allowed,
                false,
                `${role} ${table}`,
              );
            }
          }
          for (const role of ROLES) {
            assertEquals(
              (await admin`select has_schema_privilege(${role}, 'private', 'USAGE') as usage, has_schema_privilege(${role}, 'private', 'CREATE') as create`)[
                0
              ],
              { usage: role === "still_settings_writer", create: false },
              role,
            );
          }
          assertEquals(
            (await admin`select r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolcanlogin from pg_catalog.pg_roles r where r.rolname = 'still_settings_writer'`)[
              0
            ],
            {
              rolsuper: false,
              rolinherit: false,
              rolcreaterole: false,
              rolcreatedb: false,
              rolbypassrls: false,
              rolcanlogin: false,
            },
            "the migration creates the writer without LOGIN; the secret step adds it",
          );
          assertEquals(
            [
              ...await admin`select m.roleid::regrole::text as role, m.member::regrole::text as member, m.admin_option, m.inherit_option, m.set_option from pg_catalog.pg_auth_members m where m.roleid = 'still_settings_writer'::regrole or m.member = 'still_settings_writer'::regrole`,
            ],
            [{
              role: "still_settings_writer",
              member: "postgres",
              admin_option: true,
              inherit_option: false,
              set_option: false,
            }],
            "only the automatic, non-inheriting CREATEROLE admin membership",
          );
          console.log(JSON.stringify({ u3MigrationPrivilegeMatrix: matrix }));
        },
      );

      await t.step(
        "client roles cannot reach the private schema through the gateway",
        async () => {
          for (
            const [role, sub] of [["anon", null], ["authenticated", CURRENT], [
              "service_role",
              null,
            ]] as const
          ) {
            for (
              const statement of [
                "select * from private.settings_anchors",
                "select * from private.settings_writes",
                `select private.lock_settings('${CURRENT}', gen_random_uuid(), repeat('ab', 32))`,
                `select private.claim_settings_write('${CURRENT}', gen_random_uuid(), '{}')`,
                "select private.cleanup_settings_writes()",
                "select private.settings_fields()",
              ]
            ) {
              const error = await rejection(() =>
                asClient(role, sub, (tx) => tx.unsafe(statement))
              );
              assertEquals(error.code, "42501", `${role}: ${statement}`);
            }
          }
        },
      );

      const writer = await t.step(
        "postgres, as the writer's admin, can add a login (synthetic here; never cleartext in production)",
        async () => {
          await admin.unsafe(
            `alter role still_settings_writer login password '${WRITER_PASSWORD}'`,
          );
          opened.writer = connection(
            databaseUrl!,
            "still_settings_writer",
            WRITER_PASSWORD,
          );
          assertEquals(
            (await opened
              .writer`select session_user::text as login, current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_setting('log_parameter_max_length') as log`)[
                0
              ],
            {
              login: "still_settings_writer",
              statement: "2s",
              lock: "1s",
              log: "0",
            },
          );
          for (
            const statement of [
              "select * from public.profiles",
              "select * from public.entitlements",
              "select * from private.settings_anchors",
              `select * from public.write_profile_settings('{}', gen_random_uuid())`,
              `select public.set_entitlement('${CURRENT}', true, 'forged', null)`,
              "select private.cleanup_settings_writes()",
              "select private.settings_json_bounded('{}')",
            ]
          ) {
            const error = await rejection(() =>
              opened.writer!.unsafe(statement)
            );
            assertEquals(error.code, "42501", statement);
          }
          // The helpers bind the verified subject: another account's claim is refused.
          const mismatch = await rejection(() =>
            opened.writer!.begin(async (tx) => {
              await tx`select set_config('request.jwt.claim.sub', ${OLDER}, true)`;
              await tx`select private.lock_settings(${CURRENT}::uuid, gen_random_uuid(), repeat('ab', 32))`;
            })
          );
          assertEquals(mismatch.code, "28000");
          const limiter = new PgRateLimiter(opened.writer);
          assertEquals(
            await limiter.consume(`settings-sync:user:${CURRENT}`, 5, 600),
            0,
          );
          await assertRejects(() =>
            limiter.consume(`settings-sync-other:user:${CURRENT}`, 5, 600)
          );
        },
      );
      if (!writer) return;
      const store = new PgSettingsStore(opened.writer!);
      const read = async (subject: string) => {
        const result = await syncSettings(store, subject, null);
        assertEquals(result.status, "ready", subject);
        if (result.status !== "ready") throw new Error("read");
        return result;
      };
      const parsed = (request: unknown) => {
        const decoded = readSettingsOperationRequest(request);
        assertEquals(decoded.status, "parsed");
        if (decoded.status !== "parsed") throw new Error("request");
        return decoded.request;
      };

      await t.step(
        "every SECURITY DEFINER in public and private searches pg_temp last",
        async () => {
          // Enumerated from the catalog: any definer added later without the safe form fails here.
          const rows =
            await admin`select p.oid::regprocedure::text as routine, p.proconfig from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and (p.prosecdef or n.nspname = 'private') and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype`;
          assertEquals(
            rows.map((r) => r.routine).sort(),
            [...PG_TEMP_LAST].sort(),
          );
          for (const row of rows) {
            assertEquals(
              row.proconfig,
              ["search_path=pg_catalog, pg_temp"],
              row.routine,
            );
          }
        },
      );

      await t.step(
        "a planted pg_temp type never runs with the owner's rights",
        async () => {
          // A caller's own session may create temporary objects (PUBLIC holds TEMPORARY). Plant
          // domains over the type names the definer bodies use; each CHECK reports who ran it.
          const plant = [
            "create function pg_temp.u3m_probe() returns boolean language plpgsql as $f$ begin raise warning 'u3m-temp-probe ran as %', current_user; return true; end $f$",
            ...["text", "jsonb", "uuid", "bytea", "timestamptz"].map((type) =>
              `create domain pg_temp.${type} as pg_catalog.${type} check (pg_temp.u3m_probe())`
            ),
            // Positive control: the trap is armed for the caller's own casts.
            "select 'armed'::text",
          ];
          type Attempt = { sub: string | null; statement: string };
          async function probe(
            user: string,
            password: string,
            role: string | null,
            attempts: Attempt[],
          ) {
            const notices: string[] = [];
            const sql = postgres(
              Object.assign(new URL(databaseUrl!), { username: user, password })
                .href,
              {
                prepare: false,
                max: 1,
                onnotice: (notice) => notices.push(String(notice.message)),
              },
            );
            try {
              await sql.begin(async (tx) => {
                if (role) await tx.unsafe(`set local role ${role}`);
                for (const statement of plant) await tx.unsafe(statement);
                for (const { sub, statement } of attempts) {
                  // Each call may refuse; its savepoint keeps the session usable. Nothing commits.
                  await tx.savepoint(async (sp) => {
                    await sp`select pg_catalog.set_config('request.jwt.claims', ${
                      JSON.stringify(
                        sub
                          ? { sub, role: role ?? "authenticated" }
                          : { role: role ?? "anon" },
                      )
                    }, true), pg_catalog.set_config('request.jwt.claim.sub', ${
                      sub ?? ""
                    }, true)`;
                    await sp.unsafe(statement);
                  }).catch(() => {});
                }
                throw new Error("rollback temp probe");
              }).catch((error) => {
                if (error.message !== "rollback temp probe") throw error;
              });
            } finally {
              await sql.end();
            }
            return notices;
          }
          const results: Record<string, string[]> = {};
          results.still_settings_writer = await probe(
            "still_settings_writer",
            WRITER_PASSWORD,
            null,
            [
              {
                sub: null,
                statement:
                  `select public.consume_rate_limit('settings-sync:user:${PAID}', 5, 600)`,
              },
              {
                sub: PAID,
                statement:
                  `select private.lock_settings('${PAID}', gen_random_uuid(), repeat('ab', 32))`,
              },
              {
                sub: PAID,
                statement:
                  `select private.claim_settings_write('${PAID}', gen_random_uuid(), '{"probe":true}')`,
              },
              {
                sub: PAID,
                statement:
                  `select private.lock_settings('${PAID}', gen_random_uuid(), repeat('ab', 32)), private.commit_settings('${PAID}', gen_random_uuid(), 1, 'null', '{}', gen_random_uuid(), 0, '[]')`,
              },
            ],
          );
          await admin.unsafe(
            `alter role still_entitlement_writer login password '${ENTITLEMENT_PASSWORD}'`,
          );
          try {
            results.still_entitlement_writer = await probe(
              "still_entitlement_writer",
              ENTITLEMENT_PASSWORD,
              null,
              [
                {
                  sub: null,
                  statement:
                    `select public.set_entitlement('${PAID}', false, 'probe', null)`,
                },
                {
                  sub: null,
                  statement:
                    `select public.record_revenuecat_event('u3m-probe', '${PAID}', '{}')`,
                },
                {
                  sub: null,
                  statement:
                    `select * from public.claim_revenuecat_event('u3m-probe-claim', '${PAID}', '{}')`,
                },
                {
                  sub: null,
                  statement:
                    "select public.complete_revenuecat_event('u3m-probe-claim', gen_random_uuid())",
                },
                {
                  sub: null,
                  statement:
                    "select public.release_revenuecat_event('u3m-probe-claim', gen_random_uuid())",
                },
                {
                  sub: null,
                  statement:
                    `select public.consume_rate_limit('reconcile:user:${PAID}', 5, 600)`,
                },
              ],
            );
          } finally {
            await admin.unsafe(
              "alter role still_entitlement_writer nologin password null",
            );
          }
          for (
            const [role, sub] of [["authenticated", PAID], ["anon", null], [
              "service_role",
              null,
            ]] as const
          ) {
            results[role] = await probe(
              "authenticator",
              gatewayPassword,
              role,
              [
                ...(role === "authenticated"
                  ? [{
                    sub,
                    statement:
                      `select * from public.write_profile_settings('{"globalOn":true}', gen_random_uuid())`,
                  }]
                  : []),
                {
                  sub,
                  statement: "select * from public.get_current_rule_set()",
                },
              ],
            );
          }
          for (const [role, notices] of Object.entries(results)) {
            assert(
              notices.some((n) => n.startsWith("u3m-temp-probe ran as ")),
              `${role}: the planted trap is armed`,
            );
            assertEquals(
              notices.filter((n) => n === "u3m-temp-probe ran as postgres"),
              [],
              `${role}: a planted pg_temp type ran with the owner's rights`,
            );
          }
        },
      );

      await t.step(
        "free sync keeps the 0012 behaviour for accounts that only use released apps",
        async () => {
          // Each case: account, body, expected version. Every body 0012 accepts is still accepted,
          // including minimal and far-future documents; the stored document is the body itself.
          const cases: [string, Record<string, unknown>, number][] = [
            [CURRENT, {
              globalOn: false,
              services: {
                youtube: true,
                instagram: false,
                tiktok: true,
                facebook: true,
              },
              pauses: [],
              updatedAt: 1791000000000,
            }, 8],
            [OLDER, { globalOn: true, extra: { kept: "as sent" } }, 3],
            [MINIMAL, {
              globalOn: false,
              services: {
                youtube: false,
                instagram: false,
                tiktok: false,
                facebook: false,
              },
              pauses: [],
              updatedAt: 9999999999999,
            }, 2],
            [PAID, {
              globalOn: true,
              services: {
                youtube: true,
                instagram: true,
                tiktok: false,
                facebook: true,
              },
              pauses: [],
              updatedAt: 1791000000001,
            }, 13],
            [EMPTY, {
              globalOn: true,
              services: {
                youtube: true,
                instagram: true,
                tiktok: true,
                facebook: true,
              },
              pauses: [],
              updatedAt: 0,
            }, 1],
          ];
          for (const [subject, body, version] of cases) {
            const before =
              (await admin`select settings_server_updated_at from public.profiles where id = ${subject}`)[
                0
              ];
            const id = crypto.randomUUID();
            const row = await legacyWrite(subject, body, id);
            assertEquals(row.settings, body, subject);
            assertEquals(Number(row.settings_version), version, subject);
            assertEquals(row.settings_last_write_id, id, subject);
            if (before) {
              assert(
                row.settings_server_updated_at >
                  before.settings_server_updated_at,
              );
            }
            const stored =
              (await admin`select settings, updated_at = settings_server_updated_at as same_clock from public.profiles where id = ${subject}`)[
                0
              ];
            assertEquals(stored, { settings: body, same_clock: true });
          }
          // 0012 has no write-id deduplication: an exact retry is applied again.
          const id = crypto.randomUUID();
          const body = { globalOn: true };
          const first = await legacyWrite(OLDER, body, id);
          const second = await legacyWrite(OLDER, body, id);
          assertEquals(
            Number(second.settings_version),
            Number(first.settings_version) + 1,
          );
          // Unchanged refusals.
          const nonObject = await rejection(() =>
            legacyWrite(OLDER, [], crypto.randomUUID())
          );
          assertEquals(nonObject.code, "22023");
          for (const role of ["anon", "service_role"]) {
            const error = await rejection(() =>
              asClient(
                role,
                null,
                (tx) =>
                  tx`select * from public.write_profile_settings('{}'::jsonb, gen_random_uuid())`,
              )
            );
            assertEquals(error.code, "42501", role);
          }
          // No per-field state was created by any of this.
          assertEquals(
            (await admin`select count(*)::int as n from private.settings_anchors`)[
              0
            ].n,
            0,
          );
          assertEquals(
            (await admin`select count(*)::int as n from private.settings_writes`)[
              0
            ].n,
            0,
          );
        },
      );

      await t.step(
        "the per-field path reads released-app rows as the account's baseline",
        async () => {
          const current = await read(CURRENT);
          assertEquals(current.settingsVersion, 8);
          assertEquals(current.settings.globalOn, false);
          assertEquals(current.settings.clocks.globalOn, {
            baseRevision: 8,
            localStep: 0,
          });
          assertEquals(current.settings.clocks["sites.youtube.related"], {
            baseRevision: 0,
            localStep: 0,
          });
          // A minimal early document is not silently reinterpreted: the per-field path holds.
          await legacyWrite(OLDER, { globalOn: true }, crypto.randomUUID());
          assertEquals((await syncSettings(store, OLDER, null)).status, "hold");
          // Reading creates the private anchor but no write: the profile is untouched and free
          // sync keeps working for an account that has only been read.
          const before = await snapshot(admin, PAID);
          const paid = await read(PAID);
          const after = await snapshot(admin, PAID);
          assertEquals(after.row, before.row);
          assertEquals(after.anchor.length, 1);
          assertEquals(after.anchor[0].modern_used, false);
          assertEquals(after.anchor[0].lineage, paid.lineage);
          const row = await legacyWrite(
            PAID,
            { globalOn: false },
            crypto.randomUUID(),
          );
          assertEquals(Number(row.settings_version), 14);
        },
      );

      await t.step(
        "after a per-field save, a released app's write is refused and changes nothing",
        async () => {
          const initial = await read(CURRENT);
          const saved = await syncSettings(
            store,
            CURRENT,
            parsed(
              write(
                initial,
                [["sites.youtube.related", true]],
                initial.settingsVersion,
              ),
            ),
          );
          assertEquals(saved.status, "ready");
          if (saved.status !== "ready") throw new Error("save");
          assertEquals(saved.settingsVersion, initial.settingsVersion + 1);
          const before = await snapshot(admin, CURRENT);
          assertEquals(before.anchor[0].modern_used, true);
          const error = await rejection(() =>
            legacyWrite(CURRENT, {
              globalOn: true,
              services: {
                youtube: true,
                instagram: true,
                tiktok: true,
                facebook: true,
              },
              pauses: [],
              updatedAt: Date.now(),
            }, crypto.randomUUID())
          );
          assertEquals(error.code, "40001");
          assertEquals(error.message, "settings client upgrade required");
          assertEquals(await snapshot(admin, CURRENT), before);
          assertEquals(await read(CURRENT), saved);

          // Load-bearing guard: without it the same call overwrites the per-field document.
          const protectedState = await snapshot(admin, CURRENT);
          let mutantAccepted = false;
          const rollback = await rejection(() =>
            admin.begin(async (tx) => {
              const definition =
                (await tx`select pg_catalog.pg_get_functiondef(${FREE_SYNC}::regprocedure) as source`)[
                  0
                ].source as string;
              const mutant = definition.replace(
                /if exists \(select 1 from private\.settings_anchors a[\s\S]*?raise exception 'settings client upgrade required' using errcode = '40001';\n {2}end if;/,
                "",
              );
              assert(mutant !== definition, "guard located");
              await tx.unsafe(mutant);
              await tx`select set_config('request.jwt.claims', ${
                JSON.stringify({ sub: CURRENT, role: "authenticated" })
              }, true)`;
              await tx`set local role authenticated`;
              const rows =
                await tx`select * from public.write_profile_settings('{"globalOn":true}'::jsonb, gen_random_uuid())`;
              assertEquals(rows[0].settings, { globalOn: true });
              mutantAccepted = true;
              throw new Error("synthetic guard mutant rollback");
            })
          );
          assert(mutantAccepted, "the guard is what refuses the write");
          assertEquals(rollback.message, "synthetic guard mutant rollback");
          assertEquals(await snapshot(admin, CURRENT), protectedState);
        },
      );

      await t.step(
        "a document written by a newer client is refused even without an anchor",
        async () => {
          for (
            const [settings, accepted] of [
              [{ schemaVersion: 3, globalOn: true }, false],
              [{ schemaVersion: 2, globalOn: true }, false],
              [{ schemaVersion: 1, globalOn: true }, true],
            ] as const
          ) {
            await admin`update public.profiles set settings = ${
              JSON.stringify(settings)
            }::text::jsonb where id = ${MINIMAL}`;
            const before = await snapshot(admin, MINIMAL);
            assertEquals(before.anchor, []);
            const run = () =>
              legacyWrite(MINIMAL, { globalOn: false }, crypto.randomUUID());
            if (accepted) {
              assertEquals((await run()).settings, { globalOn: false });
            } else {
              const error = await rejection(run);
              assertEquals(error.code, "40001");
              assertEquals(await snapshot(admin, MINIMAL), before);
            }
          }
        },
      );

      await t.step(
        "a released app's write waits for an in-flight per-field save, then is refused",
        async () => {
          await admin`insert into auth.users (id, email) values (${RACE}, 'u3m-race@example.invalid')`;
          const legacyBody = {
            globalOn: true,
            services: {
              youtube: true,
              instagram: true,
              tiktok: true,
              facebook: true,
            },
            pauses: [],
            updatedAt: 1791000000000,
          };
          await legacyWrite(RACE, legacyBody, crypto.randomUUID());
          const original =
            (await admin`select pg_catalog.pg_get_functiondef(${FREE_SYNC}::regprocedure) as source`)[
              0
            ].source as string;
          const catalogBefore = await catalogState(admin);

          // Hold the per-field transaction open after its commit statement, before COMMIT.
          async function race() {
            const initial = await read(RACE);
            let entered!: () => void;
            let release!: () => void;
            const inside = new Promise<void>((resolve) => entered = resolve);
            const resume = new Promise<void>((resolve) => release = resolve);
            const gated: SettingsStore = {
              locked: (subject, work, signal) =>
                store.locked(subject, async (row) => {
                  const result = await work(row);
                  entered();
                  await resume;
                  return result;
                }, signal),
            };
            const saving = syncSettings(
              gated,
              RACE,
              parsed(
                write(
                  initial,
                  [["sites.instagram.reels", false]],
                  initial.settingsVersion,
                ),
              ),
            );
            await inside;
            let outcome: unknown;
            const legacy = legacyWrite(RACE, {
              ...legacyBody,
              globalOn: false,
              updatedAt: legacyBody.updatedAt + 1,
            }, crypto.randomUUID()).then(
              (row) => outcome = row,
              (error) => outcome = error,
            );
            let waited = false;
            try {
              for (let attempt = 0; attempt < 50; attempt++) {
                const waits =
                  await admin`select count(*)::int as n from pg_catalog.pg_stat_activity where usename = 'authenticator' and wait_event_type = 'Lock'`;
                if (waits[0].n > 0) {
                  waited = true;
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            } finally {
              release();
            }
            const saved = await saving;
            await legacy;
            return { waited, saved, outcome };
          }

          const real = await race();
          assert(
            real.waited,
            "the released-app write waited on the account lock",
          );
          assertEquals(real.saved.status, "ready");
          assert(real.outcome instanceof Error);
          assertEquals((real.outcome as PgError).code, "40001");
          const kept =
            (await admin`select settings from public.profiles where id = ${RACE}`)[
              0
            ].settings;
          assertEquals(kept.schemaVersion, 2);
          assertEquals(kept.sites["instagram.reels"], false);

          // Negative control: without the account lock the guard reads the pre-commit state and
          // the released-app write lands on top of the per-field document after it commits.
          await admin`delete from auth.users where id = ${RACE}`;
          await admin`insert into auth.users (id, email) values (${RACE}, 'u3m-race@example.invalid')`;
          await legacyWrite(RACE, legacyBody, crypto.randomUUID());
          const lockLine =
            "  perform 1 from auth.users u where u.id = v_user_id for no key update;\n";
          assertEquals(
            original.split(lockLine).length,
            2,
            "lock statement located",
          );
          try {
            await admin.unsafe(original.replace(lockLine, ""));
            const mutant = await race();
            assertEquals(mutant.saved.status, "ready");
            assert(
              !(mutant.outcome instanceof Error),
              "mutant accepted the write",
            );
            const clobbered =
              (await admin`select settings from public.profiles where id = ${RACE}`)[
                0
              ].settings;
            assertEquals(
              clobbered.schemaVersion,
              undefined,
              "per-field document overwritten",
            );
          } finally {
            await admin.unsafe(original);
          }
          await admin`delete from auth.users where id = ${RACE}`;
          assertEquals(
            await catalogState(admin),
            catalogBefore,
            "mutant fully reverted",
          );
        },
      );

      await t.step(
        "deleting an account removes its anchor and write identities",
        async () => {
          assertEquals(
            (await admin`select count(*)::int as n from private.settings_writes where user_id = ${CURRENT}`)[
              0
            ].n,
            1,
          );
          await admin.begin(async (tx) => {
            await tx`delete from auth.users where id = ${CURRENT}`;
            assertEquals(
              (await tx`select (select count(*)::int from private.settings_anchors where user_id = ${CURRENT}) + (select count(*)::int from private.settings_writes where user_id = ${CURRENT}) as n`)[
                0
              ].n,
              0,
            );
            throw new Error("rollback deletion probe");
          }).catch((error) => {
            if (error.message !== "rollback deletion probe") throw error;
          });
        },
      );

      await t.step("re-applying 0015 as postgres is a no-op", async () => {
        const before = await catalogState(admin);
        const data = {
          anchors: [
            ...await admin`select user_id::text, lineage::text, modern_used from private.settings_anchors order by user_id`,
          ],
          writes: [
            ...await admin`select user_id::text, write_id::text from private.settings_writes order by user_id, write_id`,
          ],
          profiles: [
            ...await admin`select pg_catalog.row_to_json(p)::text as raw from public.profiles p order by id`,
          ],
        };
        await admin.begin(async (tx) => {
          assertEquals(
            (await tx`select current_user::text as role`)[0].role,
            "postgres",
          );
          await tx.unsafe(await migrationSource());
        });
        // The writer's LOGIN (set above, outside the migration) is untouched too.
        assertEquals(await catalogState(admin), before);
        assertEquals({
          anchors: [
            ...await admin`select user_id::text, lineage::text, modern_used from private.settings_anchors order by user_id`,
          ],
          writes: [
            ...await admin`select user_id::text, write_id::text from private.settings_writes order by user_id, write_id`,
          ],
          profiles: [
            ...await admin`select pg_catalog.row_to_json(p)::text as raw from public.profiles p order by id`,
          ],
        }, data);
      });

      await t.step(
        "dropping one of 0015's own revokes or settings makes its self-check abort",
        async () => {
          const before = await catalogState(admin);
          const writerRevoke =
            "revoke all on function private.lock_settings(uuid,uuid,text), private.claim_settings_write(uuid,uuid,jsonb), private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb) from public, anon, authenticated, service_role;";
          const tableRevoke =
            "revoke all on table private.settings_anchors, private.settings_writes\n  from public, anon, authenticated, service_role, still_settings_writer;";
          const limiterRevoke =
            "revoke all on function public.consume_rate_limit(text,integer,integer)\n  from public, anon, authenticated, service_role;";
          const freeSyncRevoke =
            "revoke all on function public.write_profile_settings(jsonb, uuid) from public, anon, service_role;";
          const cases: [string, string, string][] = [
            [
              "grant execute on function private.lock_settings(uuid,uuid,text) to authenticated",
              writerRevoke,
              "private_function_grant:authenticated:private.lock_settings(uuid,uuid,text)",
            ],
            [
              "grant select on private.settings_anchors to service_role",
              tableRevoke,
              "private_relation_grant:settings_anchors",
            ],
            [
              "alter table private.settings_writes disable row level security",
              "alter table private.settings_writes enable row level security;",
              "private_rls_disabled:settings_writes",
            ],
            [
              "alter role still_settings_writer reset log_parameter_max_length",
              "alter role still_settings_writer set log_parameter_max_length = 0;",
              "writer_setting_missing:log_parameter_max_length=0",
            ],
            [
              "grant execute on function public.consume_rate_limit(text,integer,integer) to service_role",
              limiterRevoke,
              "limiter_grantees",
            ],
            [
              "grant execute on function public.write_profile_settings(jsonb,uuid) to anon",
              freeSyncRevoke,
              "free_sync_grantees",
            ],
            [
              "alter function public.set_entitlement(uuid,boolean,text,text) set search_path = ''",
              "alter function public.set_entitlement(uuid, boolean, text, text) set search_path = pg_catalog, pg_temp;",
              "unsafe_search_path:set_entitlement(uuid,boolean,text,text)",
            ],
          ];
          for (const [injection, statement, issue] of cases) {
            // With the statement in place the migration repairs the injected state.
            const repaired = await rejection(() =>
              admin.begin(async (tx) => {
                await tx.unsafe(injection);
                await tx.unsafe(await migrationSource());
                throw new Error("rollback repaired probe");
              })
            );
            assertEquals(
              repaired.message,
              "rollback repaired probe",
              injection,
            );
            // Without it, only the self-check stands between the state and a committed migration.
            const error = await rejection(() =>
              admin.begin(async (tx) => {
                await tx.unsafe(injection);
                await tx.unsafe(await without(statement));
              })
            );
            assertEquals(error.code, "42501", injection);
            assert(
              error.message.startsWith(
                "settings sync privilege self-check failed:",
              ) &&
                error.message.includes(issue),
              `${injection}: ${error.message}`,
            );
          }
          // A replaced definer written with the empty path (what 0014 used) is refused too.
          const mutant = await replacing(
            "returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$",
            "returns jsonb language plpgsql security definer set search_path = '' as $$",
          );
          const emptyPath = await rejection(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(mutant);
            })
          );
          assertEquals(emptyPath.code, "42501");
          assert(
            emptyPath.message.includes(
              "unsafe_search_path:private.lock_settings(uuid,uuid,text)",
            ),
            emptyPath.message,
          );
          assertEquals(await catalogState(admin), before);
        },
      );

      await t.step(
        "the self-check rejects reach that 0015 does not itself remove",
        async () => {
          const before = await catalogState(admin);
          const cases: [string, string][] = [
            [
              "create role u3m_bridge; grant still_settings_writer to u3m_bridge; grant u3m_bridge to authenticated",
              "writer_granted_to:u3m_bridge",
            ],
            [
              "alter role still_settings_writer inherit",
              "writer_attributes",
            ],
            [
              "create function private.u3m_extra() returns int language sql as 'select 1'",
              "private_function_unexpected:private.u3m_extra()",
            ],
            [
              "create table private.u3m_extra (x int)",
              "private_relation_unexpected:u3m_extra",
            ],
            [
              "alter default privileges for role postgres in schema private grant select on tables to anon",
              "private_default:postgres:r",
            ],
            [
              "create function public.u3m_definer() returns void language sql security definer set search_path = '' as 'select'; grant execute on function public.u3m_definer() to authenticated",
              "client_execute:authenticated:u3m_definer()",
            ],
          ];
          for (const [mutation, issue] of cases) {
            const error = await rejection(() =>
              admin.begin(async (tx) => {
                await tx.unsafe(mutation);
                await tx.unsafe(await migrationSource());
              })
            );
            assertEquals(error.code, "42501", mutation);
            assert(
              error.message.startsWith(
                "settings sync privilege self-check failed:",
              ) &&
                error.message.includes(issue),
              `${mutation}: ${error.message}`,
            );
          }
          assertEquals(await catalogState(admin), before);
        },
      );

      await t.step(
        "preconditions refuse another executing role and a drifted free-sync owner before any DDL",
        async () => {
          const before = await catalogState(admin);
          const other = await rejection(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(
                "create role u3m_runner; grant u3m_runner to postgres",
              );
              await tx.unsafe("set local role u3m_runner");
              await tx.unsafe(await migrationSource());
            })
          );
          assertEquals(other.code, "42501");
          assertEquals(
            other.message,
            "settings sync migration role precondition",
          );
          const drift = await rejection(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(
                "create role u3m_owner; grant u3m_owner to postgres; grant create on schema public to u3m_owner",
              );
              await tx.unsafe(
                `alter function ${FREE_SYNC} owner to u3m_owner`,
              );
              await tx.unsafe(await migrationSource());
            })
          );
          assertEquals(drift.code, "42501");
          assertEquals(drift.message, "legacy settings owner precondition");
          assertEquals(await catalogState(admin), before);
        },
      );
    } finally {
      await opened.writer?.end();
      // Return the writer to the migration's state: no LOGIN, no password.
      await admin.unsafe(
        "alter role still_settings_writer nologin password null",
      );
      await gateway.end();
      await admin.end();
    }
  },
});
