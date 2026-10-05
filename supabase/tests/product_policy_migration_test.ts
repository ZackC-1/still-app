// Migration 0016 (product policy store) against a real, disposable Supabase database.
//
// Runs only when STILL_U6_POLICY_TEST_DATABASE_URL points at the loopback database created for the
// test (a rehearsal on a GitHub-hosted runner, or an explicitly approved local disposable stack). A
// skipped run is not evidence. Nothing here is hosted or production evidence.
//
// Modes (STILL_U6_POLICY_TEST_MODE):
//   pre-upgrade  the database is exactly at 0015 with product_policy_migration_seed.sql loaded: the
//                deploy runner's post-apply check reports exactly the missing end state.
//   upgrade      then `supabase migration up`: proves 0016 preserves every existing row.
//   clean        `supabase db reset` to head; the test seeds the same rows itself.
//
// The owner and public routes run through the real handlers and Postgres stores, logged in as the
// narrow roles. The ordinary postgres role (which holds the automatic admin option on them) gives
// them disposable synthetic logins here and removes them again at the end; production never sends
// a cleartext password in SQL text (see the owner steps in scripts/backend/README.md). Every account
// is synthetic and the cutoff snapshot used here is a labelled test value, not the owner's answer to
// question 6.
import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import { signHs256 } from "../functions/_shared/jwt.ts";
import { handleProductPolicyRead } from "../functions/product-policy/handler.ts";
import { PgPolicyReader } from "../functions/product-policy/pg-policy-reader.ts";
import { renderDraft } from "../functions/product-policy/policy-wire.ts";
import { handleProductPolicyAdmin } from "../functions/product-policy-admin/handler.ts";
import { PgPolicyAdminStore } from "../functions/product-policy-admin/pg-policy-admin-store.ts";
import type { PaidCutoffSnapshot } from "../functions/product-policy-admin/cutoff.ts";
import type { PolicyAdminStore } from "../functions/product-policy-admin/store.ts";
import { connection } from "./synthetic_settings_helpers.ts";

const databaseUrl = Deno.env.get("STILL_U6_POLICY_TEST_DATABASE_URL");
const mode = Deno.env.get("STILL_U6_POLICY_TEST_MODE");
const gatewayPassword = Deno.env.get("STILL_GRANTS_GATEWAY_PASSWORD") ?? "postgres";
const READER_PASSWORD = "u6p-synthetic-policy-reader-only";
const ADMIN_PASSWORD = "u6p-synthetic-policy-admin-only";
const JWT_SECRET = "u6p-synthetic-policy-jwt-secret-32-chars";
const MIGRATION = "0016_product_policy.sql";

const OWNER = "e3e3e3e3-0000-4000-8000-000000000003";
const SECOND = "e4e4e4e4-0000-4000-8000-000000000004";
const STRANGER = "e5e5e5e5-0000-4000-8000-000000000005";
// Labelled synthetic snapshot: proves the write-once mechanics only.
const SYNTHETIC_CUTOFF: PaidCutoffSnapshot = {
  product: "synthetic-free-era",
  benefits: ["facebook.reels", "instagram.reels", "youtube.shorts"],
};

const READER_ROUTES = ["private.read_product_policy(text,text)"];
const ADMIN_ROUTES = [
  "private.read_product_policy_state(uuid,text,text)",
  "private.preview_product_policy(uuid,text,text,bigint,text,bigint)",
  "private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])",
];
const HELPERS = [
  "private.product_policy_refuse_change()",
  "private.product_policy_render(text,jsonb)",
  "private.product_policy_body_valid(text,text,bigint,text)",
  "private.product_policy_sales_activates(text)",
];
const TABLES = [
  "private.product_policy_owners",
  "private.product_policy_operations",
  "private.product_policy_revisions",
  "private.paid_cutoff",
];
const ROLES = [
  "public",
  "anon",
  "authenticated",
  "service_role",
  "still_entitlement_writer",
  "still_settings_writer",
  "still_policy_reader",
  "still_policy_admin",
];
const SURFACES = [
  "chrome_desktop",
  "edge_desktop",
  "firefox_desktop",
  "firefox_android",
  "apple_mobile_host",
  "apple_macos_host",
] as const;

const options = { prepare: false, max: 1, onnotice: () => {} } as const;
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type PgError = Error & { code?: string };
type Json = Record<string, unknown>;

const migrationSource = () => Deno.readTextFile(new URL(`../migrations/${MIGRATION}`, import.meta.url));
const verificationSource = () =>
  Deno.readTextFile(new URL("../../scripts/backend/deploy/verify/0016_product_policy.sql", import.meta.url));
const seedSource = () => Deno.readTextFile(new URL("./product_policy_migration_seed.sql", import.meta.url));

/** The deploy runner's read-only post-apply check: its JSON array of open issue codes. */
async function verify(sql: Sql): Promise<string[]> {
  return await sql.begin(async (tx) => {
    await tx`set transaction read only`;
    const rows = await tx.unsafe(await verificationSource());
    return JSON.parse(String(Object.values(rows[0])[0]));
  });
}
/** The migration with each listed reviewed statement removed exactly once. */
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

