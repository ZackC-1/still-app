// Migration 0017 (per-device analytics identities and device erasure) against a real, disposable
// Supabase database.
//
// Runs only when STILL_U5W2_ERASURE_TEST_DATABASE_URL points at a loopback database created for the
// test (a rehearsal on a GitHub-hosted runner, or an explicitly approved local disposable stack). A
// skipped run is not evidence. Nothing here is hosted or production evidence.
//
// Modes (STILL_U5W2_ERASURE_TEST_MODE):
//   pre-upgrade  the database is exactly at 0016 with analytics_erasure_migration_seed.sql loaded:
//                the deploy runner's post-apply check reports exactly the missing end state, and the
//                existing rows are fingerprinted for the upgrade run.
//   upgrade      then 0017 is applied: proves every existing row survived, then everything below.
//   clean        a database reset to head; the test seeds the same rows itself.
//
// The routes run as the narrow role through the real Postgres store and the real handlers, with a
// fake PostHog. The ordinary postgres role (which holds the automatic admin option on the eraser)
// gives it a disposable synthetic login here and removes it again at the end; production never
// sends a cleartext password in SQL text. Every account and id is synthetic.
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import { handleAnalyticsErasure } from "../functions/analytics-erasure/handler.ts";
import { handleAnalyticsIdentify } from "../functions/analytics-identify/handler.ts";
import { PgErasureStore } from "../functions/_shared/erasure-store.ts";
import type { ErasureOutcome } from "../functions/_shared/erasure-store.ts";
import { PgRateLimiter } from "../functions/_shared/pg-store.ts";
import type { PostHogErasurePort, PostHogSubjectPort } from "../functions/_shared/posthog-erasure.ts";
import { signHs256 } from "../functions/_shared/jwt.ts";

const databaseUrl = Deno.env.get("STILL_U5W2_ERASURE_TEST_DATABASE_URL");
const mode = Deno.env.get("STILL_U5W2_ERASURE_TEST_MODE");
const gatewayPassword = Deno.env.get("STILL_GRANTS_GATEWAY_PASSWORD") ?? "postgres";
const ERASER_PASSWORD = "u5w2-synthetic-eraser-only";
const JWT_SECRET = "u5w2-synthetic-erasure-jwt-secret-32-chars";
const MIGRATION = "0017_analytics_erasure.sql";

const U1 = "b6b6b6b6-0000-4000-8000-000000000061";
const U2 = "b6b6b6b6-0000-4000-8000-000000000062";
const U3 = "b6b6b6b6-0000-4000-8000-000000000063";
const SEEDED = ["b5b5b5b5-0000-4000-8000-000000000051", "b5b5b5b5-0000-4000-8000-000000000052"];
const P1 = "1".repeat(64);
const P2 = "2".repeat(64);
const P3 = "3".repeat(64);
const N1 = "a0000000-0000-4000-8000-000000000001";
const N2 = "a0000000-0000-4000-8000-000000000002";
const N3 = "a0000000-0000-4000-8000-000000000003";

const ROUTES = [
  "private.analytics_issue_subject(uuid,bytea)",
  "private.analytics_subject_active(uuid)",
  "private.analytics_begin_device_erasure(bytea,uuid[])",
  "private.analytics_erasure_status(bytea)",
  "private.analytics_claim_erasure_work(integer,integer)",
  "private.analytics_record_erasure_outcome(uuid,uuid,text)",
];
const TABLES = ["private.analytics_subjects", "private.analytics_erasure_jobs", "private.analytics_erasure_targets"];
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
const verificationSource = () => read("../../scripts/backend/deploy/verify/0017_analytics_erasure.sql");
const invariantSource = () => read("../../scripts/backend/deploy/verify/0017_analytics_erasure.invariant.sql");
const seedSource = () => read("./analytics_erasure_migration_seed.sql");

