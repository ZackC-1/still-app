// Migration 0014 (server RPC privilege hardening) against a real, disposable Supabase database.
//
// Runs only when STILL_GRANTS_TEST_DATABASE_URL points at a loopback database created for the
// test (the security rehearsal on a GitHub-hosted runner, or an explicitly approved local run).
// A skipped run is not evidence. Nothing here is hosted or production evidence.
//
// Modes (STILL_GRANTS_TEST_MODE):
//   upgrade  `supabase db reset --version 0013`, server_rpc_grants_seed.sql, then
//            `supabase migration up`: proves the upgrade preserves rows and closes the old grants.
//   clean    `supabase db reset` to head; the test seeds the same rows itself.
//
// Client calls go through a real `authenticator` login that switches role exactly as PostgREST
// does, so session_user is never the database owner and the in-function guard is exercised.
import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import {
  PgEntitlementStore,
  PgRateLimiter,
} from "../functions/_shared/pg-store.ts";
import { handleReconcile } from "../functions/reconcile-entitlement/handler.ts";
import { handleWebhook } from "../functions/revenuecat-webhook/handler.ts";
import {
  mintHs256,
  TEST_EXPECTED_CLAIMS,
} from "../functions/_shared/test-helpers.ts";

const databaseUrl = Deno.env.get("STILL_GRANTS_TEST_DATABASE_URL");
const mode = Deno.env.get("STILL_GRANTS_TEST_MODE");
// Supabase's local images give `authenticator` the database password. Override if that changes.
const gatewayPassword = Deno.env.get("STILL_GRANTS_GATEWAY_PASSWORD") ??
  "postgres";

const A = "a1a1a1a1-0000-4000-8000-000000000001"; // historical paid entitlement
const B = "b2b2b2b2-0000-4000-8000-000000000002"; // free-era account, entitlement false
const C = "c3c3c3c3-0000-4000-8000-000000000003"; // account with no rows at all
const WRITER_PASSWORD = "u1a-synthetic-writer-only";
const OTHER_PASSWORD = "u1a-synthetic-other-login-only";
const JWT_SECRET = "u1a-synthetic-jwt-secret-long-enough-for-tests";

const SERVER_RPCS = [
  "public.set_entitlement(uuid,boolean,text,text)",
  "public.record_revenuecat_event(text,text,jsonb)",
  "public.claim_revenuecat_event(text,text,jsonb)",
  "public.complete_revenuecat_event(text,uuid)",
  "public.release_revenuecat_event(text,uuid)",
];
const RATE_LIMIT_RPC = "public.consume_rate_limit(text,integer,integer)";
const OWNER_ONLY = [
  "public.cleanup_rate_limit_counters()",
  "public.sync_rate_limit_account()",
];
const FREE_SYNC = "public.write_profile_settings(jsonb,uuid)";
const RULE_READ = "public.get_current_rule_set()";
const TABLES = [
  "profiles",
  "entitlements",
  "revenuecat_events",
  "rule_sets",
  "rate_limit_counters",
  "rate_limit_window_keys",
  "canary_state",
];
const ROLES = [
  "public",
  "anon",
  "authenticated",
  "service_role",
  "still_entitlement_writer",
];
const WRITE_PRIVILEGES =
  "INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN";

const options = { prepare: false, max: 1, onnotice: () => {} } as const;
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type PgError = Error & { code?: string };

function connect(user: string, password: string): Sql {
  const target = new URL(databaseUrl!);
  target.username = user;
  target.password = password;
  return postgres(target.href, options);
}

async function migrationSource(): Promise<string> {
  return await Deno.readTextFile(
    new URL(
      "../migrations/0014_server_rpc_privilege_hardening.sql",
      import.meta.url,
    ),
  );
}

async function seedSource(): Promise<string> {
  return await Deno.readTextFile(
    new URL("./server_rpc_grants_seed.sql", import.meta.url),
  );
}

/** Await a rejection and return its SQLSTATE and message. */
async function rejection(run: () => Promise<unknown>): Promise<PgError> {
  return (await assertRejects(run)) as PgError;
}

