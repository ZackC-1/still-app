// Migration 0018 (account-level analytics erasure: the delete-user pre-step) against a real,
// disposable Supabase database.
//
// Runs only when STILL_U5W3_ERASURE_TEST_DATABASE_URL points at a loopback database created for the
// test (a rehearsal on a GitHub-hosted runner, or an explicitly approved local disposable stack). A
// skipped run is not evidence. Nothing here is hosted or production evidence.
//
// Modes (STILL_U5W3_ERASURE_TEST_MODE):
//   pre-upgrade  the database is exactly at 0017 with analytics_account_erasure_migration_seed.sql
//                loaded: the post-apply check reports exactly the missing end state, and the existing
//                rows (erasure rows included) are fingerprinted for the upgrade run.
//   upgrade      then 0018 is applied: proves every existing row survived, then everything below.
//   clean        a database reset to head; the test seeds the same rows itself.
//
// GoTrue's own deletion path. The role path (GoTrue's database role, supabase_auth_admin, deleting
// the account) always runs. The HTTP path (GoTrue's admin endpoint, through the real delete-user
// handler and the real account store) runs only when STILL_U5W3_AUTH_URL and
// STILL_U5W3_AUTH_SERVICE_KEY name a loopback stack that includes GoTrue; it is reported as ignored
// otherwise.
//
// Design tests: T1 capture before delete (each layer alone suffices), T2 the gap, T3 GoTrue's path,
// T4 idempotence, T5 concurrency, T6 grants, T7 linkability, T8 upgrade safety, T9 nothing to
// capture, T10 0017's snapshot unchanged. Each has a negative control. Every account and id is
// synthetic.
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import { handleDeleteUser } from "../functions/delete-user/handler.ts";
import { PgErasureStore } from "../functions/_shared/erasure-store.ts";
import { signHs256 } from "../functions/_shared/jwt.ts";
import { SupabaseUserStore } from "../functions/_shared/supabase-store.ts";
import { fromHex, proofFromKey, toHex } from "../../packages/core/src/analytics/derive.ts";

const databaseUrl = Deno.env.get("STILL_U5W3_ERASURE_TEST_DATABASE_URL");
const mode = Deno.env.get("STILL_U5W3_ERASURE_TEST_MODE");
const authUrl = Deno.env.get("STILL_U5W3_AUTH_URL");
const authServiceKey = Deno.env.get("STILL_U5W3_AUTH_SERVICE_KEY");
const gatewayPassword = Deno.env.get("STILL_GRANTS_GATEWAY_PASSWORD") ?? "postgres";
const ERASER_PASSWORD = "u5w3-synthetic-eraser-only";
const JWT_SECRET = "u5w3-synthetic-erasure-jwt-secret-32-chars";
const MIGRATION = "0018_analytics_account_erasure.sql";
/** 0017's pin of its snapshot function's body. */
const SNAPSHOT_MD5 = "5bbbec70399c1ac78f1eb39255c418c2";

const NEW_ROUTES = [
  "private.analytics_begin_account_erasure(uuid,text)",
  "private.analytics_account_erasure_status(uuid)",
];
const OTHER_ROLES = [
  "public",
  "anon",
  "authenticated",
  "service_role",
  "still_entitlement_writer",
  "still_settings_writer",
  "still_policy_reader",
  "still_policy_admin",
];
const SEEDED_JOBS = [71, 72, 73, 74, 75].map((n) => `e7e7e7e7-0000-4000-8000-0000000000${n}`);
const TEST_EMAIL = (tag: string) => `u5w3-t-${tag}@example.invalid`;

// Synthetic devices: erasure keys built at runtime, unique per n (its four low bytes lead the key);
// each device's identify proof is SHA-256(key).
const deviceKey = (n: number) =>
  toHex(new Uint8Array(32).map((_, i) => (i < 4 ? (n >>> (8 * i)) & 255 : (i * 11 + 5) % 256)));