async function verify(sql: Sql): Promise<string[]> {
  return await sql.begin(async (tx) => {
    await tx`set transaction read only`;
    const rows = await tx.unsafe(await verificationSource());
    return JSON.parse(String(Object.values(rows[0])[0]));
  });
}
async function without(...statements: string[]): Promise<string> {
  let source = await migrationSource();
  for (const statement of statements) {
    assertEquals(source.split(statement).length, 2, `statement occurs once: ${statement}`);
    source = source.split(statement).join("");
  }
  return source;
}
async function replacing(statement: string, replacement: string): Promise<string> {
  const source = await migrationSource();
  assertEquals(source.split(statement).length, 2, `statement occurs once: ${statement}`);
  return source.split(statement).join(replacement);
}
async function rejection(run: () => Promise<unknown>): Promise<PgError> {
  return (await assertRejects(run)) as PgError;
}
/** Every row 0017 could conceivably touch, as text, for the upgrade comparison. */
async function fingerprints(sql: Sql | Tx): Promise<string> {
  const rows = await sql`
    select pg_catalog.jsonb_build_object(
      'users', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(u.id, u.email) order by u.id) from auth.users u),
      'profiles', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) order by p.id) from public.profiles p),
      'entitlements', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.user_id) from public.entitlements e),
      'anchors', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.user_id, a.lineage, pg_catalog.md5(a.secret), a.modern_used) order by a.user_id) from private.settings_anchors a),
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
      'schemas', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('schema', nspname, 'acl', nspacl::text)
        order by nspname) from pg_catalog.pg_namespace where nspname in ('public', 'private')),
      'role', (select pg_catalog.jsonb_build_object('attributes', pg_catalog.jsonb_build_array(r.rolsuper, r.rolinherit,
        r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls),
        'settings', (select s.setconfig from pg_catalog.pg_db_role_setting s where s.setrole = r.oid and s.setdatabase = 0))
        from pg_catalog.pg_roles r where r.rolname = 'still_analytics_eraser')
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
  name: "U5-W2: before 0017, its post-apply check reports exactly the missing end state",
  ignore: !databaseUrl || mode !== "pre-upgrade",
  async fn() {
    const admin = connect();
    try {
      const versions = (await admin`select version from supabase_migrations.schema_migrations order by version`)
        .map((r) => r.version);
      assertEquals(versions.at(-1), "0016", "the database is exactly at 0016");
      assertEquals(await verify(admin), [
        "erasure_function_body_changed:public.consume_rate_limit(text,integer,integer)",
        "erasure_function_grant:public.consume_rate_limit(text,integer,integer)",
        ...ROUTES.concat("private.analytics_origin_key(bytea)").sort().map((r) => `erasure_function_missing:${r}`),
        ...["analytics_erasure_jobs", "analytics_erasure_targets", "analytics_subjects"]
          .map((t) => `erasure_relation_missing:${t}`),
        "migration_missing:0017",
        "role_missing:still_analytics_eraser",
      ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      // Fingerprint the existing rows for the upgrade run (a fixture schema the upgrade run drops).
      await admin.unsafe("create schema if not exists u5w2_fixture");
      await admin.unsafe("create table if not exists u5w2_fixture.before(state text not null)");
      await admin`truncate u5w2_fixture.before`;
      const state = await fingerprints(admin);
      await admin`insert into u5w2_fixture.before(state) values (${state})`;
    } finally {
      await admin.end();
    }
  },
});

Deno.test({
  name: "U5-W2: 0017 adds per-device subjects and device erasure, reachable only by the eraser",
  ignore: !databaseUrl || (mode !== "upgrade" && mode !== "clean"),
  async fn(t) {
    const admin = connect();
    const gateway = connect("authenticator", gatewayPassword);
    let eraser: Sql | null = null;
    const asClient = <T>(role: string, run: (tx: Tx) => Promise<T>) =>
      gateway.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role })}, true)`;
        await tx.unsafe(`set local role ${role}`);
        return await run(tx);
      });
    try {
      const preconditions = await t.step("preconditions: ordinary non-superuser postgres applied 0016 and 0017", async () => {
        assertEquals(
          (await admin`select current_user::text as role, rolsuper from pg_catalog.pg_roles where rolname = current_user`)[0],
          { role: "postgres", rolsuper: false },
        );
        const versions = (await admin`select version from supabase_migrations.schema_migrations order by version`)
          .map((r) => r.version);
        for (const required of ["0016", "0017"]) assert(versions.includes(required), `${required} applied`);
      });
      if (!preconditions) return;

      if (mode === "upgrade") {
        await t.step("every existing row survived the upgrade", async () => {
          const before = (await admin`select state from u5w2_fixture.before`)[0]?.state;
          assert(before, "the pre-upgrade run recorded fingerprints");
          assertEquals(await fingerprints(admin), before);
          await admin.unsafe("drop schema u5w2_fixture cascade");
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
        assert(String(invariant).includes('"auth.users"'));
      });

      await t.step("re-applying 0017 changes nothing", async () => {
        const before = await catalogState(admin);
        const rows = await fingerprints(admin);
        await admin.begin(async (tx) => void await tx.unsafe(await migrationSource()));
        assertEquals(await catalogState(admin), before);
        assertEquals(await fingerprints(admin), rows);
      });

      await t.step("dropping one of 0017's own protections makes its self-check abort", async () => {
        const before = await catalogState(admin);
        const routeRevoke = await (async () => {
          const source = await migrationSource();
          const start = source.indexOf("revoke all on function private.analytics_origin_key(bytea),");
          return source.slice(start, source.indexOf(";", start) + 1);
        })();
        const schemaRevoke = "revoke all on all functions in schema private from public, anon, authenticated, service_role;";
        const tableRevoke = await (async () => {
          const source = await migrationSource();
          const start = source.indexOf("revoke all on table private.analytics_subjects");
          return source.slice(start, source.indexOf(";", start) + 1);
        })();
        const cases: [string, string[], string][] = [
          [
            "grant execute on function private.analytics_begin_device_erasure(bytea,uuid[]) to authenticated",
            [schemaRevoke, routeRevoke],
            "client_execute:authenticated:private.analytics_begin_device_erasure(bytea,uuid[])",
          ],
          [
            "grant execute on function private.analytics_issue_subject(uuid,bytea) to service_role",
            [schemaRevoke, routeRevoke],
            "client_execute:service_role:private.analytics_issue_subject(uuid,bytea)",
          ],
          [
            "grant select on private.analytics_subjects to still_analytics_eraser",
            [tableRevoke],
            "erasure_relation_grant:analytics_subjects",
          ],
          [
            "alter table private.analytics_erasure_targets disable row level security",
            ["alter table private.analytics_erasure_targets enable row level security;"],
            "erasure_rls_disabled:analytics_erasure_targets",
          ],
          [
            "alter role still_analytics_eraser reset log_parameter_max_length",
            ["alter role still_analytics_eraser set log_parameter_max_length = 0;"],
            "role_setting_missing:still_analytics_eraser:log_parameter_max_length=0",
          ],
          [
            // A retired subject could be reissued without the all-rows unique index.
            "drop index private.analytics_subjects_one_per_device",
            [
              "create unique index if not exists analytics_subjects_one_per_device\n  on private.analytics_subjects(user_id, origin_key, epoch);",
            ],
            "subject_reissue_guard",
          ],
          [
            "drop index private.analytics_erasure_jobs_open",
            [
              "create unique index if not exists analytics_erasure_jobs_open\n  on private.analytics_erasure_jobs(scope, scope_key) where completed_at is null;",
            ],
            "erasure_job_open_guard",
          ],
        ];
        for (const [injection, statements, issue] of cases) {
          const repaired = await rejection(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(injection);
              await tx.unsafe(await migrationSource());
              throw new Error("rollback repaired probe");
            })
          );
          assertEquals(repaired.message, "rollback repaired probe", injection);
          const error = await rejection(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(injection);
              await tx.unsafe(await without(...statements));
            })
          );
          assertEquals(error.code, "42501", injection);
          assert(
            error.message.startsWith("analytics erasure self-check failed:") && error.message.includes(issue),
            `${injection}: ${error.message}`,
          );
        }
        // NEGATIVE CONTROL (search_path): a route written with an unpinned or empty search_path is
        // refused by the self-check, and so is a pinned path that searches pg_temp first.
        for (const path of ["''", "public, pg_temp", "pg_temp, pg_catalog"]) {
          const mutant = await replacing(
            "create or replace function private.analytics_begin_device_erasure(p_proof bytea, p_anonymous uuid[])\nreturns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$",
            `create or replace function private.analytics_begin_device_erasure(p_proof bytea, p_anonymous uuid[])\nreturns jsonb language plpgsql volatile security definer set search_path = ${path} as $$`,
          );
          const error = await rejection(() => admin.begin((tx) => tx.unsafe(mutant)));
          assertEquals(error.code, "42501", path);
          assert(
            error.message.includes("unsafe_search_path:private.analytics_begin_device_erasure(bytea,uuid[])"),
            error.message,
          );
        }
        assertEquals(await catalogState(admin), before);
      });

      await t.step("the self-check rejects reach that 0017 does not itself remove", async () => {
        const before = await catalogState(admin);
        const cases: [string, string][] = [
          [
            "create role u5w2_bridge; grant still_analytics_eraser to u5w2_bridge; grant u5w2_bridge to authenticated",
            "role_granted_to_other:still_analytics_eraser",
          ],
          ["alter role still_analytics_eraser inherit", "role_attributes:still_analytics_eraser"],
          ["grant pg_read_all_data to still_analytics_eraser", "role_member_of_role:still_analytics_eraser"],
          [
            // Jobs must never reference an account, or account deletion would erase the fence list.
            "alter table private.analytics_erasure_jobs add column u5w2_user uuid references auth.users(id) on delete cascade",
            "erasure_job_references",
          ],
          [
            "alter table private.analytics_subjects drop constraint analytics_subjects_user_id_fkey",
            "subject_no_account_cascade",
          ],
          [
            "grant execute on function private.read_product_policy(text,text) to still_analytics_eraser",
            "eraser_execute:private.read_product_policy(text,text)",
          ],
          ["grant create on schema public to still_analytics_eraser", "public_schema_access:still_analytics_eraser"],
          [
            "alter default privileges for role postgres in schema private grant select on tables to still_analytics_eraser",
            "private_default:postgres:r",
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
            error.message.startsWith("analytics erasure self-check failed:") && error.message.includes(issue),
            `${mutation}: ${error.message}`,
          );
        }
        assertEquals(await catalogState(admin), before);
      });

      await t.step("preconditions refuse another executing role before any DDL", async () => {
        const before = await catalogState(admin);
        const other = await rejection(() =>
          admin.begin(async (tx) => {
            await tx.unsafe("create role u5w2_runner; grant u5w2_runner to postgres");
            await tx.unsafe("set local role u5w2_runner");
            await tx.unsafe(await migrationSource());
          })
        );
        assertEquals([other.code, other.message], ["42501", "analytics erasure migration role precondition"]);
        assertEquals(await catalogState(admin), before);
      });

      await t.step("no client role, service_role or other narrow role reaches a route or table", async () => {
        for (const role of OTHER_ROLES) {
          for (const route of ROUTES) {
            assertEquals(
              (await admin`select has_function_privilege(${role}, ${route}, 'EXECUTE') as allowed`)[0].allowed,
              false,
              `${role} ${route}`,
            );
          }
          for (const table of TABLES) {
            assertEquals(
              (await admin`select has_table_privilege(${role}, ${table}, 'SELECT,INSERT,UPDATE,DELETE') as allowed`)[0]
                .allowed,
              false,
              `${role} ${table}`,
            );
          }
        }
        for (const role of ["anon", "authenticated", "service_role"]) {
          const denied = await rejection(() =>
            asClient(role, (tx) => tx`select private.analytics_issue_subject(${U1}::uuid, pg_catalog.decode(${P1}, 'hex'))`)
          );
          assertEquals(denied.code, "42501", role);
        }
      });

      // The eraser: a disposable login for this run only.
      await admin`insert into auth.users (id, email) values
        (${U1}, 'u5w2-one@example.invalid'), (${U2}, 'u5w2-two@example.invalid'), (${U3}, 'u5w2-three@example.invalid')`;
      await admin.unsafe(`alter role still_analytics_eraser login password '${ERASER_PASSWORD}'`);
      eraser = connect("still_analytics_eraser", ERASER_PASSWORD);
      const store = new PgErasureStore(eraser);
      const subjects = async (proof: string) =>
        (await admin`select subject_id::text as subject, user_id::text as user, retired_reason
          from private.analytics_subjects where origin_key = extensions.digest(pg_catalog.decode(${proof}, 'hex'), 'sha256')
          order by user_id`).map((r) => ({ ...r }));
      const targets = async (job: string) =>
        (await admin`select distinct_id::text as id, kind from private.analytics_erasure_targets where job_id = ${job}::uuid order by distinct_id`)
          .map((r) => ({ ...r }));

      await t.step("the eraser holds only its routes: no table, no other routine", async () => {
        assertEquals((await eraser!`select session_user::text as login, current_user::text as role`)[0], {
          login: "still_analytics_eraser",
          role: "still_analytics_eraser",
        });
        for (const table of TABLES) {
          assertEquals((await rejection(() => eraser!.unsafe(`select * from ${table}`))).code, "42501", table);
        }
        assertEquals(
          (await rejection(() => eraser!`select private.read_product_policy('sales', 'production')`)).code,
          "42501",
        );
        const limiter = new PgRateLimiter(eraser!);
        assertEquals(await limiter.consume("analytics-erasure:ip:198.51.100.1", 2, 600), 0);
        assertEquals(await limiter.consume(`analytics-identify:user:${U1}`, 2, 600), 0);
        await assertRejects(() => limiter.consume("analytics-other:ip:198.51.100.1", 2, 600));
      });

      let s1 = "";
      let s2 = "";
      let s3 = "";
      await t.step("one subject per account per device, never the account id", async () => {
        const a = await store.issueSubject(U1, P1);
        const again = await store.issueSubject(U1, P1);
        const otherDevice = await store.issueSubject(U1, P2);
        const otherAccount = await store.issueSubject(U2, P1);
        assert(a.state === "active" && again.state === "active" && otherDevice.state === "active" &&
          otherAccount.state === "active");
        assertEquals(again.subject, a.subject);
        assertNotEquals(otherDevice.subject, a.subject);
        assertNotEquals(otherAccount.subject, a.subject);
        for (const s of [a.subject, otherDevice.subject, otherAccount.subject]) {
          assert(![U1, U2, U3].includes(s), "a subject is never an account id");
        }
        s1 = a.subject;
        s2 = otherDevice.subject;
        s3 = otherAccount.subject;
        assertEquals(await store.subjectActive(s1), true);
        // The database stores a hash of the proof, never the proof.
        assertEquals(
          (await admin`select pg_catalog.count(*)::int as n from private.analytics_subjects
            where origin_key = pg_catalog.decode(${P1}, 'hex')`)[0].n,
          0,
        );
      });

      let job = "";
      await t.step("NEGATIVE CONTROL: a device erasure cannot name another device's id or an account id", async () => {
        assertEquals(await store.beginDeviceErasure(P1, [N1, s2]), "refused");
        assertEquals(await store.beginDeviceErasure(P1, [U3]), "refused");
        assertEquals(await store.beginDeviceErasure(P1, [N1, SEEDED[0]!]), "refused");
        assertEquals(
          (await admin`select pg_catalog.count(*)::int as n from private.analytics_erasure_jobs`)[0].n,
          0,
          "a refused request leaves nothing behind",
        );
        assertEquals((await subjects(P1)).every((s) => s.retired_reason === null), true);
        // Malformed requests are refused by shape.
        for (const ids of [[], [N1, N1], [N1, null]]) {
          await assertRejects(() =>
            eraser!`select private.analytics_begin_device_erasure(pg_catalog.decode(${P1}, 'hex'), ${
              `{${ids.map((x) => x ?? "NULL").join(",")}}`
            }::uuid[])`
          );
        }
        await assertRejects(() =>
          eraser!`select private.analytics_begin_device_erasure(pg_catalog.decode(${"ab"}, 'hex'), ${`{${N1}}`}::uuid[])`
        );
      });

      await t.step("device erasure retires only this device's subjects and targets only its ids", async () => {
        const ref = await store.beginDeviceErasure(P1, [N1, N2]);
        assert(ref !== "refused");
        assertEquals(ref.stage, "stop_recorded");
        job = ref.job;
        assertEquals(
          await targets(job),
          [
            { id: N1, kind: "anonymous" },
            { id: N2, kind: "anonymous" },
            ...[{ id: s1, kind: "subject" }, { id: s3, kind: "subject" }].sort((a, b) => (a.id < b.id ? -1 : 1)),
          ].sort((a, b) => (a.id < b.id ? -1 : 1)),
        );
        assertEquals((await subjects(P1)).map((s) => s.retired_reason), ["device_erasure", "device_erasure"]);
        assertEquals((await subjects(P2)).map((s) => s.retired_reason), [null], "the other device is untouched");
        assertEquals(await store.subjectActive(s1), false);
        assertEquals(await store.subjectActive(s2), true);
        // Idempotent: a retry after a lost reply, or a second tab, reaches the same job.
        const retry = await store.beginDeviceErasure(P1, [N1, N2]);
        assert(retry !== "refused");
        assertEquals(retry.job, job);
        const more = await store.beginDeviceErasure(P1, [N3]);
        assert(more !== "refused");
        assertEquals(more.job, job);
        assertEquals((await targets(job)).length, 5);
        assertEquals((await admin`select pg_catalog.count(*)::int as n from private.analytics_erasure_jobs`)[0].n, 1);
        assertEquals(await store.erasureStatus(P1), { job, stage: "stop_recorded" });
        assertEquals(await store.erasureStatus(P3), null);
      });

      await t.step("NEGATIVE CONTROL: a retired subject is never reissued, under any account", async () => {
        assertEquals(await store.issueSubject(U1, P1), { state: "stopped" });
        assertEquals(await store.issueSubject(U3, P1), { state: "stopped" });
        assertEquals((await subjects(P1)).length, 2, "no new subject for the erased device");
        // The all-rows unique index is what makes reissue impossible, even for the owner.
        const duplicate = await rejection(() =>
          admin`insert into private.analytics_subjects(subject_id, user_id, origin_key, epoch, created_at, last_activity_month)
            values (gen_random_uuid(), ${U1}::uuid, extensions.digest(pg_catalog.decode(${P1}, 'hex'), 'sha256'), 0, now(), current_date)`
        );
        assertEquals(duplicate.code, "23505");
      });

      await t.step("the worker lease and the stage machine advance only on provider outcomes", async () => {
        const claimed = await store.claimWork(5, 60);
        assertEquals(claimed.length, 1);
        assertEquals(claimed[0]!.job, job);
        assertEquals(claimed[0]!.targets.length, 5);
        assertEquals(await store.claimWork(5, 60), [], "a leased job is not claimed twice");
        assertEquals(await store.recordOutcome(job, crypto.randomUUID(), "queued"), false, "only the lease holder");
        // A failure never advances, and backs off.
        assertEquals(await store.recordOutcome(job, claimed[0]!.lease, "provider_unavailable"), true);
        const failed = (await admin`select stage, attempts, last_error, lease_token, next_attempt_at > now() as later
          from private.analytics_erasure_jobs where job_id = ${job}::uuid`)[0];
        assertEquals({ ...failed }, {
          stage: "stop_recorded",
          attempts: 1,
          last_error: "provider_unavailable",
          lease_token: null,
          later: true,
        });
        const step = async (outcome: ErasureOutcome) => {
          await admin`update private.analytics_erasure_jobs set next_attempt_at = now() - interval '1 second' where job_id = ${job}::uuid`;
          const [c] = await store.claimWork(5, 60);
          assert(c, "due job claimed");
          assertEquals(await store.recordOutcome(c.job, c.lease, outcome), true);
          return (await admin`select stage, sweeps, attempts, last_error, fence_until is not null as fenced
            from private.analytics_erasure_jobs where job_id = ${job}::uuid`)[0];
        };
        assertEquals({ ...await step("queued") }, {
          stage: "provider_delete_accepted",
          sweeps: 0,
          attempts: 0,
          last_error: null,
          fenced: false,
        });
        // A sweep that finds someone again (a late event) re-deletes and stays where it is.
        assertEquals((await step("queued")).stage, "provider_delete_accepted");
        assertEquals({ ...await step("none_found") }, {
          stage: "provider_delete_confirmed",
          sweeps: 1,
          attempts: 0,
          last_error: null,
          fenced: false,
        });
        assertEquals((await step("provider_partial")).stage, "provider_delete_confirmed");
        assertEquals((await step("none_found")).sweeps, 2);
        assertEquals({ ...await step("none_found") }, {
          stage: "complete",
          sweeps: 3,
          attempts: 0,
          last_error: null,
          fenced: true,
        });
        assertEquals(await store.erasureStatus(P1), { job, stage: "complete" });
        assertEquals(await store.claimWork(5, 60), []);
        // The same request after completion reaches the finished job; nothing restarts.
        const done = await store.beginDeviceErasure(P1, [N1, N2]);
        assert(done !== "refused");
        assertEquals(done, { job, stage: "complete" });
        await assertRejects(() => eraser!`select private.analytics_record_erasure_outcome(${job}::uuid, ${crypto.randomUUID()}::uuid, 'done')`);
      });

      await t.step("account deletion removes its subjects but keeps every erasure target", async () => {
        const before = await targets(job);
        await admin`delete from auth.users where id = ${U2}::uuid`;
        assertEquals((await subjects(P1)).map((s) => s.user), [U1]);
        assertEquals(await targets(job), before, "the fence list survives account deletion");
      });

      await t.step("the real handlers run through the eraser's store end to end", async () => {
        const deleted: string[][] = [];
        const posthog: PostHogErasurePort = {
          canDelete: true,
          deleteByDistinctIds: (ids) => (deleted.push([...ids]), Promise.resolve("queued")),
        };
        const emails: string[] = [];
        const subjectPort: PostHogSubjectPort = {
          canIdentify: true,
          setSubjectEmail: (subject, email) => (emails.push(`${subject}:${email}`), Promise.resolve()),
        };
        const limiter = new PgRateLimiter(eraser!);
        const identify = async (proof: string) =>
          await (await handleAnalyticsIdentify(
            new Request("http://x", {
              method: "POST",
              headers: { Authorization: `Bearer ${await jwt(U3)}`, "cf-connecting-ip": "198.51.100.20" },
              body: JSON.stringify({ originProof: proof }),
            }),
            {
              jwtSecret: JWT_SECRET,
              accounts: {
                account: () => Promise.resolve({ email: "u5w2-three@example.invalid", createdAt: null, analyticsSeen: true }),
                markAnalyticsSeen: () => Promise.resolve(),
              },
              posthog: { canIdentify: true, canDelete: true, setPersonEmail: () => Promise.reject(new Error("legacy")), deletePerson: () => Promise.resolve() },
              subjects: { store, limiter, posthog: subjectPort },
            },
          )).json();
        const issued = await identify(P3);
        assertEquals(issued.state, "active");
        assertEquals(emails, [`${issued.subject}:u5w2-three@example.invalid`]);
        const erase = (body: unknown, headers: Record<string, string> = {}) =>
          handleAnalyticsErasure(
            new Request("http://x", {
              method: "POST",
              headers: { "cf-connecting-ip": "198.51.100.21", ...headers },
              body: JSON.stringify(body),
            }),
            { store, limiter, posthog, workerToken: "u5w2-worker-token" },
          );
        const res = await erase({ action: "device", originProof: P3, anonymousIds: [N3] });
        assertEquals([res.status, await res.json()], [202, { state: "requested" }]);
        assertEquals(await identify(P3), { state: "stopped" });
        const work = await erase({ action: "work" }, { Authorization: "u5w2-worker-token" });
        assertEquals(await work.json(), { claimed: 1, advanced: 1, failed: 0, lost: 0 });
        assertEquals(deleted, [[N3, issued.subject].sort()]);
        assertEquals(await (await erase({ action: "status", originProof: P3 })).json(), { state: "verifying" });
      });
    } finally {
      await eraser?.end();
      // Synthetic rows out, and the role back to the migration's state: no LOGIN, no password.
      await admin`delete from private.analytics_erasure_jobs`;
      await admin`delete from private.analytics_subjects`;
      await admin`delete from auth.users where id in (${U1}::uuid, ${U2}::uuid, ${U3}::uuid)`;
      await admin.unsafe("alter role still_analytics_eraser nologin password null");
      await gateway.end();
      await admin.end();
    }
  },
});