// Every ACL, configuration, body hash, default ACL and membership this migration can affect.
async function catalogState(sql: Sql | Tx) {
  return (await sql`
    select jsonb_build_object(
      'routines', (select jsonb_agg(jsonb_build_object('routine', p.oid::regprocedure::text,
        'owner', pg_catalog.pg_get_userbyid(p.proowner), 'acl', p.proacl::text,
        'config', p.proconfig, 'definer', p.prosecdef, 'language', l.lanname,
        'source', md5(p.prosrc)) order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        join pg_catalog.pg_language l on l.oid = p.prolang where n.nspname = 'public'),
      'relations', (select jsonb_agg(jsonb_build_object('relation', c.relname,
        'owner', pg_catalog.pg_get_userbyid(c.relowner), 'acl', c.relacl::text,
        'rls', c.relrowsecurity, 'columns', (select jsonb_agg(jsonb_build_object(
          'column', a.attname, 'acl', a.attacl::text) order by a.attnum)
          from pg_catalog.pg_attribute a
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped))
        order by c.relname)
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')),
      'defaults', (select jsonb_agg(jsonb_build_object('schema', d.defaclnamespace,
        'kind', d.defaclobjtype, 'acl', d.defaclacl::text)
        order by d.defaclnamespace, d.defaclobjtype)
        from pg_catalog.pg_default_acl d where d.defaclrole = 'postgres'::regrole),
      'schema', (select nspacl::text from pg_catalog.pg_namespace where nspname = 'public'),
      'memberships', (select jsonb_agg(jsonb_build_object('role', m.roleid::regrole::text,
        'member', m.member::regrole::text, 'admin', m.admin_option,
        'inherit', m.inherit_option, 'set', m.set_option)
        order by m.roleid::regrole::text, m.member::regrole::text)
        from pg_catalog.pg_auth_members m)
    ) as state
  `)[0].state;
}