const proof = async (n: number) => await proofFromKey(fromHex(deviceKey(n)));
/** A synthetic account id, distinct per tag number. */
const account = (n: number) => `c8c8c8c8-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type PgError = Error & { code?: string };

/** Loopback only, the fixed database name; never a hosted target. */
function connect(user?: string, password?: string): Sql {
  const parsed = new URL(databaseUrl!);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/postgres") {
    throw new Error("Disposable loopback database required");
  }
  if (user) parsed.username = user;
  if (password) parsed.password = password;
  return postgres(parsed.href, { prepare: false, max: 1, onnotice: () => {} });
}

const read = (path: string) => Deno.readTextFile(new URL(path, import.meta.url));
const migrationSource = () => read(`../migrations/${MIGRATION}`);
const verificationSource = () => read("../../scripts/backend/deploy/verify/0018_analytics_account_erasure.sql");
const invariantSource = () => read("../../scripts/backend/deploy/verify/0018_analytics_account_erasure.invariant.sql");
const seedSource = () => read("./analytics_account_erasure_migration_seed.sql");

async function verifyIn(tx: Sql | Tx): Promise<string[]> {
  const rows = await tx.unsafe(await verificationSource());
  return JSON.parse(String(Object.values(rows[0])[0]));
}
async function verify(sql: Sql): Promise<string[]> {
  return await sql.begin(async (tx) => {
    await tx`set transaction read only`;
    return await verifyIn(tx);
  });
}
/** The migration with each statement (which must occur exactly once) removed. */
async function without(...statements: string[]): Promise<string> {
  let source = await migrationSource();
  for (const statement of statements) {
    assertEquals(source.split(statement).length, 2, `statement occurs once: ${statement.slice(0, 80)}`);
    source = source.split(statement).join("");
  }
  return source;
}
async function replacing(statement: string, replacement: string): Promise<string> {
  const source = await migrationSource();
  assertEquals(source.split(statement).length, 2, `statement occurs once: ${statement.slice(0, 80)}`);
  return source.split(statement).join(replacement);
}
/** The text of `source` from `start` up to and including the next `end`. */
function slice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert(from >= 0, start);
  const to = source.indexOf(end, from);
  assert(to > from, end);
  return source.slice(from, to + end.length);
}
async function rejection(run: () => Promise<unknown>): Promise<PgError> {
  return (await assertRejects(run)) as PgError;
}
/** Run `probe` in a transaction that is always rolled back; return what it reported. */
async function rolledBack<T>(sql: Sql, probe: (tx: Tx) => Promise<T>): Promise<T> {
  let seen: { value: T } | null = null;
  const error = await rejection(() =>
    sql.begin(async (tx) => {
      seen = { value: await probe(tx) };
      throw new Error("rollback probe");
    })
  );
  assertEquals(error.message, "rollback probe", error.message);
  return seen!.value;
}

/** Every row 0018 could conceivably touch, as text, for the upgrade comparison (T8). */
async function fingerprints(sql: Sql | Tx): Promise<string> {
  const rows = await sql`
    select pg_catalog.jsonb_build_object(
      'users', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(u.id, u.email) order by u.id) from auth.users u),
      'profiles', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.id) from public.profiles p),
      'entitlements', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.user_id) from public.entitlements e),
      'anchors', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.user_id, a.lineage, pg_catalog.md5(a.secret), a.modern_used) order by a.user_id) from private.settings_anchors a),
      'subjects', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) order by s.subject_id) from private.analytics_subjects s),
      'jobs', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(j) order by j.job_id) from private.analytics_erasure_jobs j),
      'targets', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.job_id, t.distinct_id) from private.analytics_erasure_targets t),
      'rule_sets', (select pg_catalog.count(*) from public.rule_sets),
      'revenuecat_events', (select pg_catalog.count(*) from public.revenuecat_events)
    )::text as state`;
  return rows[0].state;
}
async function catalogState(sql: Sql | Tx) {
  return (await sql`
    select pg_catalog.jsonb_build_object(
      'routines', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('routine', p.oid::regprocedure::text,
        'acl', p.proacl::text, 'config', p.proconfig, 'definer', p.prosecdef, 'source', pg_catalog.md5(p.prosrc))
        order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')),
      'relations', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('relation', n.nspname || '.' || c.relname,
        'acl', c.relacl::text, 'rls', c.relrowsecurity) order by n.nspname, c.relname)
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S', 'i')),
      'constraints', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(k.conrelid::regclass::text, k.conname,
        pg_catalog.pg_get_constraintdef(k.oid)) order by k.conrelid::regclass::text, k.conname)
        from pg_catalog.pg_constraint k where k.connamespace = 'private'::regnamespace),
      'triggers', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(t.tgname, t.tgenabled, t.tgtype,
        t.tgfoid::regprocedure::text) order by t.tgname)
        from pg_catalog.pg_trigger t where t.tgrelid = 'private.analytics_subjects'::regclass and not t.tgisinternal),
      'schemas', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('schema', nspname, 'acl', nspacl::text)
        order by nspname) from pg_catalog.pg_namespace where nspname in ('public', 'private'))
    ) as state`)[0].state;
}
async function jwt(subject: string) {
  return await signHs256({
    sub: subject,
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 300,
  }, JWT_SECRET);
}

Deno.test({
  name: "U5-W3: before 0018, its post-apply check reports exactly the missing end state",
  ignore: !databaseUrl || mode !== "pre-upgrade",
  async fn() {
    const admin = connect();
    try {
      const versions = (await admin`select version from supabase_migrations.schema_migrations order by version`)
        .map((r) => r.version);
      assertEquals(versions.at(-1), "0017", "the database is exactly at 0017");
      assertEquals(await verify(admin), [
        // 0018 replaces 0017's device erasure (ordered row locks), so 0017's body reads as changed.
        "erasure_function_body_changed:private.analytics_begin_device_erasure(bytea,integer)",
        ...NEW_ROUTES.map((r) => `erasure_function_missing:${r}`).sort(),
        "erasure_scope_check",
        "erasure_target_index",
        "migration_missing:0018",
        "subject_retired_reason_check",
      ]);
      // The seed's erasure rows are present: the upgrade must keep every one of them.
      assertEquals(
        (await admin`select pg_catalog.count(*)::int as n from private.analytics_erasure_jobs
          where job_id = any(${`{${SEEDED_JOBS.join(",")}}`}::uuid[])`)[0].n,
        SEEDED_JOBS.length,
      );
      await admin.unsafe("create schema if not exists u5w3_fixture");
      await admin.unsafe("create table if not exists u5w3_fixture.before(state text not null)");
      await admin`truncate u5w3_fixture.before`;
      const state = await fingerprints(admin);
      await admin`insert into u5w3_fixture.before(state) values (${state})`;
    } finally {
      await admin.end();
    }
  },
});

Deno.test({
  name: "U5-W3: 0018 records an account's identities for deletion before the account goes",
  ignore: !databaseUrl || (mode !== "upgrade" && mode !== "clean"),
  async fn(t) {
    const admin = connect();
    const gateway = connect("authenticator", gatewayPassword);
    const auth = connect("supabase_auth_admin", gatewayPassword);
    let eraser: Sql | null = null;
    let eraser2: Sql | null = null;
    const asClient = <T>(role: string, run: (tx: Tx) => Promise<T>) =>
      gateway.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role })}, true)`;
        await tx.unsafe(`set local role ${role}`);
        return await run(tx);
      });
    try {
      const preconditions = await t.step("preconditions: ordinary non-superuser postgres applied 0017 and 0018", async () => {
        assertEquals(
          (await admin`select current_user::text as role, rolsuper from pg_catalog.pg_roles where rolname = current_user`)[0],
          { role: "postgres", rolsuper: false },
        );
        const versions = (await admin`select version from supabase_migrations.schema_migrations order by version`)
          .map((r) => r.version);
        for (const required of ["0017", "0018"]) assert(versions.includes(required), `${required} applied`);
      });
      if (!preconditions) return;

      if (mode === "upgrade") {
        await t.step("T8: every existing row survived the upgrade, erasure rows included", async () => {
          const before = (await admin`select state from u5w3_fixture.before`)[0]?.state;
          assert(before, "the pre-upgrade run recorded fingerprints");
          assertEquals(await fingerprints(admin), before);
          await admin.unsafe("drop schema u5w3_fixture cascade");
        });
      } else {
        await admin.unsafe(await seedSource());
      }

      await t.step("the deploy runner's post-apply check reports no open issue", async () => {
        assertEquals(await verify(admin), []);
        const invariant = await admin.begin(async (tx) => {
          await tx`set transaction read only`;
          return Object.values((await tx.unsafe(await invariantSource()))[0])[0];
        });
        assert(String(invariant).includes('"private.analytics_subjects"'));
      });

      await t.step("re-applying 0018 changes nothing", async () => {
        const before = await catalogState(admin);
        const rows = await fingerprints(admin);
        await admin.begin(async (tx) => void await tx.unsafe(await migrationSource()));
        assertEquals(await catalogState(admin), before);
        assertEquals(await fingerprints(admin), rows);
      });

      await t.step("T8: the widened checks accept the new values and nothing else", async () => {
        const accepted = await rolledBack(admin, async (tx) => {
          await tx`insert into private.analytics_subjects(subject_id, user_id, origin_key, epoch, created_at,
              last_activity_month, retired_at, retired_reason)
            values (gen_random_uuid(), 'c7c7c7c7-0000-4000-8000-000000000072', extensions.gen_random_bytes(32), 0, now(),
                    current_date, now(), 'account_erasure'),
                   (gen_random_uuid(), 'c7c7c7c7-0000-4000-8000-000000000072', extensions.gen_random_bytes(32), 0, now(),
                    current_date, now(), 'account_deleted')`;
          await tx`insert into private.analytics_erasure_jobs(job_id, scope, scope_key, stage, sweeps, attempts, priority,
              next_attempt_at, created_at)
            values (gen_random_uuid(), 'account', extensions.gen_random_bytes(32), 'stop_recorded', 0, 0, 2, now(), now())`;
          return true;
        });
        assert(accepted);
        // NEGATIVE CONTROL: an unknown reason or scope is still refused.
        for (
          const statement of [
            `insert into private.analytics_subjects(subject_id, user_id, origin_key, epoch, created_at, last_activity_month,
               retired_at, retired_reason) values (gen_random_uuid(), 'c7c7c7c7-0000-4000-8000-000000000072',
               extensions.gen_random_bytes(32), 0, now(), current_date, now(), 'bogus')`,
            `insert into private.analytics_erasure_jobs(job_id, scope, scope_key, stage, sweeps, attempts, priority,
               next_attempt_at, created_at) values (gen_random_uuid(), 'bogus', extensions.gen_random_bytes(32),
               'stop_recorded', 0, 0, 2, now(), now())`,
          ]
        ) {
          assertEquals((await rejection(() => admin.unsafe(statement))).code, "23514", statement);
        }
      });

      await t.step("T6 and T10: dropping one of 0018's protections, or changing 0017's snapshot, makes the self-check abort", async () => {
        const before = await catalogState(admin);
        const source = await migrationSource();
        const schemaRevoke = "revoke all on all functions in schema private from public, anon, authenticated, service_role;";
        const routeRevoke = slice(source, "revoke all on function private.analytics_begin_account_erasure(uuid, text),", ";");
        const widen = slice(source, "-- ── 1. Widen two checks", "end\n$$;");
        const index = slice(source, "create index if not exists analytics_erasure_targets_distinct", ";");
        const snapshot = "create or replace function private.analytics_snapshot_deleted_subject()\nreturns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$\n" +
          "declare\n  moment timestamptz := pg_catalog.now();\n  job_ref uuid := pg_catalog.gen_random_uuid();\nbegin\n" +
          "  insert into private.analytics_erasure_jobs(job_id, scope, scope_key, stage, sweeps, attempts, priority,\n" +
          "                                             next_attempt_at, created_at)\n" +
          "    values (job_ref, 'account_deleted', extensions.gen_random_bytes(32), 'stop_recorded', 0, 0, 1, moment, moment);\n" +
          "  insert into private.analytics_erasure_targets(job_id, distinct_id, kind)\n    values (job_ref, old.subject_id, 'subject');\n" +
          "  return null;\nend $$";
        const cases: [string, string[], string][] = [
          [
            "grant execute on function private.analytics_begin_account_erasure(uuid,text) to authenticated",
            [schemaRevoke, routeRevoke],
            "client_execute:authenticated:private.analytics_begin_account_erasure(uuid,text)",
          ],
          [
            "grant execute on function private.analytics_account_erasure_status(uuid) to service_role",
            [schemaRevoke, routeRevoke],
            "client_execute:service_role:private.analytics_account_erasure_status(uuid)",
          ],
          [
            "alter table private.analytics_subjects drop constraint analytics_subjects_retired_reason_check; " +
            "alter table private.analytics_subjects add constraint narrow_reason check (retired_reason in ('device_erasure'))",
            [widen],
            "subject_retired_reason_check",
          ],
          [
            "alter table private.analytics_erasure_jobs drop constraint analytics_erasure_jobs_scope_check; " +
            "alter table private.analytics_erasure_jobs add constraint narrow_scope check (scope in ('device', 'account_deleted'))",
            [widen],
            "erasure_scope_check",
          ],
          ["drop index private.analytics_erasure_targets_distinct", [index], "erasure_target_index"],
        ];
        for (const [injection, statements, issue] of cases) {
          // With the statement present the migration repairs the injection...
          await rolledBack(admin, async (tx) => {
            await tx.unsafe(injection);
            await tx.unsafe(source);
          });
          // ...and without it the self-check refuses.
          const error = await rejection(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(injection);
              await tx.unsafe(await without(...statements));
            })
          );
          assertEquals(error.code, "42501", injection);
          assert(
            error.message.startsWith("analytics account erasure self-check failed:") && error.message.includes(issue),
            `${injection}: ${error.message}`,
          );
        }
        // 0018 never re-creates 0017's snapshot, so an injection there is refused even by the whole file.
        const refusedWhole: [string, string][] = [
          ["alter table private.analytics_subjects enable trigger analytics_subjects_snapshot", "subject_snapshot_trigger"],
          ["drop trigger analytics_subjects_snapshot on private.analytics_subjects", "requires 0017"],
          [snapshot, "subject_snapshot_function"],
          ["alter function private.analytics_snapshot_deleted_subject() security invoker", "subject_snapshot_function"],
          [
            "grant execute on function private.read_product_policy(text,text) to still_analytics_eraser",
            "eraser_execute:private.read_product_policy(text,text)",
          ],
          // P3-4: the eraser role 0017 set up is re-pinned (limits, log redaction, attributes).
          ["alter role still_analytics_eraser set lock_timeout = '5s'", "role_setting_missing:still_analytics_eraser:lock_timeout=1s"],
          ["alter role still_analytics_eraser reset statement_timeout", "role_setting_missing:still_analytics_eraser:statement_timeout=2s"],
          [
            "alter role still_analytics_eraser reset log_parameter_max_length_on_error",
            "role_setting_missing:still_analytics_eraser:log_parameter_max_length_on_error=0",
          ],
          ["alter role still_analytics_eraser inherit", "role_attributes:still_analytics_eraser"],
          ["grant pg_read_all_data to still_analytics_eraser", "role_member_of_role:still_analytics_eraser"],
        ];
        for (const [injection, issue] of refusedWhole) {
          const error = await rejection(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(injection);
              await tx.unsafe(source);
            })
          );
          assert(["42501", "55000"].includes(String(error.code)), `${injection}: ${error.code}`);
          assert(error.message.includes(issue), `${injection}: ${error.message}`);
        }
        // NEGATIVE CONTROL (search_path): an unpinned, empty or pg_temp-first path is refused.
        for (const path of ["''", "public, pg_temp", "pg_temp, pg_catalog"]) {
          const header = "create or replace function private.analytics_begin_account_erasure(p_user uuid, p_reason text)\nreturns jsonb language plpgsql volatile security definer set search_path = ";
          const mutant = await replacing(`${header}pg_catalog, pg_temp as $$`, `${header}${path} as $$`);
          const error = await rejection(() => admin.begin((tx) => tx.unsafe(mutant)));
          assertEquals(error.code, "42501", path);
          assert(error.message.includes("unsafe_search_path:private.analytics_begin_account_erasure(uuid,text)"), error.message);
        }
        assertEquals(await catalogState(admin), before);
      });

      await t.step("T6: the post-apply check reports an injected client grant", async () => {
        const issues = await rolledBack(admin, async (tx) => {
          await tx.unsafe("grant execute on function private.analytics_begin_account_erasure(uuid,text) to authenticated");
          return await verifyIn(tx);
        });
        assertEquals(issues, [
          "client_execute:authenticated:private.analytics_begin_account_erasure(uuid,text)",
          "erasure_function_grant:private.analytics_begin_account_erasure(uuid,text)",
        ]);
      });

      await t.step("P3-4: the post-apply check reports drift of the eraser role", async () => {
        const cases: [string, string[]][] = [
          ["alter role still_analytics_eraser set lock_timeout = '5s'", ["role_setting_missing:still_analytics_eraser:lock_timeout=1s"]],
          [
            "alter role still_analytics_eraser set log_parameter_max_length = 100",
            ["role_setting_missing:still_analytics_eraser:log_parameter_max_length=0"],
          ],
          ["alter role still_analytics_eraser inherit", ["role_attributes:still_analytics_eraser"]],
        ];
        for (const [drift, issues] of cases) {
          assertEquals(await rolledBack(admin, async (tx) => (await tx.unsafe(drift), await verifyIn(tx))), issues, drift);
        }
        assertEquals(await verify(admin), []);
      });

      await t.step("T10: 0017's snapshot function is byte-identical to 0017; an edit is reported", async () => {
        const body = await (async () => {
          const source = await read("../migrations/0017_analytics_erasure.sql");
          const start = source.indexOf("create or replace function private.analytics_snapshot_deleted_subject()");
          const open = source.indexOf("$$", start);
          return source.slice(open + 2, source.indexOf("$$", open + 2));
        })();
        const live = (await admin`select p.prosrc, pg_catalog.md5(p.prosrc) as md5 from pg_catalog.pg_proc p
          where p.oid = 'private.analytics_snapshot_deleted_subject()'::regprocedure`)[0];
        assertEquals(live.prosrc, body);
        assertEquals(live.md5, SNAPSHOT_MD5);
        assert(!(await migrationSource()).includes("function private.analytics_snapshot_deleted_subject"));
        // NEGATIVE CONTROL: an edited body (here, a lower claim priority) is reported by the check.
        const issues = await rolledBack(admin, async (tx) => {
          await tx.unsafe(`create or replace function private.analytics_snapshot_deleted_subject()
            returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$${
            body.replace("'stop_recorded', 0, 0, 2, moment, moment", "'stop_recorded', 0, 0, 1, moment, moment")
          }$$`);
          return await verifyIn(tx);
        });
        assertEquals(issues, ["erasure_function_body_changed:private.analytics_snapshot_deleted_subject()"]);
      });

      await t.step("preconditions refuse another executing role before any DDL", async () => {
        const before = await catalogState(admin);
        const other = await rejection(() =>
          admin.begin(async (tx) => {
            await tx.unsafe("create role u5w3_runner; grant u5w3_runner to postgres");
            await tx.unsafe("set local role u5w3_runner");
            await tx.unsafe(await migrationSource());
          })
        );
        assertEquals([other.code, other.message], ["42501", "analytics account erasure migration role precondition"]);
        assertEquals(await catalogState(admin), before);
      });

      await t.step("T6: no client role, service_role or other narrow role reaches the new routes", async () => {
        for (const role of OTHER_ROLES) {
          for (const route of NEW_ROUTES) {
            assertEquals(
              (await admin`select has_function_privilege(${role}, ${route}, 'EXECUTE') as allowed`)[0].allowed,
              false,
              `${role} ${route}`,
            );
          }
        }
        for (const role of ["anon", "authenticated", "service_role"]) {
          const denied = await rejection(() =>
            asClient(role, (tx) => tx`select private.analytics_begin_account_erasure(${account(1)}::uuid, 'account_deleted')`)
          );
          assertEquals(denied.code, "42501", role);
        }
      });

      // The eraser: a disposable login for this run only.
      await admin.unsafe(`alter role still_analytics_eraser login password '${ERASER_PASSWORD}'`);
      eraser = connect("still_analytics_eraser", ERASER_PASSWORD);
      eraser2 = connect("still_analytics_eraser", ERASER_PASSWORD);
      const store = new PgErasureStore(eraser);
      const newAccount = async (n: number, tag: string) =>
        void await admin`insert into auth.users (id, email) values (${account(n)}::uuid, ${TEST_EMAIL(`${tag}-${n}`)})`;
      const issue = async (user: string, device: number) => {
        const reply = await store.issueSubject(user, await proof(device));
        assert(reply.state === "active", `issued ${user} ${device}: ${reply.state}`);
        return reply.subject;
      };
      /** Every job that targets `subject`. */
      const jobsOf = async (subject: string) =>
        (await admin`select j.job_id::text as job, j.scope, j.stage, j.priority, pg_catalog.encode(j.scope_key, 'hex') as key,
            (select pg_catalog.count(*)::int from private.analytics_erasure_targets x where x.job_id = j.job_id) as targets
          from private.analytics_erasure_targets t join private.analytics_erasure_jobs j on j.job_id = t.job_id
          where t.distinct_id = ${subject}::uuid order by j.created_at, j.job_id`).map((r) => ({ ...r }));
      const reasonOf = async (subject: string) =>
        (await admin`select retired_reason from private.analytics_subjects where subject_id = ${subject}::uuid`)[0]
          ?.retired_reason ?? "gone";
      const jobCount = async () =>
        (await admin`select pg_catalog.count(*)::int as n from private.analytics_erasure_jobs`)[0].n as number;
      /** Retired subjects that no job targets: the invariant the pre-step keeps before a delete. */
      const untargetedRetired = async () =>
        (await admin`select pg_catalog.count(*)::int as n from private.analytics_subjects s
          where s.retired_at is not null and not exists (
            select 1 from private.analytics_erasure_targets t where t.distinct_id = s.subject_id)`)[0].n as number;
      /** #324's candidate-digest query: anything in the erasure tables matchable from the account. */
      const linked = async (sql: Sql | Tx, user: string) =>
        ({
          ...(await sql`
          with candidates(k) as (values
            (extensions.digest(pg_catalog.convert_to('still:analytics:account:' || ${user}::text, 'UTF8'), 'sha256')),
            (extensions.digest(pg_catalog.convert_to(${user}::text, 'UTF8'), 'sha256')),
            (extensions.digest(pg_catalog.decode(pg_catalog.replace(${user}::text, '-', ''), 'hex'), 'sha256')),
            (extensions.digest(pg_catalog.decode(pg_catalog.replace(${user}::text, '-', ''), 'hex') || pg_catalog.decode(pg_catalog.replace(${user}::text, '-', ''), 'hex'), 'sha256')))
          select (select pg_catalog.count(*) from private.analytics_erasure_jobs j join candidates c on j.scope_key = c.k)::int as keys,
                 (select pg_catalog.count(*) from private.analytics_erasure_targets t where t.distinct_id = ${user}::uuid)::int as ids`)[0],
        });

      await t.step("the eraser reaches both new routes, and still no table", async () => {
        assertEquals((await eraser!`select session_user::text as login`)[0].login, "still_analytics_eraser");
        await newAccount(1, "reach");
        assertEquals(await store.accountErasureStatus(account(1)), null);
        assertEquals(
          (await rejection(() => eraser!.unsafe("select * from private.analytics_subjects"))).code,
          "42501",
        );
        for (const bad of [null, "account", "device_erasure"]) {
          const refused = await rejection(() =>
            eraser!`select private.analytics_begin_account_erasure(${account(1)}::uuid, ${bad})`
          );
          assertEquals(refused.code, "22023", String(bad));
        }
      });

      await t.step("T9: with no identities (the switch never on) the pre-step captures nothing", async () => {
        await newAccount(9, "none");
        const jobs = await jobCount();
        assertEquals(await store.beginAccountErasure(account(9), "account_deleted"), { state: "captured", subjects: 0 });
        assertEquals(await jobCount(), jobs);
      });

      await t.step("T1, T4, T7: capture before delete, idempotent, unlinkable; GoTrue's role deletes", async () => {
        const U = account(11);
        await newAccount(11, "capture");
        const s1 = await issue(U, 1101);
        const s2 = await issue(U, 1102);
        const s3 = await issue(U, 1103);
        await store.beginDeviceErasure(deviceKey(1103), 0); // S3 stopped on its own device first
        assertEquals(await reasonOf(s3), "device_erasure");
        assertEquals(await store.beginAccountErasure(U, "account_deleted"), { state: "captured", subjects: 2 });
        assertEquals([await reasonOf(s1), await reasonOf(s2), await reasonOf(s3)], [
          "account_deleted",
          "account_deleted",
          "device_erasure",
        ]);
        const j1 = await jobsOf(s1);
        const j2 = await jobsOf(s2);
        for (const jobs of [j1, j2]) {
          assertEquals(jobs.map((j) => [j.scope, j.stage, j.priority, j.key.length, j.targets]), [
            ["account_deleted", "stop_recorded", 2, 64, 1],
          ]);
        }
        assertNotEquals(j1[0]!.key, j2[0]!.key, "one account's subjects share no key");
        assertEquals(await untargetedRetired(), 0);
        // Other devices of the account are now told to stop.
        assertEquals(await store.issueSubject(U, await proof(1101)), { state: "stopped" });
        // T4: a second call captures nothing and creates no job.
        const jobs = await jobCount();
        assertEquals(await store.beginAccountErasure(U, "account_deleted"), { state: "captured", subjects: 0 });
        assertEquals(await jobCount(), jobs);
        // GoTrue's own role deletes the account; the cascade's snapshot adds one job per subject.
        await auth`delete from auth.users where id = ${U}::uuid`;
        for (const s of [s1, s2, s3]) {
          assertEquals(await reasonOf(s), "gone");
          assert((await jobsOf(s)).length >= 2, `${s} is a target after the delete`);
        }
        assertEquals((await jobsOf(s1)).map((j) => j.scope), ["account_deleted", "account_deleted"]);
        // T7: nothing in the erasure tables is matchable from the account.
        assertEquals(await linked(admin, U), { keys: 0, ids: 0 });
        // NEGATIVE CONTROL (T7): a job keyed by the account's digest would be found.
        assertEquals(
          await rolledBack(admin, async (tx) => {
            await tx`insert into private.analytics_erasure_jobs(job_id, scope, scope_key, stage, sweeps, attempts, priority,
                next_attempt_at, created_at)
              values (gen_random_uuid(), 'account_deleted', extensions.digest(pg_catalog.convert_to(${U}::text, 'UTF8'), 'sha256'),
                      'stop_recorded', 0, 0, 2, now(), now())`;
            return await linked(tx, U);
          }),
          { keys: 1, ids: 0 },
        );
        // T4: after the delete, a retry of the pre-step answers "gone"; the account-wide action refuses.
        assertEquals(await store.beginAccountErasure(U, "account_deleted"), { state: "gone" });
        const refused = await rejection(() => eraser!`select private.analytics_begin_account_erasure(${U}::uuid, 'account_erasure')`);
        assertEquals(refused.code, "P0002");
      });

      await t.step("T1 NEGATIVE CONTROLS: without both layers the identities are lost; either layer alone suffices", async () => {
        const scenario = async (n: number, preStep: boolean, trigger: boolean) => {
          const U = account(n);
          await newAccount(n, "layers");
          const subjects = [await issue(U, n * 10 + 1), await issue(U, n * 10 + 2)];
          if (preStep) await store.beginAccountErasure(U, "account_deleted");
          return await rolledBack(admin, async (tx) => {
            if (!trigger) await tx`alter table private.analytics_subjects disable trigger analytics_subjects_snapshot`;
            await tx`delete from auth.users where id = ${U}::uuid`;
            return (await tx`select pg_catalog.count(distinct t.distinct_id)::int as n from private.analytics_erasure_targets t
              where t.distinct_id = any(${`{${subjects.join(",")}}`}::uuid[])`)[0].n as number;
          });
        };
        assertEquals(await scenario(21, false, false), 0, "neither layer: both identities are lost");
        assertEquals(await scenario(22, true, false), 2, "the pre-step alone captures both");
        assertEquals(await scenario(23, false, true), 2, "the snapshot alone captures both");
        assertEquals(await scenario(24, true, true), 2, "both layers");
      });

      await t.step("T2: an identity issued between the pre-step and the delete is captured by the snapshot", async () => {
        const gap = async (n: number, trigger: boolean) => {
          const U = account(n);
          await newAccount(n, "gap");
          await issue(U, n * 10 + 1);
          assertEquals(await store.beginAccountErasure(U, "account_deleted"), { state: "captured", subjects: 1 });
          const late = await issue(U, n * 10 + 2); // a new device signs in meanwhile
          return await rolledBack(admin, async (tx) => {
            if (!trigger) await tx`alter table private.analytics_subjects disable trigger analytics_subjects_snapshot`;
            await tx`delete from auth.users where id = ${U}::uuid`;
            return (await tx`select pg_catalog.count(*)::int as n from private.analytics_erasure_targets
              where distinct_id = ${late}::uuid`)[0].n as number;
          });
        };
        assertEquals(await gap(31, true), 1);
        // NEGATIVE CONTROL: without the snapshot that late identity is lost.
        assertEquals(await gap(32, false), 0);
      });

      await t.step("T5: concurrent pre-steps and device erasures never deadlock and miss nothing", async () => {
        const codes: string[] = [];
        const run = (call: () => Promise<unknown>) =>
          call().catch((error: PgError) => void codes.push(String(error.code ?? error.message)));
        for (let round = 0; round < 20; round++) {
          const U = account(1000 + round);
          const V = account(2000 + round);
          await newAccount(1000 + round, "race");
          await newAccount(2000 + round, "race");
          const base = 5000 + round * 10;
          const subjects = [await issue(U, base), await issue(U, base + 1), await issue(V, base + 2), await issue(V, base + 3)];
          // A shared device: U's pre-step and that device's own erasure at the same moment.
          const shared = await issue(V, base);
          const key = deviceKey(base);
          await Promise.all([
            run(() => eraser!`select private.analytics_begin_account_erasure(${U}::uuid, 'account_deleted')`),
            run(() => eraser2!`select private.analytics_begin_device_erasure(pg_catalog.decode(${key}, 'hex'), 0)`),
          ]);
          // Two pre-steps for the same account at once (two tabs): one captures, the other nothing.
          const both = await Promise.all([
            eraser!`select private.analytics_begin_account_erasure(${V}::uuid, 'account_deleted') as value`.catch((e: PgError) => {
              codes.push(String(e.code));
              return [{ value: { subjects: 0 } }];
            }),
            eraser2!`select private.analytics_begin_account_erasure(${V}::uuid, 'account_deleted') as value`.catch((e: PgError) => {
              codes.push(String(e.code));
              return [{ value: { subjects: 0 } }];
            }),
          ]);
          const captured = both.map((r) => (r[0]!.value as { subjects: number }).subjects).sort();
          assert(captured[0] === 0 && captured[1]! >= 2, `round ${round}: ${captured}`);
          for (const s of [...subjects, shared]) {
            assertNotEquals(await reasonOf(s), null, `round ${round}: ${s} retired`);
            assert((await jobsOf(s)).length >= 1, `round ${round}: ${s} targeted`);
          }
          assertEquals(await untargetedRetired(), 0, `round ${round}`);
        }
        assertEquals(codes, [], "no deadlock, lock timeout or other failure");
        // The real route walks the subjects in subject_id order, locking as it goes.
        const route = slice(await migrationSource(), "create or replace function private.analytics_begin_account_erasure", "end $$;");
        assert(/order by s\.subject_id[^\n]*\n\s+for update/.test(route), "subject_id order, then FOR UPDATE");
      });

      // Review P3-1: two accounts on two shared devices, with both pre-steps and both device erasures.
      const deviceRoute = slice(await migrationSource(), "create or replace function private.analytics_begin_device_erasure(", "end $$;");
      const originKey = async (device: number) =>
        (await admin`select extensions.digest(pg_catalog.decode(${await proof(device)}, 'hex'), 'sha256') as k`)[0].k;

      await t.step("T5: four parties (two pre-steps, two device erasures, two shared devices) never deadlock", async () => {
        assert(
          /perform 1 from private\.analytics_subjects s where s\.origin_key = k order by s\.subject_id for update;/.test(deviceRoute),
          "device erasure locks its subjects in subject_id order",
        );
        const extra = [connect("still_analytics_eraser", ERASER_PASSWORD), connect("still_analytics_eraser", ERASER_PASSWORD)];
        const conns = [eraser!, eraser2!, ...extra];
        const codes: string[] = [];
        try {
          for (let round = 0; round < 20; round++) {
            const [U1, U2] = [account(3000 + 2 * round), account(3001 + 2 * round)];
            await newAccount(3000 + 2 * round, "four");
            await newAccount(3001 + 2 * round, "four");
            const [X, Y] = [9000 + 2 * round, 9001 + 2 * round];
            const subjects = [await issue(U1, X), await issue(U1, Y), await issue(U2, X), await issue(U2, Y)];
            const calls = [
              () => conns[0]!`select private.analytics_begin_account_erasure(${U1}::uuid, 'account_deleted')`,
              () => conns[1]!`select private.analytics_begin_account_erasure(${U2}::uuid, 'account_deleted')`,
              () => conns[2]!`select private.analytics_begin_device_erasure(pg_catalog.decode(${deviceKey(X)}, 'hex'), 0)`,
              () => conns[3]!`select private.analytics_begin_device_erasure(pg_catalog.decode(${deviceKey(Y)}, 'hex'), 0)`,
            ];
            await Promise.all(calls.map((call) => call().catch((e: PgError) => void codes.push(String(e.code ?? e.message)))));
            for (const subject of subjects) {
              assertNotEquals(await reasonOf(subject), null, `round ${round}`);
              assert((await jobsOf(subject)).length >= 1, `round ${round}: ${subject} targeted`);
            }
            assertEquals(await untargetedRetired(), 0, `round ${round}`);
          }
        } finally {
          for (const c of extra) await c.end();
        }
        assertEquals(codes, [], "no deadlock, lock timeout or other failure");
      });

      await t.step("T5 four parties, forced into the cycle: 0018's device erasure finishes; locking in another order deadlocks", async () => {
        const before = await catalogState(admin);
        const deadlockTimeout = (await admin`select pg_catalog.current_setting('deadlock_timeout') as t`)[0].t;
        /** Wait until `pid` waits on a row lock. */
        const waitingOnLock = async (pid: number) => {
          for (let i = 0; i < 200; i++) {
            const row = (await admin`select wait_event_type from pg_catalog.pg_stat_activity where pid = ${pid}`)[0];
            if (row?.wait_event_type === "Lock") return;
            await new Promise((r) => setTimeout(r, 25));
          }
          throw new Error(`backend ${pid} never waited on a lock`);
        };
        /** Subject ids d < a < b < c: U1 holds a (device X) and b (device Y); U2 holds c (X) and d (Y). */
        const forced = async (run: number, route: string) => {
          await admin.unsafe(route);
          const [U1, U2] = [account(4000 + 2 * run), account(4001 + 2 * run)];
          await newAccount(4000 + 2 * run, "forced");
          await newAccount(4001 + 2 * run, "forced");
          const [X, Y] = [9900 + 2 * run, 9901 + 2 * run];
          const id = (k: number) => `${run}${run}${run}${run}${run}${run}${run}${run}-0000-4000-8000-00000000000${k}`;
          const [d, a, b, c] = [id(1), id(2), id(3), id(4)];
          for (const [subject, user, device] of [[c, U2, X], [b, U1, Y], [a, U1, X], [d, U2, Y]] as const) {
            await admin`insert into private.analytics_subjects(subject_id, user_id, origin_key, epoch, created_at, last_activity_month)
              values (${subject}::uuid, ${user}::uuid, ${await originKey(device)}, 0, now(), current_date)`;
          }
          const parties = [connect(), connect(), connect(), connect()];
          const blocker = connect();
          try {
            const pids: number[] = [];
            for (const p of parties) pids.push((await p`select pg_catalog.pg_backend_pid() as pid`)[0].pid);
            let release!: () => void;
            const released = new Promise<void>((r) => (release = r));
            let holding!: () => void;
            const held = new Promise<void>((r) => (holding = r));
            const blocking = blocker.begin(async (tx) => {
              await tx`select 1 from private.analytics_subjects where subject_id = ${b}::uuid for update`;
              holding();
              await released;
            });
            await held;
            const outcome = (q: Promise<unknown>) => q.then(() => "ok", (e: PgError) => String(e.code ?? e.message));
            // Device Y, then pre-step U1, then device X, then pre-step U2, each started once the one
            // before waits on a row lock, so every party holds what it can before the blocker lets go.
            const results = [
              outcome(parties[0]!`select private.analytics_begin_device_erasure(pg_catalog.decode(${deviceKey(Y)}, 'hex'), 0)`),
            ];
            await waitingOnLock(pids[0]!);
            results.push(outcome(parties[1]!`select private.analytics_begin_account_erasure(${U1}::uuid, 'account_deleted')`));
            await waitingOnLock(pids[1]!);
            results.push(outcome(parties[2]!`select private.analytics_begin_device_erasure(pg_catalog.decode(${deviceKey(X)}, 'hex'), 0)`));
            await waitingOnLock(pids[2]!);
            results.push(outcome(parties[3]!`select private.analytics_begin_account_erasure(${U2}::uuid, 'account_deleted')`));
            await waitingOnLock(pids[3]!);
            release();
            await blocking;
            return (await Promise.all(results)).sort();
          } finally {
            for (const p of [...parties, blocker]) await p.end();
          }
        };
        try {
          // 0018's device erasure: every subject lock in one global order, so all four finish.
          assertEquals(await forced(1, deviceRoute), ["ok", "ok", "ok", "ok"]);
          // NEGATIVE CONTROL: the same route locking a device's subjects in descending order (like
          // 0017's update, whose scan order is unrelated to subject_id) forms the cycle.
          const descending = deviceRoute.replace(
            "where s.origin_key = k order by s.subject_id for update;",
            "where s.origin_key = k order by s.subject_id desc for update;",
          );
          assertNotEquals(descending, deviceRoute);
          assertEquals(await forced(2, descending), ["40P01", "ok", "ok", "ok"], `deadlock_timeout ${deadlockTimeout}`);
        } finally {
          await admin.unsafe(deviceRoute);
        }
        assertEquals(await catalogState(admin), before);
      });

      await t.step("T5 NEGATIVE CONTROL: the same lock walk in opposite orders deadlocks; in one order it does not", async () => {
        const M = account(41);
        await newAccount(41, "order");
        await issue(M, 411);
        await issue(M, 412);
        await admin.unsafe("create schema if not exists u5w3_fixture");
        // The route's lock walk, one row at a time (no prefetch) with a pause, and no advisory lock.
        await admin.unsafe(`create or replace function u5w3_fixture.lock_walk(p_user uuid, p_desc boolean)
          returns integer language plpgsql set search_path = pg_catalog, pg_temp as $$
          declare subj record; n integer := 0;
          begin
            for subj in select s.subject_id from private.analytics_subjects s
                        where s.user_id = p_user and s.retired_at is null
                        order by (case when p_desc then s.subject_id end) desc, s.subject_id loop
              perform 1 from private.analytics_subjects s where s.subject_id = subj.subject_id for update;
              perform pg_catalog.pg_sleep(0.4);
              n := n + 1;
            end loop;
            return n;
          end $$`);
        const c1 = connect();
        const c2 = connect();
        try {
          const walk = (sql: Sql, desc: boolean) => sql`select u5w3_fixture.lock_walk(${M}::uuid, ${desc}) as n`;
          const opposite = await Promise.allSettled([walk(c1, false), walk(c2, true)]);
          const failures = opposite.filter((r) => r.status === "rejected").map((r) => String((r.reason as PgError).code));
          assertEquals(failures, ["40P01"], "opposite orders deadlock");
          const same = await Promise.allSettled([walk(c1, false), walk(c2, false)]);
          assertEquals(same.map((r) => r.status), ["fulfilled", "fulfilled"], "one order serializes");
        } finally {
          await c1.end();
          await c2.end();
          await admin.unsafe("drop schema u5w3_fixture cascade");
        }
      });

      await t.step("T4 NEGATIVE CONTROL: without its active-only filter a second call would double the jobs", async () => {
        const U = account(51);
        await newAccount(51, "filter");
        await issue(U, 511);
        await issue(U, 512);
        const mutant = await replacing("    where s.user_id = p_user and s.retired_at is null\n", "    where s.user_id = p_user\n");
        const counts = await rolledBack(admin, async (tx) => {
          await tx.unsafe(mutant);
          const before = (await tx`select pg_catalog.count(*)::int as n from private.analytics_erasure_jobs`)[0].n;
          await tx`select private.analytics_begin_account_erasure(${U}::uuid, 'account_deleted')`;
          const once = (await tx`select pg_catalog.count(*)::int as n from private.analytics_erasure_jobs`)[0].n;
          await tx`select private.analytics_begin_account_erasure(${U}::uuid, 'account_deleted')`;
          const twice = (await tx`select pg_catalog.count(*)::int as n from private.analytics_erasure_jobs`)[0].n;
          return [once - before, twice - once];
        });
        assertEquals(counts, [2, 2], "the mutant re-queues on every call");
        // The real route: 2, then 0.
        assertEquals(await store.beginAccountErasure(U, "account_deleted"), { state: "captured", subjects: 2 });
        assertEquals(await store.beginAccountErasure(U, "account_deleted"), { state: "captured", subjects: 0 });
      });

      await t.step("the account-wide action (packet B, dormant): stopped devices, a status, nothing after the delete", async () => {
        const U = account(61);
        await newAccount(61, "account-wide");
        const s1 = await issue(U, 611);
        await issue(U, 612);
        assertEquals(await store.beginAccountErasure(U, "account_erasure"), { state: "captured", subjects: 2 });
        assertEquals(await reasonOf(s1), "account_erasure");
        assertEquals((await jobsOf(s1)).map((j) => j.scope), ["account"]);
        assertEquals(await store.accountErasureStatus(U), "stop_recorded");
        assertEquals(await store.issueSubject(U, await proof(611)), { state: "stopped" });
        await auth`delete from auth.users where id = ${U}::uuid`;
        assertEquals(await store.accountErasureStatus(U), null, "derived through the account: gone with it");
      });
    } finally {
      await eraser?.end();
      await eraser2?.end();
      // Synthetic rows out, and the role back to the migration's state: no LOGIN, no password.
      await admin`delete from auth.users where email like 'u5w3-t-%@example.invalid'`;
      await admin`delete from private.analytics_erasure_jobs where job_id <> all(${`{${SEEDED_JOBS.join(",")}}`}::uuid[])`;
      await admin.unsafe("alter role still_analytics_eraser nologin password null");
      await auth.end();
      await gateway.end();
      await admin.end();
    }
  },
});