// Every ACL, configuration, body hash, trigger, default ACL and membership 0016 can affect.
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
          'column', a.attname, 'type', a.atttypid::regtype::text, 'acl', a.attacl::text) order by a.attnum)
          from pg_catalog.pg_attribute a
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped))
        order by n.nspname, c.relname)
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S', 'i')),
      'triggers', (select jsonb_agg(jsonb_build_object('trigger', t.tgname, 'relation', t.tgrelid::regclass::text,
        'type', t.tgtype, 'enabled', t.tgenabled, 'function', t.tgfoid::regprocedure::text)
        order by t.tgrelid::regclass::text, t.tgname)
        from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and not t.tgisinternal),
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
      'roles', (select jsonb_agg(jsonb_build_object('role', r.rolname, 'attributes', jsonb_build_array(
        r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolreplication, r.rolbypassrls),
        'settings', (select s.setconfig from pg_catalog.pg_db_role_setting s
          where s.setrole = r.oid and s.setdatabase = 0)) order by r.rolname)
        from pg_catalog.pg_roles r where r.rolname in ('still_policy_reader', 'still_policy_admin'))
    ) as state
  `)[0].state;
}

const surfaces = (on: readonly string[]) => Object.fromEntries(SURFACES.map((s) => [s, on.includes(s)]));
const ratingDraft = (master: boolean, on: readonly string[] = ["chrome_desktop"]) => ({
  master,
  surfaces: surfaces(on),
  builds: [{ surface: "chrome_desktop", build: "3.0.0" }, { surface: "apple_mobile_host", build: "3.0.0" }],
});
const salesDraft = (
  salesEnabled: boolean,
  web: boolean,
  apple: boolean,
  builds = [{ surface: "chrome_desktop", build: "3.0.0" }, { surface: "apple_mobile_host", build: "3.0.0" }],
) => ({
  salesEnabled,
  channels: { apple: { enabled: apple, offer: "still-pro-v3" }, web: { enabled: web, offer: "still-pro-v3" } },
  builds,
});

Deno.test({
  name: "U6-P2: before 0016, its post-apply check reports exactly the missing end state",
  ignore: !databaseUrl || mode !== "pre-upgrade",
  async fn() {
    assert(new URL(databaseUrl!).hostname === "127.0.0.1");
    const admin = postgres(databaseUrl!, options);
    try {
      const versions = (await admin`select version from supabase_migrations.schema_migrations order by version`)
        .map((r) => r.version);
      assertEquals(versions.at(-1), "0015", "the database is exactly at 0015");
      const routines = [
        "private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])",
        "private.preview_product_policy(uuid,text,text,bigint,text,bigint)",
        "private.product_policy_body_valid(text,text,bigint,text)",
        "private.product_policy_refuse_change()",
        "private.product_policy_render(text,jsonb)",
        "private.product_policy_sales_activates(text)",
        "private.read_product_policy(text,text)",
        "private.read_product_policy_state(uuid,text,text)",
      ];
      assertEquals(
        await verify(admin),
        [
          "migration_missing:0016",
          ...["paid_cutoff", "product_policy_operations", "product_policy_owners", "product_policy_revisions"]
            .map((t) => `policy_relation_missing:${t}`),
          ...routines.map((r) => `policy_function_missing:${r}`),
          "role_missing:still_policy_admin",
          "role_missing:still_policy_reader",
          ...[
            "paid_cutoff_no_truncate",
            "paid_cutoff_write_once",
            "product_policy_revisions_no_truncate",
            "product_policy_revisions_write_once",
          ].map((t) => `write_once_trigger:${t}`),
        ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    } finally {
      await admin.end();
    }
  },
});

Deno.test({
  name: "U6-P2: 0016 adds the owner-only policy store, Off by default, with a write-once cutoff",
  ignore: !databaseUrl || (mode !== "upgrade" && mode !== "clean"),
  async fn(t) {
    assert(mode === "upgrade" || mode === "clean", "mode is upgrade or clean");
    const target = new URL(databaseUrl!);
    assert(
      target.hostname === "127.0.0.1" && target.port === "54322",
      "only the disposable loopback database is accepted",
    );
    const admin = postgres(databaseUrl!, options);
    const gateway = postgres(
      Object.assign(new URL(databaseUrl!), { username: "authenticator", password: gatewayPassword }).href,
      options,
    );
    const asClient = <T>(role: string, run: (tx: Tx) => Promise<T>) =>
      gateway.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role })}, true)`;
        await tx.unsafe(`set local role ${role}`);
        return await run(tx);
      });
    const opened: { reader: Sql | null; admin: Sql | null } = { reader: null, admin: null };

    try {
      const preconditions = await t.step("preconditions: ordinary non-superuser postgres applied 0015 and 0016", async () => {
        assertEquals(
          (await admin`select current_user::text as role, rolsuper from pg_catalog.pg_roles where rolname = current_user`)[0],
          { role: "postgres", rolsuper: false },
        );
        const versions = (await admin`select version from supabase_migrations.schema_migrations order by version`)
          .map((r) => r.version);
        for (const required of ["0014", "0015", "0016"]) assert(versions.includes(required), `${required} applied`);
        assertEquals((await gateway`select session_user::text as login`)[0].login, "authenticator");
      });
      if (!preconditions) return;

      await t.step("the deploy runner's post-apply check reports no open issue after the apply", async () => {
        assertEquals(await verify(admin), []);
      });

      await t.step("existing rows survive byte-for-byte", async () => {
        if (mode === "clean") await admin.unsafe(await seedSource());
        assertEquals((await admin`select * from u6p_fixture.pre_state`)[0], {
          policy_tables: mode === "clean",
          policy_roles: mode === "clean",
        });
        const rows = await admin`select f.name, f.digest = b.digest as same from u6p_fixture.fingerprints f
          full join u6p_fixture.baseline b using (name) order by 1`;
        assertEquals(rows.length, 8);
        for (const row of rows) assertEquals(row.same, true, row.name);
      });

      // Disposable logins for the two narrow roles, then the real stores and handlers.
      await admin.unsafe(`alter role still_policy_reader login password '${READER_PASSWORD}'`);
      await admin.unsafe(`alter role still_policy_admin login password '${ADMIN_PASSWORD}'`);
      opened.reader = connection(databaseUrl!, "still_policy_reader", READER_PASSWORD);
      opened.admin = connection(databaseUrl!, "still_policy_admin", ADMIN_PASSWORD);
      const reader = new PgPolicyReader(opened.reader);
      const store = new PgPolicyAdminStore(opened.admin);
      const readPublic = async (namespace: string, environment: string) => {
        const response = await handleProductPolicyRead(
          new Request("http://127.0.0.1/functions/v1/product-policy", {
            method: "POST",
            body: JSON.stringify({ namespace, environment }),
          }),
          { reader },
        );
        return { status: response.status, text: await response.text(), cache: response.headers.get("cache-control") };
      };
      const owner = async (
        payload: unknown,
        subject = OWNER,
        options: { store?: PolicyAdminStore; cutoff?: PaidCutoffSnapshot | null } = {},
      ) => {
        const token = await signHs256({
          sub: subject,
          exp: Math.floor(Date.now() / 1000) + 600,
          role: "authenticated",
          aud: "authenticated",
        }, JWT_SECRET);
        const response = await handleProductPolicyAdmin(
          new Request("http://127.0.0.1/functions/v1/product-policy-admin", {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
          }),
          { jwtSecret: JWT_SECRET, store: options.store ?? store, cutoffSnapshot: options.cutoff ?? null },
        );
        return { status: response.status, json: await response.json() as Json };
      };
      const preview = (namespace: string, environment: string, expectedRevision: number, draft: unknown, subject = OWNER) =>
        owner({ action: "preview", namespace, environment, expectedRevision, draft }, subject);
      const applyOf = (p: Json, namespace: string, environment: string) => ({
        action: "apply",
        namespace,
        environment,
        expectedRevision: p.expectedRevision,
        operationId: p.operationId,
        previewHash: p.previewHash,
        body: p.body,
      });
      const history = async (namespace: string, environment: string) =>
        (await admin`select revision::int from private.product_policy_revisions
          where namespace = ${namespace} and environment = ${environment} order by revision`).map((r) => r.revision);
      const counts = async () =>
        (await admin`select
          (select count(*)::int from private.product_policy_owners) as owners,
          (select count(*)::int from private.product_policy_operations) as operations,
          (select count(*)::int from private.product_policy_revisions) as revisions,
          (select count(*)::int from private.paid_cutoff) as cutoffs`)[0];

      await t.step("initial Off: no owner, operation, policy or cutoff; every public read is 404", async () => {
        assertEquals(await counts(), { owners: 0, operations: 0, revisions: 0, cutoffs: 0 });
        for (const namespace of ["sales", "rating"]) {
          for (const environment of ["sandbox", "production"]) {
            assertEquals(await reader.read(namespace as "sales", environment as "sandbox"), null);
            assertEquals(await readPublic(namespace, environment), { status: 404, text: "", cache: "no-store" });
          }
        }
      });

      await t.step("catalog privilege matrix is exactly the intended one", async () => {
        const expected = (role: string, routine: string) =>
          READER_ROUTES.includes(routine)
            ? role === "still_policy_reader"
            : ADMIN_ROUTES.includes(routine)
            ? role === "still_policy_admin"
            : false;
        for (const routine of [...READER_ROUTES, ...ADMIN_ROUTES, ...HELPERS]) {
          for (const role of ROLES) {
            const allowed = (await admin`select has_function_privilege(${role}, ${routine}, 'EXECUTE') as allowed`)[0]
              .allowed;
            assertEquals(allowed, expected(role, routine), `${role} ${routine}`);
          }
        }
        for (const table of TABLES) {
          for (const role of ROLES) {
            assertEquals(
              (await admin`select has_table_privilege(${role}, ${table}, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
                or has_any_column_privilege(${role}, ${table}, 'SELECT,INSERT,UPDATE,REFERENCES') as allowed`)[0].allowed,
              false,
              `${role} ${table}`,
            );
          }
        }
        for (const role of ROLES) {
          assertEquals(
            (await admin`select has_schema_privilege(${role}, 'private', 'USAGE') as usage,
              has_schema_privilege(${role}, 'private', 'CREATE') as create`)[0],
            {
              usage: ["still_settings_writer", "still_policy_reader", "still_policy_admin"].includes(role),
              create: false,
            },
            role,
          );
        }
      });

      await t.step("no client role, and neither narrow role beyond its own route, reaches the store", async () => {
        for (const role of ["anon", "authenticated"]) {
          const error = await rejection(() =>
            asClient(role, (tx) => tx`select private.read_product_policy('rating', 'production')`)
          );
          assertEquals(error.code, "42501", role);
        }
        const probes: [Sql, string][] = [
          [opened.reader!, `select private.read_product_policy_state('${OWNER}', 'rating', 'sandbox')`],
          [opened.reader!, "select * from private.product_policy_revisions"],
          [opened.reader!, "insert into private.paid_cutoff values ('sandbox', 'x', '{a}', 1, gen_random_uuid(), now())"],
          [opened.admin!, "select private.read_product_policy('rating', 'sandbox')"],
          [opened.admin!, "select * from private.product_policy_operations"],
          [opened.admin!, `insert into private.product_policy_owners values ('${STRANGER}')`],
          [opened.admin!, "update private.product_policy_revisions set body = body"],
        ];
        for (const [sql, statement] of probes) {
          const error = await rejection(() => sql.unsafe(statement));
          assertEquals(error.code, "42501", statement);
        }
      });

      await t.step("wrong owner: only allowlisted subjects operate, checked by the database", async () => {
        const read = { action: "read", namespace: "rating", environment: "sandbox" };
        assertEquals(await owner(read), { status: 403, json: { error: "forbidden" } }, "not yet allowlisted");
        // The owner's later, separately approved operation, here on synthetic accounts.
        await admin`insert into private.product_policy_owners (user_id) values (${OWNER}), (${SECOND})`;
        assertEquals((await owner(read)).status, 200);
        assertEquals((await owner(read, STRANGER)).status, 403);
        assertEquals((await preview("rating", "sandbox", 0, ratingDraft(true), STRANGER)).status, 403);
        const direct = await rejection(() =>
          opened.admin!`select private.preview_product_policy(${STRANGER}::uuid, 'rating', 'sandbox', 0, ${"{}"}::text, null)`
        );
        assertEquals(direct.code, "28000");
        assertEquals((await counts()).operations, 0);
      });

      await t.step("wrong namespace or environment, and any body outside the grammar, is refused", async () => {
        for (
          const payload of [
            { action: "read", namespace: "pricing", environment: "sandbox" },
            { action: "read", namespace: "cutoff", environment: "sandbox" },
            { action: "read", namespace: "rating", environment: "staging" },
            { action: "preview", namespace: "rating", environment: "sandbox", expectedRevision: 0, draft: { ...ratingDraft(true), url: "x" } },
          ]
        ) {
          assertEquals((await owner(payload)).status, 400, JSON.stringify(payload));
        }
        const valid = renderDraft("rating", "sandbox", 1, ratingDraft(true))!;
        const bodies: [string, string, string, number, string][] = [
          ["pricing namespace", "pricing", "sandbox", 0, valid],
          ["staging environment", "rating", "staging", 0, valid],
          ["wrong environment in body", "rating", "production", 0, valid],
          ["wrong revision in body", "rating", "sandbox", 0, valid.replace('"revision":1', '"revision":2')],
          ["duplicate key", "rating", "sandbox", 0, valid.replace('"master":true', '"master":true,"master":true')],
          ["whitespace", "rating", "sandbox", 0, valid.replace('"master":true', '"master": true')],
          ["unknown key", "rating", "sandbox", 0, valid.replace('"master":true', '"master":true,"url":"https://x"')],
          ["escaped build", "rating", "sandbox", 0, valid.replace('"build":"3.0.0"', '"build":"3.0.\\u0030"')],
          ["reordered keys", "rating", "sandbox", 0, valid.replace('{"schema":1,"environment":"sandbox"', '{"environment":"sandbox","schema":1')],
          ["sales body as rating", "sales", "sandbox", 0, valid],
        ];
        for (const [name, namespace, environment, expected, body] of bodies) {
          const error = await rejection(() =>
            opened.admin!`select private.preview_product_policy(${OWNER}::uuid, ${namespace}, ${environment},
              ${expected}::bigint, ${body}::text, null)`
          );
          assertEquals(error.code, "22023", name);
        }
        assertEquals((await counts()).operations, 0, "no refused request staged anything");
      });

      await t.step("preview, apply, verified readback; the public read serves exactly the body", async () => {
        const p = await preview("rating", "sandbox", 0, ratingDraft(true));
        assertEquals(p.status, 200);
        assert(/^[0-9a-f]{64}$/.test(String(p.json.previewHash)));
        assertEquals([p.json.kind, p.json.expectedRevision, p.json.revision], ["apply", 0, 1]);
        assert(Number(p.json.expiresAt) > Date.now() + 4 * 60_000 && Number(p.json.expiresAt) <= Date.now() + 5 * 60_000 + 5_000);
        const a = await owner(applyOf(p.json, "rating", "sandbox"));
        assertEquals(a.status, 200);
        assertEquals(a.json, {
          status: "applied",
          verified: true,
          replay: false,
          operationId: p.json.operationId,
          revision: 1,
          body: p.json.body,
        });
        const served = await readPublic("rating", "sandbox");
        assertEquals(served, { status: 200, text: String(p.json.body), cache: "no-store" });
        for (const secret of [String(p.json.operationId), String(p.json.previewHash), OWNER, SECOND]) {
          assert(!served.text.includes(secret), "no ledger or owner data is served");
        }
        // Other namespaces and environments stay Off.
        assertEquals((await readPublic("rating", "production")).status, 404);
        assertEquals((await readPublic("sales", "sandbox")).status, 404);
        assertEquals(await history("rating", "sandbox"), [1]);
      });

      await t.step("hash, body, preview or owner mismatch never applies; the exact preview still can", async () => {
        const p = (await preview("rating", "sandbox", 1, ratingDraft(false))).json;
        const exact = applyOf(p, "rating", "sandbox");
        const flipped = String(p.previewHash).replace(/^./, (c) => (c === "0" ? "1" : "0"));
        const otherBody = String(p.body).replace('"master":false', '"master":true');
        const production = String(p.body).replace('"sandbox"', '"production"');
        const refusals: [string, Json, string, number, string][] = [
          ["hash", { ...exact, previewHash: flipped }, OWNER, 409, "hash_mismatch"],
          ["body", { ...exact, body: otherBody }, OWNER, 409, "body_mismatch"],
          ["environment", { ...exact, environment: "production", body: production }, OWNER, 409, "preview_mismatch"],
          ["second owner", exact, SECOND, 403, "wrong_owner"],
          [
            "unknown preview",
            { ...exact, operationId: "99999999-9999-4999-8999-999999999999" },
            OWNER,
            404,
            "unknown_preview",
          ],
        ];
        for (const [name, payload, subject, status, code] of refusals) {
          const r = await owner(payload, subject);
          assertEquals([r.status, r.json.status], [status, code], name);
        }
        assertEquals(await history("rating", "sandbox"), [1], "nothing applied");
        assertEquals((await owner(exact)).json.revision, 2);
      });

      await t.step("stale preview: an expired preview is refused and stays refused", async () => {
        const p = (await preview("rating", "sandbox", 2, ratingDraft(true))).json;
        await admin`update private.product_policy_operations
          set created_at = created_at - interval '10 minutes', expires_at = expires_at - interval '10 minutes'
          where operation_id = ${String(p.operationId)}::uuid`;
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = await owner(applyOf(p, "rating", "sandbox"));
          assertEquals([r.status, r.json.status], [409, "expired"]);
        }
        assertEquals(await history("rating", "sandbox"), [1, 2]);
      });

      let winner: Json = {};
      await t.step("parallel compare-and-set: of two applies on one revision, exactly one commits", async () => {
        const a = (await preview("rating", "sandbox", 2, ratingDraft(true, ["chrome_desktop"]))).json;
        const b = (await preview("rating", "sandbox", 2, ratingDraft(true, ["apple_mobile_host"]))).json;
        // A stale tab that previewed before another apply: refused, never rebased.
        const results = await Promise.all([
          owner(applyOf(a, "rating", "sandbox")),
          owner(applyOf(b, "rating", "sandbox")),
        ]);
        const statuses = results.map((r) => r.status).sort();
        assertEquals(statuses, [200, 409], JSON.stringify(results));
        const lost = results.find((r) => r.status === 409)!;
        assertEquals(lost.json, { status: "stale", currentRevision: 3 });
        assertEquals(await history("rating", "sandbox"), [1, 2, 3]);
        winner = results[0]!.status === 200 ? a : b;
        const loser = winner === a ? b : a;
        const again = await owner(applyOf(loser, "rating", "sandbox"));
        assertEquals([again.status, again.json.status], [409, "stale"]);
        // A fresh preview against the stale revision is refused before anything is staged.
        const stalePreview = await preview("rating", "sandbox", 2, ratingDraft(false));
        assertEquals([stalePreview.status, stalePreview.json], [409, { status: "stale", currentRevision: 3 }]);
      });

      await t.step("timeout after commit reuses the same operation, even after its preview expires", async () => {
        const replay = await owner(applyOf(winner, "rating", "sandbox"));
        assertEquals([replay.status, replay.json.replay, replay.json.revision], [200, true, 3]);
        const c = (await preview("rating", "sandbox", 3, ratingDraft(false))).json;
        // The commit succeeds but the reply is lost on the way back.
        const lossy: PolicyAdminStore = {
          state: (...args) => store.state(...args),
          preview: (...args) => store.preview(...args),
          apply: async (...args) => {
            await store.apply(...args);
            throw new Error("connection reset after commit");
          },
        };
        const original = console.error;
        console.error = () => {};
        try {
          assertEquals((await owner(applyOf(c, "rating", "sandbox"), OWNER, { store: lossy })).status, 500);
        } finally {
          console.error = original;
        }
        assertEquals(await history("rating", "sandbox"), [1, 2, 3, 4], "committed once");
        await admin`update private.product_policy_operations set expires_at = now() - interval '1 second'
          where operation_id = ${String(c.operationId)}::uuid`;
        const retry = await owner(applyOf(c, "rating", "sandbox"));
        assertEquals(retry.json, {
          status: "applied",
          verified: true,
          replay: true,
          operationId: c.operationId,
          revision: 4,
          body: c.body,
        });
        assertEquals(await history("rating", "sandbox"), [1, 2, 3, 4], "never applied twice");
      });

      await t.step("accepted is not verified until the authoritative readback matches", async () => {
        const d = (await preview("rating", "sandbox", 4, ratingDraft(true))).json;
        const blind: PolicyAdminStore = {
          state: () => Promise.reject(new Error("readback timed out")),
          preview: (...args) => store.preview(...args),
          apply: (...args) => store.apply(...args),
        };
        const accepted = await owner(applyOf(d, "rating", "sandbox"), OWNER, { store: blind });
        assertEquals(accepted, { status: 202, json: { status: "checking", operationId: d.operationId, revision: 5 } });
        const confirmed = await owner(applyOf(d, "rating", "sandbox"));
        assertEquals([confirmed.status, confirmed.json.verified, confirmed.json.replay], [200, true, true]);
        const state = await owner({ action: "read", namespace: "rating", environment: "sandbox" });
        assertEquals([state.json.revision, state.json.body, state.json.operationId], [5, d.body, d.operationId]);
      });

      await t.step("rollback republishes earlier values at a NEW revision; revisions never decrease", async () => {
        const first = (await admin`select body from private.product_policy_revisions
          where namespace = 'rating' and environment = 'sandbox' and revision = 1`)[0].body as string;
        const r = await owner({
          action: "preview-rollback",
          namespace: "rating",
          environment: "sandbox",
          expectedRevision: 5,
          sourceRevision: 1,
        });
        assertEquals([r.status, r.json.kind, r.json.rollbackOf, r.json.revision], [200, "rollback", 1, 6]);
        assertEquals(r.json.body, first.replace('"revision":1', '"revision":6'));
        const applied = await owner(applyOf(r.json, "rating", "sandbox"));
        assertEquals([applied.status, applied.json.revision], [200, 6]);
        assertEquals((await readPublic("rating", "sandbox")).text, r.json.body);
        assertEquals(await history("rating", "sandbox"), [1, 2, 3, 4, 5, 6]);
        const before = (await counts()).operations;
        for (const sourceRevision of [6, 7, 99]) {
          const bad = await owner({
            action: "preview-rollback",
            namespace: "rating",
            environment: "sandbox",
            expectedRevision: 6,
            sourceRevision,
          });
          assertEquals(bad.status, 400, String(sourceRevision));
        }
        assertEquals((await counts()).operations, before);
      });

      await t.step("first sales activation needs the cutoff snapshot; without it nothing is written", async () => {
        const p = (await preview("sales", "sandbox", 0, salesDraft(true, true, false))).json;
        const refused = await owner(applyOf(p, "sales", "sandbox"));
        assertEquals([refused.status, refused.json], [409, { status: "cutoff_required" }]);
        assertEquals(await history("sales", "sandbox"), []);
        assertEquals((await counts()).cutoffs, 0);
        assertEquals(
          (await admin`select status from private.product_policy_operations where operation_id = ${String(p.operationId)}::uuid`)[0]
            .status,
          "previewed",
        );
        assertEquals((await readPublic("sales", "sandbox")).status, 404, "sales stays Off");
        // A labelled synthetic snapshot proves the single write-once activation.
        const activated = await owner(applyOf(p, "sales", "sandbox"), OWNER, { cutoff: SYNTHETIC_CUTOFF });
        assertEquals([activated.status, activated.json.revision], [200, 1]);
        const cutoff = await admin`select environment, product, benefits, sales_revision::int, operation_id::text
          from private.paid_cutoff`;
        assertEquals([...cutoff], [{
          environment: "sandbox",
          product: SYNTHETIC_CUTOFF.product,
          benefits: [...SYNTHETIC_CUTOFF.benefits],
          sales_revision: 1,
          operation_id: p.operationId,
        }]);
      });

      await t.step("pause, resume and non-activating sales bodies never create or change a cutoff", async () => {
        const snapshot = async () => [...await admin`select row_to_json(c)::text as row from private.paid_cutoff c order by environment`];
        const before = await snapshot();
        const pause = (await preview("sales", "sandbox", 1, salesDraft(false, true, false))).json;
        assertEquals((await owner(applyOf(pause, "sales", "sandbox"))).json.revision, 2);
        const resume = (await preview("sales", "sandbox", 2, salesDraft(true, true, true))).json;
        assertEquals((await owner(applyOf(resume, "sales", "sandbox"))).json.revision, 3);
        // salesEnabled with every channel off, or only a deferred Edge build, is not an activation.
        const noChannel = (await preview("sales", "production", 0, salesDraft(true, false, false))).json;
        assertEquals((await owner(applyOf(noChannel, "sales", "production"))).json.revision, 1);
        const edgeOnly = (await preview("sales", "production", 1, salesDraft(true, true, false, [{ surface: "edge_desktop", build: "3.0.0" }]))).json;
        assertEquals((await owner(applyOf(edgeOnly, "sales", "production"))).json.revision, 2);
        assertEquals(await snapshot(), before, "one cutoff, unchanged");
        // An invalid snapshot for a real production activation is refused and writes nothing.
        const real = (await preview("sales", "production", 2, salesDraft(true, false, true))).json;
        for (
          const bad of [
            { product: "still-pro-v3", benefits: ["youtube.shorts"] },
            { product: "synthetic-free-era", benefits: ["youtube.shorts", "facebook.reels"] },
            { product: "synthetic-free-era", benefits: [] },
          ]
        ) {
          const r = await owner(applyOf(real, "sales", "production"), OWNER, { cutoff: bad });
          assertEquals(r.status, 400, JSON.stringify(bad));
        }
        assertEquals(await history("sales", "production"), [1, 2]);
        assertEquals(await snapshot(), before);
      });

      await t.step("the cutoff and published revisions are immutable, even for the table owner", async () => {
        const statements: [string, string][] = [
          ["update private.paid_cutoff set product = 'other-product'", "55000"],
          ["update private.paid_cutoff set benefits = '{youtube.shorts}'", "55000"],
          ["delete from private.paid_cutoff", "55000"],
          ["truncate private.paid_cutoff", "55000"],
          [
            `insert into private.paid_cutoff values ('sandbox', 'second-cutoff', '{youtube.shorts}', 9, '${OWNER}', now())`,
            "23505",
          ],
          ["update private.product_policy_revisions set body = body", "55000"],
          ["update private.product_policy_revisions set revision = revision - 1", "55000"],
          ["delete from private.product_policy_revisions where revision = 1", "55000"],
          ["truncate private.product_policy_revisions cascade", "55000"],
        ];
        for (const [statement, code] of statements) {
          const error = await rejection(() => admin.begin((tx) => tx.unsafe(statement)));
          assertEquals(error.code, code, statement);
        }
        assertEquals((await counts()).cutoffs, 1);
        assertEquals(await history("rating", "sandbox"), [1, 2, 3, 4, 5, 6]);
      });

      await t.step("after the owner's operations the post-apply check reports exactly those", async () => {
        assertEquals(await verify(admin), ["cutoff_present", "owner_present", "policy_on"]);
      });

      await t.step("re-applying 0016 changes nothing", async () => {
        const before = await catalogState(admin);
        const data = await counts();
        await admin.begin(async (tx) => {
          assertEquals((await tx`select current_user::text as role`)[0].role, "postgres");
          await tx.unsafe(await migrationSource());
        });
        assertEquals(await catalogState(admin), before);
        assertEquals(await counts(), data);
      });

      await t.step("dropping one of 0016's own revokes or settings makes its self-check abort", async () => {
        const before = await catalogState(admin);
        const schemaRevoke = "revoke all on all functions in schema private from public, anon, authenticated, service_role;";
        const routeRevoke = await (async () => {
          const source = await migrationSource();
          const start = source.indexOf("revoke all on function private.product_policy_refuse_change()");
          return source.slice(start, source.indexOf(";", start) + 1);
        })();
        const tableRevoke = await (async () => {
          const source = await migrationSource();
          const start = source.indexOf("revoke all on table private.product_policy_owners");
          return source.slice(start, source.indexOf(";", start) + 1);
        })();
        const cases: [string, string[], string][] = [
          [
            "grant execute on function private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[]) to authenticated",
            [schemaRevoke, routeRevoke],
            "client_execute:authenticated:private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])",
          ],
          [
            "grant execute on function private.read_product_policy(text,text) to still_policy_admin",
            [routeRevoke],
            "policy_role_execute:still_policy_admin:private.read_product_policy(text,text)",
          ],
          [
            "grant execute on function private.preview_product_policy(uuid,text,text,bigint,text,bigint) to service_role",
            [schemaRevoke, routeRevoke],
            "client_execute:service_role:private.preview_product_policy(uuid,text,text,bigint,text,bigint)",
          ],
          [
            "grant select on private.paid_cutoff to service_role",
            [tableRevoke],
            "policy_relation_grant:paid_cutoff",
          ],
          [
            "grant select on private.product_policy_revisions to still_policy_reader",
            [tableRevoke],
            "policy_role_table:still_policy_reader:private.product_policy_revisions",
          ],
          [
            "alter table private.product_policy_revisions disable row level security",
            ["alter table private.product_policy_revisions enable row level security;"],
            "policy_rls_disabled:product_policy_revisions",
          ],
          [
            "alter role still_policy_admin reset statement_timeout",
            ["alter role still_policy_admin set statement_timeout = '2s';"],
            "role_setting_missing:still_policy_admin:statement_timeout=2s",
          ],
          [
            "drop trigger paid_cutoff_write_once on private.paid_cutoff",
            [
              "create or replace trigger paid_cutoff_write_once\n  before update or delete on private.paid_cutoff\n  for each row execute function private.product_policy_refuse_change();",
            ],
            "write_once_trigger:paid_cutoff_write_once",
          ],
        ];
        for (const [injection, statements, issue] of cases) {
          // With the statements in place the migration repairs the injected state.
          const repaired = await rejection(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(injection);
              await tx.unsafe(await migrationSource());
              throw new Error("rollback repaired probe");
            })
          );
          assertEquals(repaired.message, "rollback repaired probe", injection);
          // Without them, only the self-check stands between the state and a committed migration.
          const error = await rejection(() =>
            admin.begin(async (tx) => {
              await tx.unsafe(injection);
              await tx.unsafe(await without(...statements));
            })
          );
          assertEquals(error.code, "42501", injection);
          assert(
            error.message.startsWith("product policy self-check failed:") && error.message.includes(issue),
            `${injection}: ${error.message}`,
          );
        }
        // A route written with the empty search_path (0014's old form) is refused too.
        const mutant = await replacing(
          "p_expected bigint, p_body text, p_cutoff_product text, p_cutoff_benefits text[]\n) returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$",
          "p_expected bigint, p_body text, p_cutoff_product text, p_cutoff_benefits text[]\n) returns jsonb language plpgsql security definer set search_path = '' as $$",
        );
        const emptyPath = await rejection(() => admin.begin((tx) => tx.unsafe(mutant)));
        assertEquals(emptyPath.code, "42501");
        assert(
          emptyPath.message.includes(
            "unsafe_search_path:private.apply_product_policy(uuid,uuid,text,text,text,bigint,text,text,text[])",
          ),
          emptyPath.message,
        );
        assertEquals(await catalogState(admin), before);
      });

      await t.step("the self-check rejects reach that 0016 does not itself remove", async () => {
        const before = await catalogState(admin);
        const cases: [string, string][] = [
          [
            "create role u6p_bridge; grant still_policy_admin to u6p_bridge; grant u6p_bridge to authenticated",
            "role_granted_to_other:still_policy_admin",
          ],
          ["alter role still_policy_reader inherit", "role_attributes:still_policy_reader"],
          ["grant pg_read_all_data to still_policy_reader", "role_member_of_role:still_policy_reader"],
          ["alter table private.paid_cutoff drop column activated_at", "policy_column:paid_cutoff.activated_at"],
          [
            "alter table private.product_policy_owners drop constraint product_policy_owners_user_id_fkey",
            "policy_owner_no_account_cascade",
          ],
          [
            "alter default privileges for role postgres in schema private grant select on tables to anon",
            "private_default:postgres:r",
          ],
          [
            "create function public.u6p_definer() returns void language sql security definer set search_path = '' as 'select'; grant execute on function public.u6p_definer() to authenticated",
            "client_execute:authenticated:u6p_definer()",
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
            error.message.startsWith("product policy self-check failed:") && error.message.includes(issue),
            `${mutation}: ${error.message}`,
          );
        }
        assertEquals(await catalogState(admin), before);
      });

      await t.step("preconditions refuse another executing role before any DDL", async () => {
        const before = await catalogState(admin);
        const other = await rejection(() =>
          admin.begin(async (tx) => {
            await tx.unsafe("create role u6p_runner; grant u6p_runner to postgres");
            await tx.unsafe("set local role u6p_runner");
            await tx.unsafe(await migrationSource());
          })
        );
        assertEquals([other.code, other.message], ["42501", "product policy migration role precondition"]);
        assertEquals(await catalogState(admin), before);
      });
    } finally {
      await opened.reader?.end();
      await opened.admin?.end();
      // Return both roles to the migration's state: no LOGIN, no password.
      await admin.unsafe("alter role still_policy_reader nologin password null");
      await admin.unsafe("alter role still_policy_admin nologin password null");
      await gateway.end();
      await admin.end();
    }
  },
});