Deno.test({
  name: "U1-A: 0014 closes server RPCs and table writes, keeps free sync",
  ignore: !databaseUrl || !mode,
  async fn(t) {
    assert(mode === "upgrade" || mode === "clean", "mode is upgrade or clean");
    const target = new URL(databaseUrl!);
    assert(
      ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname),
      "only a disposable loopback database is accepted",
    );
    const admin = postgres(databaseUrl!, options);
    const gateway = connect("authenticator", gatewayPassword);
    const writer = connect("still_entitlement_writer", WRITER_PASSWORD);
    const extra: { other: Sql | null } = { other: null };

    // PostgREST-equivalent client transaction: authenticator switches role, claims set locally.
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
    const clientCases: [string, string | null][] = [
      ["anon", null],
      ["authenticated", A], // own account
      ["authenticated", B], // a signed-in account acting on another account (A)
      ["service_role", null],
    ];
    const serverCalls = (subject: string) => [
      `select public.set_entitlement('${subject}', true, 'forged', 'forged')`,
      `select public.record_revenuecat_event('u1a-forged-record', '${subject}', '{}')`,
      `select * from public.claim_revenuecat_event('u1a-forged-claim', '${subject}', '{}')`,
      "select public.complete_revenuecat_event('u1a-evt-processing', gen_random_uuid())",
      "select public.release_revenuecat_event('u1a-evt-processing', gen_random_uuid())",
    ];

    try {
      const preconditions = await t.step(
        "preconditions: ordinary non-superuser owner, expected migration history",
        async () => {
          assertEquals(
            (await admin`select current_user::text as role, rolsuper from pg_catalog.pg_roles where rolname = current_user`)[
              0
            ],
            { role: "postgres", rolsuper: false },
            "migrations are applied by the ordinary postgres role, not a superuser",
          );
          assertEquals(
            (await gateway`select session_user::text as login`)[0].login,
            "authenticator",
          );
          const versions =
            (await admin`select version from supabase_migrations.schema_migrations order by version`)
              .map((r) => r.version);
          assertEquals(versions.length, 14);
          assertEquals(versions.at(-1), "0014");
          if (mode === "clean") await admin.unsafe(await seedSource());
          await admin.unsafe(
            `alter role still_entitlement_writer login password '${WRITER_PASSWORD}'`,
          );
        },
      );
      if (!preconditions) return;

      await t.step(
        "upgrade preserves every seeded row byte-for-byte",
        async () => {
          const rows =
            await admin`select f.name, f.digest = b.digest as same from u1a_fixture.fingerprints f full join u1a_fixture.baseline b using (name) order by 1`;
          assertEquals(rows.length, 8);
          for (const row of rows) assertEquals(row.same, true, row.name);
          assertEquals(
            (await admin`select * from u1a_fixture.row_counts`)[0],
            {
              entitlements: 2,
              profiles: 2,
              revenuecat_events: 3,
              rate_limit_counters: 2,
              canary_state: 2,
            },
            "the comparison covers real rows in every table",
          );
          if (mode === "upgrade") {
            // The seed captured the 0013 grants: the local baseline reproduces the hosted hole.
            const before =
              await admin`select rolname, sig, can_execute from u1a_fixture.pre_privileges order by 1, 2`;
            for (const row of before) {
              if (SERVER_RPCS.includes(row.sig)) {
                assertEquals(
                  row.can_execute,
                  true,
                  `0013 baseline ${row.rolname} ${row.sig}`,
                );
              }
            }
            const tableWrites =
              await admin`select rolname, relname, can_write from u1a_fixture.pre_table_writes where rolname = 'anon' and relname in ('entitlements', 'revenuecat_events', 'rule_sets', 'canary_state')`;
            assertEquals(tableWrites.length, 4);
            for (const row of tableWrites) {
              assertEquals(
                row.can_write,
                true,
                `0013 baseline anon write ${row.relname}`,
              );
            }
          }
        },
      );

      await t.step(
        "catalog privilege matrix is exactly the intended one",
        async () => {
          const matrix: string[] = [];
          const expectFunction = (role: string, routine: string) => {
            if ([...SERVER_RPCS, RATE_LIMIT_RPC].includes(routine)) {
              return role === "still_entitlement_writer";
            }
            if (routine === FREE_SYNC) return role === "authenticated";
            if (routine === RULE_READ) {
              return ["anon", "authenticated", "service_role"].includes(role);
            }
            return false; // owner-only helpers
          };
          for (
            const routine of [
              ...SERVER_RPCS,
              RATE_LIMIT_RPC,
              ...OWNER_ONLY,
              FREE_SYNC,
              RULE_READ,
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
                expectFunction(role, routine),
                `${role} ${routine}`,
              );
            }
          }
          const clientRoles = [
            "public",
            "anon",
            "authenticated",
            "still_entitlement_writer",
          ];
          for (const table of TABLES) {
            const relation = `public.${table}`;
            for (const role of clientRoles) {
              const { write, column_write, read } = (await admin`
              select has_table_privilege(${role}, ${relation}, ${WRITE_PRIVILEGES}) as write,
                has_any_column_privilege(${role}, ${relation}, 'INSERT,UPDATE,REFERENCES') as column_write,
                has_table_privilege(${role}, ${relation}, 'SELECT') as read`)[
                0
              ];
              matrix.push(
                `${role} ${table} write=${
                  write || column_write
                } select=${read}`,
              );
              assertEquals(write, false, `${role} write ${table}`);
              assertEquals(
                column_write,
                false,
                `${role} column write ${table}`,
              );
              const expectedRead =
                (table === "profiles" && role === "authenticated") ||
                (["revenuecat_events", "rule_sets"].includes(table) &&
                  ["anon", "authenticated"].includes(role));
              assertEquals(read, expectedRead, `${role} select ${table}`);
            }
          }
          for (
            const [column, expected] of [
              ["user_id", true],
              ["still_sync", true],
              ["source", false],
              ["revenuecat_subscriber_id", false],
              ["updated_at", false],
            ] as const
          ) {
            assertEquals(
              (await admin`select has_column_privilege('authenticated', 'public.entitlements', ${column}, 'SELECT') as allowed`)[
                0
              ].allowed,
              expected,
              `authenticated entitlements.${column}`,
            );
            assertEquals(
              (await admin`select has_column_privilege('anon', 'public.entitlements', ${column}, 'SELECT') as allowed`)[
                0
              ].allowed,
              false,
            );
          }
          // Server paths that use the service-role key keep their table access.
          for (const table of ["profiles", "entitlements", "canary_state"]) {
            assertEquals(
              (await admin`select has_table_privilege('service_role', ${`public.${table}`}, 'SELECT,INSERT,UPDATE') as allowed`)[
                0
              ].allowed,
              true,
              `service_role ${table}`,
            );
          }
          for (const role of ["public", "anon", "authenticated"]) {
            assertEquals(
              (await admin`select has_schema_privilege(${role}, 'public', 'CREATE') as allowed`)[
                0
              ].allowed,
              false,
            );
          }
          const unpinned =
            await admin`select p.oid::regprocedure::text as routine from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and not coalesce(p.proconfig @> array['search_path=""'], false)`;
          assertEquals(
            unpinned.map((r) => r.routine),
            [],
            "every public SECURITY DEFINER pins search_path",
          );
          console.error(`U1-A ${mode} privilege matrix\n${matrix.join("\n")}`);
        },
      );

      await t.step(
        "future objects created by postgres are not client-reachable",
        async () => {
          const rollback = new Error("rollback future-object probe");
          const failure = await assertRejects(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(
                "create function public.u1a_future_rpc() returns boolean language sql security definer set search_path = '' as 'select true'; create table public.u1a_future_table(payload text); create sequence public.u1a_future_sequence",
              );
              for (const role of ["anon", "authenticated"]) {
                const row = (await tx`
                select has_function_privilege(${role}, 'public.u1a_future_rpc()', 'EXECUTE') as fn,
                  has_table_privilege(${role}, 'public.u1a_future_table', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as tbl,
                  has_sequence_privilege(${role}, 'public.u1a_future_sequence', 'USAGE,SELECT,UPDATE') as seq`)[
                  0
                ];
                assertEquals(row, { fn: false, tbl: false, seq: false }, role);
              }
              throw rollback;
            })
          );
          assertEquals(failure, rollback);
        },
      );

      await t.step(
        "anon, own-account and other-account JWTs and service_role cannot run any server RPC",
        async () => {
          const before =
            await admin`select name, digest from u1a_fixture.fingerprints order by 1`;
          for (const [role, sub] of clientCases) {
            for (
              const statement of [
                ...serverCalls(A),
                `select public.consume_rate_limit('reconcile:user:${A}', 10, 60)`,
              ]
            ) {
              const error = await rejection(() =>
                asClient(role, sub, (tx) => tx.unsafe(statement))
              );
              assertEquals(error.code, "42501", `${role}/${sub}: ${statement}`);
              assert(
                error.message.includes("permission denied for function"),
                `${role}: ${statement}: ${error.message}`,
              );
            }
          }
          assertEquals(
            await admin`select name, digest from u1a_fixture.fingerprints order by 1`,
            before,
            "no denied call changed any row",
          );
        },
      );

      await t.step(
        "direct client table writes fail for anon and signed-in accounts",
        async () => {
          const inserts: Record<string, string> = {
            profiles:
              `insert into public.profiles (id, settings) values ('${C}', '{}')`,
            entitlements:
              `insert into public.entitlements (user_id, still_sync) values ('${C}', true)`,
            revenuecat_events:
              `insert into public.revenuecat_events (event_id, app_user_id, payload) values ('u1a-direct', '${A}', '{}')`,
            rule_sets:
              `insert into public.rule_sets (version, payload, signature) values ('9.9.9', '{}', '{}')`,
            rate_limit_counters:
              `insert into public.rate_limit_counters (bucket_key, window_start, window_seconds, expires_at, count) values ('x', now(), 60, now(), 1)`,
            rate_limit_window_keys:
              `insert into public.rate_limit_window_keys (window_start, window_seconds, secret, expires_at) values (now(), 60, '\\x00', now())`,
            canary_state:
              `insert into public.canary_state (key) values ('u1a-direct')`,
          };
          const firstColumn: Record<string, string> = {
            profiles: "settings",
            entitlements: "still_sync",
            revenuecat_events: "status",
            rule_sets: "is_current",
            rate_limit_counters: "count",
            rate_limit_window_keys: "secret",
            canary_state: "num",
          };
          const before =
            await admin`select name, digest from u1a_fixture.fingerprints order by 1`;
          for (
            const [role, sub] of [["anon", null], ["authenticated", A], [
              "authenticated",
              B,
            ]] as const
          ) {
            for (const table of TABLES) {
              for (
                const statement of [
                  inserts[table],
                  // PostgREST sessions load pg-safeupdate, which demands a WHERE clause.
                  `update public.${table} set ${firstColumn[table]} = ${
                    firstColumn[table]
                  } where true`,
                  `delete from public.${table} where true`,
                  `truncate public.${table}`,
                ]
              ) {
                const error = await rejection(() =>
                  asClient(role, sub, (tx) => tx.unsafe(statement))
                );
                assertEquals(error.code, "42501", `${role}: ${statement}`);
              }
            }
          }
          assertEquals(
            await admin`select name, digest from u1a_fixture.fingerprints order by 1`,
            before,
          );
        },
      );

      await t.step(
        "client reads stay own-row, column-limited and zero-row as intended",
        async () => {
          await asClient("authenticated", A, async (tx) => {
            assertEquals(
              (await tx`select id from public.profiles`).map((r) => r.id),
              [A],
            );
            assertEquals(
              (await tx`select user_id, still_sync from public.entitlements`)
                .map((r) => [r.user_id, r.still_sync]),
              [[A, true]],
            );
            assertEquals(
              (await tx`select count(*)::int as n from public.revenuecat_events`)[
                0
              ].n,
              0,
            );
            assertEquals(
              (await tx`select count(*)::int as n from public.rule_sets`)[0].n,
              0,
            );
          });
          for (
            const [role, sub, statement] of [
              [
                "authenticated",
                A,
                "select revenuecat_subscriber_id from public.entitlements",
              ],
              ["authenticated", A, "select source from public.entitlements"],
              ["authenticated", A, "select * from public.canary_state"],
              ["authenticated", A, "select * from public.rate_limit_counters"],
              [
                "authenticated",
                A,
                "select * from public.rate_limit_window_keys",
              ],
              ["anon", null, "select * from public.profiles"],
              ["anon", null, "select still_sync from public.entitlements"],
            ] as const
          ) {
            const error = await rejection(() =>
              asClient(role, sub, (tx) => tx.unsafe(statement))
            );
            assertEquals(error.code, "42501", `${role}: ${statement}`);
          }
        },
      );

      await t.step(
        "free sync works for every signed-in account and nobody else",
        async () => {
          for (const [subject, expectedVersion] of [[B, 2], [C, 1]] as const) {
            const row = await asClient(
              "authenticated",
              subject,
              async (tx) =>
                (await tx`select * from public.write_profile_settings('{"globalOn":true}'::jsonb, gen_random_uuid())`)[
                  0
                ],
            );
            assertEquals(
              Number(row.settings_version),
              expectedVersion,
              subject,
            );
            assertEquals(row.settings, { globalOn: true });
          }
          // A free-era account (B) and an account with no entitlement row (C) both synced.
          assertEquals(
            (await admin`select still_sync from public.entitlements where user_id = ${B}`)[
              0
            ].still_sync,
            false,
          );
          assertEquals(
            (await admin`select count(*)::int as n from public.entitlements where user_id = ${C}`)[
              0
            ].n,
            0,
          );
          await asClient("authenticated", B, async (tx) => {
            assertEquals(
              (await tx`select id from public.profiles`).map((r) => r.id),
              [B],
            );
          });
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
          for (
            const [role, sub] of [["anon", null], ["authenticated", A], [
              "service_role",
              null,
            ]] as const
          ) {
            assertEquals(
              await asClient(
                role,
                sub,
                async (tx) =>
                  (await tx`select count(*)::int as n from public.get_current_rule_set()`)[
                    0
                  ].n,
              ),
              1,
              `${role} reads the current rule set`,
            );
          }
          // export-user-data and selector-canary paths (service-role key) still read and write.
          await asClient("service_role", null, async (tx) => {
            assertEquals(
              (await tx`select count(*)::int as n from public.profiles`)[0].n,
              3,
            );
            assertEquals(
              (await tx`select count(*)::int as n from public.entitlements`)[0]
                .n,
              2,
            );
            await tx`insert into public.canary_state (key, num) values ('svc:youtube', 3) on conflict (key) do update set num = excluded.num`;
            throw new Error("rollback canary probe");
          }).catch((error) => {
            if (error.message !== "rollback canary probe") throw error;
          });
        },
      );

      await t.step(
        "defense in depth: a regressed EXECUTE grant still fails inside the function",
        async () => {
          const before = await catalogState(admin);
          const grantTargets = "anon, authenticated, service_role";
          try {
            // Reproduce the pre-0014 hosted grants after the migration, then call through PostgREST roles.
            for (const routine of SERVER_RPCS) {
              await admin.unsafe(
                `grant execute on function ${routine} to ${grantTargets}`,
              );
            }
            await admin.unsafe(
              `create role u1a_other_login login password '${OTHER_PASSWORD}'`,
            );
            for (const routine of SERVER_RPCS) {
              await admin.unsafe(
                `grant execute on function ${routine} to u1a_other_login`,
              );
            }
            extra.other = connect("u1a_other_login", OTHER_PASSWORD);
            const fingerprints =
              await admin`select name, digest from u1a_fixture.fingerprints order by 1`;
            for (const [role, sub] of clientCases) {
              for (const statement of serverCalls(A)) {
                const error = await rejection(() =>
                  asClient(role, sub, (tx) => tx.unsafe(statement))
                );
                assertEquals(error.code, "42501", `${role}: ${statement}`);
                assertEquals(
                  error.message,
                  "server role required",
                  `${role}: ${statement}`,
                );
              }
            }
            // An unrelated login with a direct grant is refused too: the guard is an allowlist.
            for (const statement of serverCalls(A)) {
              const error = await rejection(() =>
                extra.other!.unsafe(statement)
              );
              assertEquals(error.code, "42501");
              assertEquals(error.message, "server role required");
            }
            assertEquals(
              await admin`select name, digest from u1a_fixture.fingerprints order by 1`,
              fingerprints,
            );
          } finally {
            await extra.other?.end();
            extra.other = null;
            for (const routine of SERVER_RPCS) {
              await admin.unsafe(
                `revoke execute on function ${routine} from ${grantTargets}`,
              );
            }
            await admin.unsafe(
              "do $$ begin if exists (select 1 from pg_roles where rolname = 'u1a_other_login') then revoke all on function public.set_entitlement(uuid,boolean,text,text), public.record_revenuecat_event(text,text,jsonb), public.claim_revenuecat_event(text,text,jsonb), public.complete_revenuecat_event(text,uuid), public.release_revenuecat_event(text,uuid) from u1a_other_login; drop role u1a_other_login; end if; end $$",
            );
          }
          assertEquals(
            await catalogState(admin),
            before,
            "injection fully reverted",
          );
        },
      );

      await t.step(
        "the narrow writer still grants, logs, claims and limits",
        async () => {
          const store = new PgEntitlementStore(writer);
          const limiter = new PgRateLimiter(writer);
          assertEquals(
            (await writer`select session_user::text as login`)[0].login,
            "still_entitlement_writer",
          );
          // Seeded event states survive with their semantics.
          assertEquals(
            (await store.claimEvent("u1a-evt-completed", A, {})).status,
            "duplicate",
          );
          assertEquals(
            (await store.claimEvent("u1a-evt-legacy", A, {})).status,
            "duplicate",
          );
          assertEquals(
            (await store.claimEvent("u1a-evt-processing", A, {})).status,
            "in_flight",
          );
          // claim -> release -> re-claim -> complete -> duplicate.
          const first = await store.claimEvent("u1a-evt-new", C, {
            type: "TEST",
          });
          assertEquals(first.status, "claimed");
          await store.releaseEvent("u1a-evt-new", first.token!);
          const second = await store.claimEvent("u1a-evt-new", C, {
            type: "TEST",
          });
          assertEquals(second.status, "claimed");
          await store.completeEvent("u1a-evt-new", second.token!);
          assertEquals(
            (await store.claimEvent("u1a-evt-new", C, {})).status,
            "duplicate",
          );
          assertEquals(
            (await writer`select public.record_revenuecat_event('u1a-evt-record', ${C}, '{}') as inserted`)[
              0
            ].inserted,
            true,
          );
          assertEquals(await limiter.consume(`reconcile:user:${C}`, 10, 60), 0);
          // The writer still has no direct table access.
          for (
            const statement of [
              "select * from public.entitlements",
              "select * from public.revenuecat_events",
              "update public.profiles set settings = settings",
            ]
          ) {
            const error = await rejection(() => writer.unsafe(statement));
            assertEquals(error.code, "42501", statement);
          }
        },
      );

      await t.step(
        "reconcile handler writes only the JWT subject through the writer",
        async () => {
          const store = new PgEntitlementStore(writer);
          const limiter = new PgRateLimiter(writer);
          const rc = {
            getSubscriber: () =>
              Promise.resolve({
                entitlements: { still_sync: { expires_date: null } },
                original_app_user_id: C,
              }),
          };
          const deps = {
            jwtSecret: JWT_SECRET,
            expected: TEST_EXPECTED_CLAIMS,
            store,
            rc,
            limiter,
          };
          const request = (token: string) =>
            new Request("https://synthetic.invalid", {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              body: JSON.stringify({ userId: B }),
            });
          const entitlementB =
            await admin`select to_jsonb(e) as row from public.entitlements e where user_id = ${B}`;
          assertEquals(
            (await handleReconcile(
              request(await mintHs256({ sub: C }, JWT_SECRET)),
              deps,
            )).status,
            200,
          );
          assertEquals(
            (await admin`select still_sync from public.entitlements where user_id = ${C}`)[
              0
            ].still_sync,
            true,
          );
          assertEquals(
            await admin`select to_jsonb(e) as row from public.entitlements e where user_id = ${B}`,
            entitlementB,
          );
          for (
            const claims of [{ sub: C, exp: 1000 }, { sub: C, role: "anon" }]
          ) {
            assertEquals(
              (await handleReconcile(
                request(await mintHs256(claims, JWT_SECRET)),
                deps,
              )).status,
              401,
            );
          }
        },
      );

      await t.step(
        "RevenueCat webhook path claims, projects and deduplicates",
        async () => {
          const store = new PgEntitlementStore(writer);
          let lookups = 0;
          const rc = {
            getSubscriber: () => {
              lookups++;
              return Promise.resolve({
                entitlements: {},
                original_app_user_id: A,
              });
            },
          };
          const request = (token: string) =>
            new Request("https://synthetic.invalid", {
              method: "POST",
              headers: { Authorization: token },
              body: JSON.stringify({
                event: {
                  id: "u1a-webhook",
                  type: "EXPIRATION",
                  app_user_id: A,
                },
              }),
            });
          const deps = { token: "u1a-synthetic-token", store, rc };
          assertEquals(
            (await handleWebhook(request("wrong"), deps)).status,
            401,
          );
          assertEquals(lookups, 0);
          assertEquals(
            (await handleWebhook(request("u1a-synthetic-token"), deps)).status,
            200,
          );
          assertEquals(
            (await handleWebhook(request("u1a-synthetic-token"), deps)).status,
            200,
          );
          assertEquals(lookups, 1);
          assertEquals(
            (await admin`select status from public.revenuecat_events where event_id = 'u1a-webhook'`)[
              0
            ].status,
            "completed",
          );
          assertEquals(
            (await admin`select still_sync from public.entitlements where user_id = ${A}`)[
              0
            ].still_sync,
            false,
          );
        },
      );

      await t.step("re-applying 0014 as postgres is a no-op", async () => {
        const before = await catalogState(admin);
        await admin.begin(async (tx) => {
          assertEquals(
            (await tx`select current_user::text as role`)[0].role,
            "postgres",
          );
          await tx.unsafe(await migrationSource());
        });
        assertEquals(await catalogState(admin), before);
      });

      await t.step(
        "the migration self-check rejects client reach it does not itself remove",
        async () => {
          const before = await catalogState(admin);
          // Each state is something 0014's own statements leave in place, so only the final
          // self-check can catch it. Every probe rolls back.
          const cases: [string, string][] = [
            [
              "create function public.u1a_extra_rpc() returns void language sql security definer set search_path = '' as 'select'; grant execute on function public.u1a_extra_rpc() to anon",
              "client_execute:anon:u1a_extra_rpc()",
            ],
            [
              "grant still_entitlement_writer to authenticated with inherit false, set true",
              "client_execute:still_entitlement_writer:set_entitlement(",
            ],
            [
              "create role u1a_bridge; grant insert on public.entitlements to u1a_bridge; grant u1a_bridge to authenticated",
              "client_write:u1a_bridge:entitlements",
            ],
            [
              "create role u1a_bridge; grant select (source) on public.entitlements to u1a_bridge; grant u1a_bridge to anon",
              "client_read:u1a_bridge:entitlements.source",
            ],
            [
              "create role u1a_bridge; alter default privileges for role postgres in schema public grant execute on functions to u1a_bridge; grant u1a_bridge to anon",
              "postgres_public_schema_default",
            ],
            [
              "create function public.u1a_unpinned() returns void language sql security definer as 'select'; revoke all on function public.u1a_unpinned() from public",
              "unpinned_search_path:u1a_unpinned()",
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
                "server RPC privilege self-check failed:",
              ) && error.message.includes(issue),
              `${mutation}: ${error.message}`,
            );
          }
          assertEquals(await catalogState(admin), before);
        },
      );
    } finally {
      await extra.other?.end();
      await writer.end();
      await gateway.end();
      await admin.end();
    }
  },
});