Deno.test({
  name: "U5-W3 T3: the real delete-user handler, through GoTrue's admin endpoint, records first and the snapshot backs it up",
  ignore: !databaseUrl || (mode !== "upgrade" && mode !== "clean") || !authUrl || !authServiceKey,
  async fn(t) {
    const base = new URL(authUrl!);
    if (base.hostname !== "127.0.0.1") throw new Error("Disposable loopback GoTrue required");
    const admin = connect();
    let eraser: Sql | null = null;
    const created: string[] = [];
    const goTrue = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(new URL(`/auth/v1${path}`, base), {
        method,
        headers: { apikey: authServiceKey!, Authorization: `Bearer ${authServiceKey}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const newUser = async (tag: string) => {
      const res = await goTrue("POST", "/admin/users", {
        email: TEST_EMAIL(`${tag}-${crypto.randomUUID().slice(0, 8)}`),
        email_confirm: true,
      });
      assertEquals(res.status, 200, JSON.stringify(res.body?.code ?? res.status));
      created.push(res.body.id);
      return res.body.id as string;
    };
    try {
      await admin.unsafe(`alter role still_analytics_eraser login password '${ERASER_PASSWORD}'`);
      eraser = connect("still_analytics_eraser", ERASER_PASSWORD);
      const store = new PgErasureStore(eraser);
      const issue = async (user: string, device: number) => {
        const reply = await store.issueSubject(user, await proof(device));
        assert(reply.state === "active");
        return reply.subject;
      };
      const jobsOf = async (subject: string) =>
        (await admin`select j.scope from private.analytics_erasure_targets t
          join private.analytics_erasure_jobs j on j.job_id = t.job_id where t.distinct_id = ${subject}::uuid`)
          .map((r) => r.scope);
      const userRow = async (id: string) =>
        (await admin`select deleted_at is not null as soft from auth.users where id = ${id}::uuid`).map((r) => ({ ...r }));

      await t.step("delete-user records first, then GoTrue hard-deletes; each identity has both jobs", async () => {
        const id = await newUser("handler");
        const subjects = [await issue(id, 7001), await issue(id, 7002)];
        const res = await handleDeleteUser(
          new Request("http://x", { method: "POST", headers: { Authorization: `Bearer ${await jwt(id)}` }, body: "{}" }),
          { jwtSecret: JWT_SECRET, store: new SupabaseUserStore(base.origin, authServiceKey!), erasure: store },
        );
        assertEquals([res.status, await res.json()], [200, { deleted: true, analyticsDeleted: null }]);
        assertEquals(await userRow(id), []);
        // The pre-step's job and the snapshot's job: two per identity, so the pre-step really ran.
        for (const s of subjects) assertEquals(await jobsOf(s), ["account_deleted", "account_deleted"]);
      });

      await t.step("GoTrue's hard delete alone (no pre-step) is captured by the snapshot", async () => {
        const id = await newUser("trigger");
        const s = await issue(id, 7003);
        assertEquals((await goTrue("DELETE", `/admin/users/${id}`, { should_soft_delete: false })).status, 200);
        assertEquals(await userRow(id), []);
        assertEquals(await jobsOf(s), ["account_deleted"]);
      });

      await t.step("NEGATIVE CONTROL: a GoTrue soft delete leaves the row, so nothing is captured (why D7 pins hard)", async () => {
        const id = await newUser("soft");
        const s = await issue(id, 7004);
        assertEquals((await goTrue("DELETE", `/admin/users/${id}`, { should_soft_delete: true })).status, 200);
        assertEquals(await userRow(id), [{ soft: true }]);
        assertEquals(await jobsOf(s), []);
        assertEquals(
          (await admin`select user_id::text as user, retired_at from private.analytics_subjects where subject_id = ${s}::uuid`)
            .map((r) => ({ ...r })),
          [{ user: id, retired_at: null }],
          "still linked to the tombstoned account",
        );
      });
    } finally {
      await eraser?.end();
      for (const id of created) await admin`delete from auth.users where id = ${id}::uuid`;
      await admin`delete from private.analytics_erasure_jobs where job_id <> all(${`{${SEEDED_JOBS.join(",")}}`}::uuid[])`;
      await admin.unsafe("alter role still_analytics_eraser nologin password null");
      await admin.end();
    }
  },
});
