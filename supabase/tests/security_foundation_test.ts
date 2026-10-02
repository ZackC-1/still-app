// Database integration runs exclusively on an ephemeral GitHub-hosted runner.
// Missing cloud runtime is an explicit skipped/unverified gate, never local evidence of SQL safety.
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

const cloud = Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted";
const databaseUrl = Deno.env.get("STILL_SECURITY_TEST_DATABASE_URL");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const secret = "synthetic-only-jwt-secret-long-enough-for-tests";

async function source(name: string) {
  return await Deno.readTextFile(
    new URL(`../../scripts/backend/sql/${name}.sql`, import.meta.url),
  );
}

// Credential-free constructor smoke uses the same options and bounded permissions as rehearsal.
// No query is issued, so this also runs without network access or a database.
Deno.test("U1: narrow driver permissions permit no-network construction", async () => {
  for (const user of ["postgres", "still_entitlement_writer"]) {
    const sql = postgres(
      `postgresql://${user}:synthetic@127.0.0.1:54322/postgres`,
      {
        prepare: false,
        max: 1,
        onnotice: () => {},
      },
    );
    await sql.end();
  }
});

Deno.test({
  name:
    "U1: actual upgrade, free sync, server writes and final-state grant rejection",
  ignore: !cloud || !databaseUrl,
  async fn(t) {
    const target = new URL(databaseUrl!);
    assertEquals(target.hostname, "127.0.0.1");
    assertEquals(target.port, "54322");
    assertEquals(target.pathname, "/postgres");
    const sql = postgres(databaseUrl!, {
      prepare: false,
      max: 1,
      onnotice: () => {},
    });
    const writerTarget = new URL(databaseUrl!);
    writerTarget.username = "still_entitlement_writer";
    writerTarget.password = "u1-synthetic-only";
    const writer = postgres(writerTarget.href, {
      prepare: false,
      max: 1,
      onnotice: () => {},
    });
    try {
      const inventory = (await sql.unsafe(await source("inventory")))[0]
        .still_security_inventory;
      assertEquals(inventory.server_version.length > 0, true);
      assertEquals(inventory.migration_history.length, 13);
      assertEquals(
        JSON.stringify(inventory).includes("u1-a@example.invalid"),
        false,
      );
      // The CLI clean path has already applied actual checked-in migrations, including 0012/0013.
      assertEquals(
        (await sql`select count(*)::int as n from supabase_migrations.schema_migrations`)[
          0
        ].n,
        13,
      );
      await sql`insert into auth.users(id,email) values (${A}, 'u1-a@example.invalid'), (${B}, 'u1-b@example.invalid'), (${C}, 'u1-c@example.invalid')`;
      await sql`select public.set_entitlement(${B}::uuid,true,'historical','synthetic-sub')`;
      await sql`select public.set_entitlement(${A}::uuid,false,'synthetic-unentitled',null)`;
      await sql`insert into public.profiles(id,settings) values (${A}::uuid,'{"globalOn":true}'::jsonb), (${B}::uuid,'{"globalOn":true}'::jsonb)`;
      const preservedProfileB =
        await sql`select to_jsonb(p) as row from public.profiles p where id=${B}::uuid`;
      const preserved =
        await sql`select to_jsonb(e) as row from public.entitlements e where user_id=${B}::uuid`;
      await sql.unsafe("create sequence public.u1_sequence_probe");
      assertEquals(
        (await sql`select relkind::text as kind from pg_catalog.pg_class where oid in ('auth.instances'::regclass, 'public.entitlements'::regclass, 'public.u1_sequence_probe'::regclass)`)
          .map((r) => r.kind).sort(),
        ["S", "r", "r"],
        "audit catalog includes actual tables and a sequence",
      );
      await sql.unsafe(await source("security-audit-candidate"));
      await t.step(
        "characterize unsafe baseline before changing grants",
        async () => {
          const issues = await sql`select issue from still_security.audit()`;
          assert(issues.some((r) => r.issue === "unpinned_definer"));
          await assertRejects(
            async () => await sql.unsafe(await source("assert-security")),
            Error,
          );
        },
      );
      await sql.begin(async (tx) => {
        await tx.unsafe(await source("hardening-candidate"));
        await tx.unsafe(await source("assert-security"));
      });
      await sql.unsafe(
        "alter role still_entitlement_writer login password 'u1-synthetic-only'",
      );
      const store = new PgEntitlementStore(writer);
      const limiter = new PgRateLimiter(writer);
      const assertion = await source("assert-security");

      const accountIsolation = async (tx: postgres.TransactionSql) => {
        await tx.unsafe("set local role authenticated");
        for (const user of [A, B]) {
          await tx`select set_config('request.jwt.claims',${
            JSON.stringify({ sub: user })
          },true)`;
          assertEquals(
            (await tx`select id from public.profiles`).map((r) => r.id),
            [user],
            "cross-account profile isolation",
          );
          assertEquals(
            (await tx`select user_id from public.entitlements`).map((r) =>
              r.user_id
            ),
            [user],
            "cross-account entitlement isolation",
          );
        }
      };

      const probeMutation = async (
        mutation: string,
        verify: (mutant: postgres.TransactionSql) => Promise<void>,
      ) => {
        await sql.begin(async (tx) => {
          const rollback = new Error("rollback successful mutation probe");
          try {
            await tx.savepoint(async (mutant) => {
              // Injection is outside the expected validator rejection; invalid SQL must fail.
              await mutant.unsafe(mutation);
              await verify(mutant);
              throw rollback;
            });
          } catch (error) {
            if (error !== rollback) throw error;
          }
          await tx.unsafe(assertion);
        });
      };
      await t.step(
        "mixed table/sequence audit rejects each auditor sequence grant and restores clean state",
        async () => {
          assertEquals(
            (await sql`select issue from still_security.audit()`).map((r) =>
              r.issue
            ),
            [],
          );
          for (const privilege of ["USAGE", "SELECT", "UPDATE"]) {
            assertEquals(
              (await sql`select has_sequence_privilege('still_security_auditor','public.u1_sequence_probe',${privilege}) as allowed`)[
                0
              ]
                .allowed,
              false,
            );
            await probeMutation(
              `grant ${privilege} on sequence public.u1_sequence_probe to still_security_auditor`,
              async (mutant) => {
                assertEquals(
                  (await mutant`select has_sequence_privilege('still_security_auditor','public.u1_sequence_probe',${privilege}) as allowed`)[
                    0
                  ]
                    .allowed,
                  true,
                  "sequence grant injection succeeded before validation",
                );
                assertEquals(
                  (await mutant`select issue from still_security.audit()`)
                    .map((r) => r.issue),
                  ["audit_role_not_narrow"],
                );
                await assertRejects(
                  () =>
                    mutant.savepoint((validation) =>
                      validation.unsafe(assertion)
                    ),
                  Error,
                  "Still security assertions failed",
                );
              },
            );
            assertEquals(
              (await sql`select has_sequence_privilege('still_security_auditor','public.u1_sequence_probe',${privilege}) as allowed`)[
                0
              ]
                .allowed,
              false,
              "rollback removed the excessive sequence privilege",
            );
            assertEquals(
              (await sql`select issue from still_security.audit()`).map((r) =>
                r.issue
              ),
              [],
            );
          }
        },
      );
      await t.step(
        "preserve historical rights byte-for-byte and free own-account sync",
        async () => {
          assertEquals(
            await sql`select to_jsonb(e) as row from public.entitlements e where user_id=${B}::uuid`,
            preserved,
          );
          await sql.begin(async (tx) => {
            await tx.unsafe("set local role authenticated");
            await tx`select set_config('request.jwt.claims',${
              JSON.stringify({ sub: A })
            },true)`;
            await tx`select public.write_profile_settings('{"globalOn":false}'::jsonb,'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'::uuid)`;
            assertEquals(
              (await tx`select count(*)::int as n from public.profiles`)[0].n,
              1,
            );
            assertEquals(
              (await tx`select still_sync from public.entitlements`)[0]
                .still_sync,
              false,
            );
          });
          assertEquals(
            (await sql`select settings->>'globalOn' as value from public.profiles where id=${A}::uuid`)[
              0
            ].value,
            "false",
          );
          await sql.begin(accountIsolation);
          assertEquals(
            await sql`select to_jsonb(p) as row from public.profiles p where id=${B}::uuid`,
            preservedProfileB,
          );
        },
      );
      await t.step(
        "two-user hardened isolation rejects broadened profile and entitlement policies",
        async () => {
          for (
            const [policy, table, diagnostic] of [
              [
                "profiles: read own",
                "profiles",
                "cross-account profile isolation",
              ],
              [
                "entitlements: read own",
                "entitlements",
                "cross-account entitlement isolation",
              ],
            ]
          ) {
            await probeMutation(
              `alter policy "${policy}" on public.${table} using (true)`,
              async (mutant) => {
                await assertRejects(
                  () => mutant.savepoint(accountIsolation),
                  Error,
                  diagnostic,
                );
              },
            );
          }
          await sql.begin(accountIsolation);
        },
      );
      await t.step(
        "public rules remain readable and direct valid-input client writes fail",
        async () => {
          await sql.begin(async (tx) => {
            await tx.unsafe("set local role anon");
            assertEquals(
              (await tx`select count(*)::int as n from public.get_current_rule_set()`)[
                0
              ].n,
              1,
            );
          });
          for (const role of ["anon", "authenticated"]) {
            for (
              const [statement, subject] of [
                [
                  `select public.set_entitlement('${A}',true,'forged','forged')`,
                  A,
                ],
                [
                  `update public.entitlements set still_sync=true where user_id='${A}'`,
                  A,
                ],
                // C exists but has no entitlement: this is a valid own-row INSERT, no duplicate PK.
                [
                  `insert into public.entitlements(user_id,still_sync) values ('${C}',true)`,
                  C,
                ],
                [
                  `select public.consume_rate_limit('reconcile:user:${A}',10,60)`,
                  A,
                ],
                [
                  `update public.profiles set settings='{"globalOn":false}'::jsonb where id='${B}'`,
                  A,
                ],
              ]
            ) {
              const denied = await assertRejects(
                () =>
                  sql.begin(async (tx) => {
                    await tx.unsafe(`set local role ${role}`);
                    await tx`select set_config('request.jwt.claims',${
                      JSON.stringify({ sub: subject })
                    },true)`;
                    await tx.unsafe(statement);
                  }),
                Error,
                "permission denied",
              );
              assertEquals((denied as Error & { code?: string }).code, "42501");
            }
          }
        },
      );
      await t.step(
        "actual JWT handler + narrow SQL adapter + rate limiter uses JWT subject",
        async () => {
          const jwt = await mintHs256({ sub: A }, secret);
          const rc = {
            getSubscriber: () =>
              Promise.resolve({
                entitlements: { still_sync: { expires_date: null } },
                original_app_user_id: A,
              }),
          };
          const request = (token: string) =>
            new Request("https://synthetic.invalid", {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              body: JSON.stringify({ userId: B }),
            });
          const deps = {
            jwtSecret: secret,
            expected: TEST_EXPECTED_CLAIMS,
            store,
            rc,
            limiter,
          };
          assertEquals((await handleReconcile(request(jwt), deps)).status, 200);
          assertEquals(
            (await sql`select still_sync from public.entitlements where user_id=${A}::uuid`)[
              0
            ].still_sync,
            true,
          );
          assertEquals(
            await sql`select to_jsonb(e) as row from public.entitlements e where user_id=${B}::uuid`,
            preserved,
          );
          for (
            const claims of [{ sub: A, exp: 1000 }, {
              sub: A,
              iss: "https://wrong.invalid/auth/v1",
            }, { sub: A, role: "anon" }]
          ) {
            assertEquals(
              (await handleReconcile(
                request(await mintHs256(claims, secret)),
                deps,
              )).status,
              401,
            );
          }
          assertEquals(
            (await handleReconcile(
              request(
                await mintHs256(
                  { sub: A },
                  "different-synthetic-secret-long-enough",
                ),
              ),
              deps,
            )).status,
            401,
          );
        },
      );
      await t.step(
        "legitimate webhook/refund and duplicate replay use actual SQL claims",
        async () => {
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
          const req = (token: string) =>
            new Request("https://synthetic.invalid", {
              method: "POST",
              headers: { Authorization: token },
              body: JSON.stringify({
                event: { id: "u1-refund", type: "EXPIRATION", app_user_id: A },
              }),
            });
          assertEquals(
            (await handleWebhook(req("wrong"), {
              token: "synthetic-token",
              store,
              rc,
            })).status,
            401,
          );
          assertEquals(lookups, 0);
          assertEquals(
            (await handleWebhook(req("synthetic-token"), {
              token: "synthetic-token",
              store,
              rc,
            })).status,
            200,
          );
          assertEquals(
            (await handleWebhook(req("synthetic-token"), {
              token: "synthetic-token",
              store,
              rc,
            })).status,
            200,
          );
          assertEquals(lookups, 1);
          assertEquals(
            (await sql`select still_sync from public.entitlements where user_id=${A}::uuid`)[
              0
            ].still_sync,
            false,
          );
        },
      );
      await t.step(
        "provider lookup failure releases SQL claim and the same webhook event retries successfully",
        async () => {
          let lookups = 0;
          const rc = {
            getSubscriber: () => {
              lookups++;
              if (lookups === 1) {
                return Promise.reject(new Error("synthetic lookup failure"));
              }
              return Promise.resolve({
                entitlements: { still_sync: { expires_date: null } },
                original_app_user_id: A,
              });
            },
          };
          const request = () =>
            new Request("https://synthetic.invalid", {
              method: "POST",
              headers: { Authorization: "synthetic-token" },
              body: JSON.stringify({
                event: { id: "u1-retry", type: "RENEWAL", app_user_id: A },
              }),
            });
          const deps = { token: "synthetic-token", store, rc };
          assertEquals((await handleWebhook(request(), deps)).status, 500);
          assertEquals(
            (await sql`select count(*)::int as n from public.revenuecat_events where event_id='u1-retry'`)[
              0
            ].n,
            0,
          );
          assertEquals(
            (await sql`select still_sync from public.entitlements where user_id=${A}::uuid`)[
              0
            ].still_sync,
            false,
          );
          assertEquals((await handleWebhook(request(), deps)).status, 200);
          assertEquals(
            (await sql`select status from public.revenuecat_events where event_id='u1-retry'`)[
              0
            ].status,
            "completed",
          );
          assertEquals(
            (await sql`select still_sync from public.entitlements where user_id=${A}::uuid`)[
              0
            ].still_sync,
            true,
          );
          assertEquals((await handleWebhook(request(), deps)).status, 200);
          assertEquals(lookups, 2);
          assertEquals(
            await sql`select to_jsonb(e) as row from public.entitlements e where user_id=${B}::uuid`,
            preserved,
          );
        },
      );
      await t.step(
        "FINAL assertions reject unsafe grants injected AFTER hardening",
        async () => {
          await sql.unsafe(
            "create table public.u1_customer_probe (payload text); insert into public.u1_customer_probe values ('synthetic-only')",
          );
          const mutants = [
            "grant execute on function public.set_entitlement(uuid,boolean,text,text) to public",
            "grant execute on function public.set_entitlement(uuid,boolean,text,text) to anon",
            "grant execute on function public.set_entitlement(uuid,boolean,text,text) to authenticated",
            "grant update(still_sync) on public.entitlements to authenticated",
            "grant insert on public.entitlements to anon",
            "grant select(source) on public.entitlements to authenticated",
            "alter default privileges for role postgres grant execute on functions to public",
            "alter default privileges for role postgres in schema public grant execute on functions to anon",
            "alter default privileges for role postgres in schema public grant update on tables to authenticated",
            "create role u1_inherited; grant execute on function public.set_entitlement(uuid,boolean,text,text) to u1_inherited; grant u1_inherited to authenticated",
            "grant still_entitlement_writer to authenticated with inherit false, set true",
            "grant still_entitlement_writer to authenticated with admin true, inherit false, set false",
            "create role u1_admin_bridge; grant still_entitlement_writer to u1_admin_bridge with admin true, inherit false, set false; grant u1_admin_bridge to authenticated with inherit false, set true",
            "alter function public.set_entitlement(uuid,boolean,text,text) set search_path = public",
            "alter table public.entitlements disable row level security",
            "grant select on public.entitlements to still_security_auditor",
            "grant usage on schema auth to still_security_auditor; grant select on auth.users to still_security_auditor",
            "grant usage on schema auth to still_security_auditor; grant select(id) on auth.users to still_security_auditor",
            "grant select on public.u1_customer_probe to still_security_auditor",
            "grant select(payload) on public.u1_customer_probe to still_security_auditor",
            "grant execute on function public.set_entitlement(uuid,boolean,text,text) to still_security_auditor",
            "grant execute on function still_security.audit() to authenticated",
          ];
          for (const mutation of mutants) {
            await probeMutation(mutation, async (mutant) => {
              // No repair here: the final validator alone must reject installed unsafe state.
              await assertRejects(
                () =>
                  mutant.savepoint((validation) =>
                    validation.unsafe(assertion)
                  ),
                Error,
                "Still security assertions failed",
              );
            });
          }
        },
      );
      await t.step(
        "audit role can read only status, and partial hardening failure rolls back safely",
        async () => {
          await sql.begin(async (tx) => {
            await tx.unsafe(
              "set local role still_security_auditor; set local transaction read only",
            );
            assertEquals(
              (await tx`select issue from still_security.audit()`).length,
              0,
            );
          });
          for (
            const statement of [
              "select id from auth.users",
              "select id from public.profiles",
              "select user_id from public.entitlements",
              "select payload from public.u1_customer_probe",
              "select last_value from public.u1_sequence_probe",
              `select public.set_entitlement('${A}',true,'forged','forged')`,
              `select public.write_profile_settings('{"globalOn":true}'::jsonb,'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaab'::uuid)`,
              `select public.claim_revenuecat_event('u1-auditor','${A}','{}'::jsonb)`,
            ]
          ) {
            const denied = await assertRejects(
              () =>
                sql.begin(async (tx) => {
                  await tx.unsafe("set local role still_security_auditor");
                  await tx.unsafe(statement);
                }),
              Error,
              "permission denied",
            );
            assertEquals((denied as Error & { code?: string }).code, "42501");
          }
          // Grant injection was rolled back; auth.users must again deny a real auditor read.
          const before =
            (await sql`select has_function_privilege('authenticated','public.write_profile_settings(jsonb,uuid)','EXECUTE') as allowed`)[
              0
            ].allowed;
          assertEquals(before, true);
          const failure = await assertRejects(
            () =>
              sql.begin(async (tx) => {
                await tx.unsafe(await source("hardening-candidate"));
                // Observable safe sentinel: remove free sync EXECUTE, then force rollback.
                await tx.unsafe(
                  "revoke execute on function public.write_profile_settings(jsonb,uuid) from authenticated",
                );
                assertEquals(
                  (await tx`select has_function_privilege('authenticated','public.write_profile_settings(jsonb,uuid)','EXECUTE') as allowed`)[
                    0
                  ].allowed,
                  false,
                );
                await tx.unsafe("select 1/0");
              }),
            Error,
            "division by zero",
          );
          assertEquals((failure as Error & { code?: string }).code, "22012");
          assertEquals(
            (await sql`select has_function_privilege('authenticated','public.write_profile_settings(jsonb,uuid)','EXECUTE') as allowed`)[
              0
            ].allowed,
            before,
          );
          await sql.begin(async (tx) => {
            await tx.unsafe("set local role authenticated");
            await tx`select set_config('request.jwt.claims',${
              JSON.stringify({ sub: A })
            },true)`;
            await tx`select public.write_profile_settings('{"globalOn":true}'::jsonb,'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaac'::uuid)`;
            assertEquals(
              (await tx`select settings->>'globalOn' as value from public.profiles where id=${A}::uuid`)[
                0
              ].value,
              "true",
            );
          });
          await sql.unsafe(await source("assert-security"));
          await sql.begin(accountIsolation);
          assertEquals(
            await sql`select to_jsonb(e) as row from public.entitlements e where user_id=${B}::uuid`,
            preserved,
          );
          assertEquals(
            await sql`select to_jsonb(p) as row from public.profiles p where id=${B}::uuid`,
            preservedProfileB,
          );
        },
      );
    } finally {
      await writer.end();
      await sql.end();
    }
  },
});
