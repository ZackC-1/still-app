// Disposable PostgreSQL only. See docs/release/counter-retention.md for the isolated setup.
import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import { PgRateLimiter } from "../functions/_shared/pg-store.ts";
import { enforceRateLimit } from "../functions/_shared/rate-limit.ts";

import { handleDeleteUser } from "../functions/delete-user/handler.ts";
import { SupabaseUserStore } from "../functions/_shared/supabase-store.ts";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "../functions/_shared/test-helpers.ts";

const databaseUrl = Deno.env.get("STILL_RETENTION_TEST_DATABASE_URL");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const IP = "203.0.113.42";
const POLICY = { maxPerUser: 10, maxPerIp: 2, windowSeconds: 60 };

Deno.test({
  name: "retention: real limiter, persisted counters and account deletion",
  ignore: !databaseUrl,
  async fn(t) {
    const target = new URL(databaseUrl!);
    assertEquals(target.hostname, "127.0.0.1");
    assertEquals(target.port, "55432");
    assertEquals(target.pathname, "/postgres");
    const sql = postgres(databaseUrl!, {
      prepare: false,
      max: 1,
      onnotice: () => {},
    });
    try {
      assertEquals(
        (await sql`select issue from retention_test.synthetic_only`)[0]?.issue,
        152,
      );
      await sql.unsafe(
        `drop function if exists public.sync_rate_limit_account() cascade;
        drop table if exists public.rate_limit_counters, public.rate_limit_window_keys,
          public.profiles, public.entitlements, public.revenuecat_events, public.rule_sets, public.canary_state cascade;
        drop function if exists public.cleanup_rate_limit_counters(), public.sync_rate_limit_account();
        truncate auth.users cascade;`,
      );
      for (
        const name of [
          "0001_init",
          "0002_rls",
          "0003_indexes",
          "0004_seed_rule_set",
          "0005_canary_state",
          "0006_prod_rule_set",
          "0007_entitlements_column_grant",
          "0008_profiles_write_requires_entitlement",
          "0009_profile_settings_server_clock",
          "0010_rate_limits",
          "0011_webhook_event_claims",
          "0012_profiles_write_free_sync",
        ]
      ) {
        await sql.unsafe(
          await Deno.readTextFile(
            new URL(`../migrations/${name}.sql`, import.meta.url),
          ),
        );
      }
      await sql`insert into auth.users (id, email) values (${A}, 'a@example.invalid'), (${B}, 'b@example.invalid')`;
      await sql`insert into public.profiles(id, settings) values (${B}, '{"globalOn":true}')`;
      await sql`insert into auth.identities(provider_id, user_id, identity_data, provider) values
        (${A}, ${A}, jsonb_build_object('sub', ${A}::text, 'email', 'a@example.invalid'), 'email'),
        (${B}, ${B}, jsonb_build_object('sub', ${B}::text, 'email', 'b@example.invalid'), 'email')`;
      const identityBefore = await sql`select to_jsonb(i) as value from auth.identities i where user_id = ${B}`;
      const preserved = await sql`select to_jsonb(p) as value from public.profiles p`;
      await sql`insert into public.rate_limit_counters(bucket_key, window_start, count) values
        ('reconcile:ip:203.0.113.42', now() - interval '3 days', 1),
        ('review-signin:verify:ip:198.51.100.7', now(), 2),
        (${`reconcile:user:${A}`}, now(), 1), ('review-signin:request:user:a@example.invalid', now(), 1)`;
      await sql.unsafe(
        await Deno.readTextFile(
          new URL("../migrations/0013_counter_retention.sql", import.meta.url),
        ),
      );
      await t.step(
        "forward migration purges legacy identifiers and preserves unrelated data",
        async () => {
          assertEquals(
            (await sql`select count(*)::int as n from public.rate_limit_counters`)[
              0
            ].n,
            0,
          );
          assertEquals(
            await sql`select to_jsonb(p) as value from public.profiles p`,
            preserved,
          );
          assertEquals(
            (await sql`select count(*)::int as n from auth.users where id in (${A}, ${B})`)[
              0
            ].n,
            2,
          );
        },
      );
      await sql.unsafe(
        `create table if not exists retention_test.clock(instant timestamptz not null);
        truncate retention_test.clock; insert into retention_test.clock values ('2029-01-01T00:00:00Z');
        create or replace function retention_test.now() returns timestamptz language sql as
        'select instant from retention_test.clock';`,
      );
      for (
        const name of ["consume_rate_limit", "cleanup_rate_limit_counters"]
      ) {
        const rows =
          await sql`select pg_get_functiondef(oid) as definition from pg_proc where pronamespace = 'public'::regnamespace and proname = ${name}`;
        assertEquals(rows.length, 1);
        await sql.unsafe(
          rows[0].definition.replaceAll(
            "clock_timestamp()",
            "retention_test.now()",
          ),
        );
      }
      const limiter = new PgRateLimiter(sql);
      const request = (ip = IP) =>
        new Request("https://synthetic.invalid", {
          headers: { "cf-connecting-ip": ip },
        });

      const originalFetch = globalThis.fetch;
      let authFailure = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        assertEquals(url.origin, "https://synthetic.invalid");
        assertEquals(init?.method, "DELETE");
        assertEquals(JSON.parse(String(init?.body)), { should_soft_delete: false });
        const subject = url.pathname.split("/").at(-1)!;
        if (authFailure) {
          return new Response(
            JSON.stringify({ msg: "Synthetic auth unavailable" }),
            { status: 503 },
          );
        }
        try {
          const removed = await sql`delete from auth.users where id = ${subject} returning id`;
          return new Response(
            JSON.stringify(
              removed.length ? { id: subject } : { msg: "User not found" },
            ),
            {
              status: removed.length ? 200 : 404,
              headers: { "content-type": "application/json" },
            },
          );
        } catch {
          return new Response(
            JSON.stringify({ msg: "Synthetic cleanup failure" }),
            { status: 500 },
          );
        }
      };
      const store = new SupabaseUserStore(
        "https://synthetic.invalid",
        "synthetic-service-key",
      );
      const secret = "synthetic-test-jwt-secret-at-least-32-characters";
      const deleteAccount = async (subject: string, authorized = true) =>
        handleDeleteUser(
          new Request("https://synthetic.invalid", {
            method: "POST",
            headers: {
              "cf-connecting-ip": "192.0.2.99", // Deletion happens from a third connection.
              ...(authorized
                ? {
                  Authorization: `Bearer ${await mintHs256(
                    { sub: subject },
                    secret,
                  )}`,
                }
                : {}),
            },
          }),
          { store, jwtSecret: secret, expected: TEST_EXPECTED_CLAIMS },
        );
      try {
        await t.step(
          "no raw IP is persisted; accounts on one connection share its existing cap",
          async () => {
            assertEquals(
              await enforceRateLimit(
                limiter,
                "reconcile",
                A,
                request(),
                POLICY,
              ),
              null,
            );
            assertEquals(
              await enforceRateLimit(
                limiter,
                "reconcile",
                B,
                request(),
                POLICY,
              ),
              null,
            );
            const blocked = await enforceRateLimit(
              limiter,
              "reconcile",
              B,
              request(),
              POLICY,
            );
            assertEquals(blocked?.status, 429);
            assert(Number(blocked?.headers.get("retry-after")) > 0);
            const rows = await sql`select bucket_key from public.rate_limit_counters`;
            assertEquals(rows.length, 3);
            assertEquals(rows.some((r) => r.bucket_key.includes(IP)), false);
          },
        );
        await t.step(
          "delete removes account counters from every IP, preserves shared protection and other accounts",
          async () => {
            await sql`insert into public.profiles(id, settings) values (${A}, '{"globalOn":false}'), (${B}, '{"globalOn":true}') on conflict do nothing`;
            await sql`insert into public.entitlements(user_id, still_sync) values (${A}, true), (${B}, false)`;
            await enforceRateLimit(
              limiter,
              "reconcile",
              A,
              request("198.51.100.7"),
              POLICY,
            );
            const otherBefore = await sql`select to_jsonb(p) as value from public.profiles p where id = ${B}`;
            const sharedBefore = await sql`select to_jsonb(c) as value from public.rate_limit_counters c where bucket_key like '%:ip:%' order by bucket_key`;
            assertEquals((await deleteAccount(A, false)).status, 401);
            assertEquals((await deleteAccount(A)).status, 200);
            assertEquals(await sql`select to_jsonb(c) as value from public.rate_limit_counters c where bucket_key like '%:ip:%' order by bucket_key`, sharedBefore);
            assertEquals(await sql`select to_jsonb(i) as value from auth.identities i where user_id = ${B}`, identityBefore);
            assertEquals((await sql`select count(*)::int as n from auth.identities where user_id = ${A}`)[0].n, 0);
            assertEquals(
              (await sql`select count(*)::int as n from public.rate_limit_counters where account_id = ${A}`)[
                0
              ].n,
              0,
            );
            assertEquals(
              (await sql`select count(*)::int as n from public.rate_limit_counters where account_id = ${B}`)[
                0
              ].n,
              1,
            );
            assertEquals(
              await sql`select to_jsonb(p) as value from public.profiles p where id = ${B}`,
              otherBefore,
            );
            assertEquals(
              (await sql`select still_sync from public.entitlements where user_id = ${B}`)[
                0
              ].still_sync,
              false,
            );
            assertEquals(
              (await sql`select count(*)::int as n from public.profiles where id = ${A}`)[
                0
              ].n,
              0,
            );
            assertEquals(
              (await sql`select count(*)::int as n from public.entitlements where user_id = ${A}`)[
                0
              ].n,
              0,
            );
            assertEquals(
              (await enforceRateLimit(
                limiter,
                "reconcile",
                B,
                request(),
                POLICY,
              ))?.status,
              429,
            );
            assertEquals((await deleteAccount(A)).status, 200);
            assertEquals(
              (await deleteAccount("33333333-3333-4333-8333-333333333333"))
                .status,
              200,
            );
            await assertRejects(() => limiter.consume(`reconcile:user:${A}`, 10, 60));
          },
        );
        await t.step(
          "email counters created before account creation are removed on deletion",
          async () => {
            const c = "33333333-3333-4333-8333-333333333333";
            await limiter.consume(
              "review-signin:request:user:c@example.invalid",
              5,
              600,
            );
            await sql`insert into auth.users(id, email) values (${c}, 'c@example.invalid')`;
            await sql`update auth.users set email = 'changed@example.invalid' where id = ${c}`;
            await limiter.consume("review-signin:request:user:c@example.invalid", 5, 600);
            assertEquals((await deleteAccount(c)).status, 200);
            assertEquals(
              (await sql`select count(*)::int as n from public.rate_limit_counters where bucket_key like 'review-signin:request:user:%'`)[
                0
              ].n,
              0,
            );
          },
        );
        await t.step(
          "auth and transactional cleanup failures return generic errors and remain retryable",
          async () => {
            const d = "44444444-4444-4444-8444-444444444444";
            await sql`insert into auth.users(id, email) values (${d}, 'd@example.invalid')`;
            await limiter.consume(`reconcile:user:${d}`, 10, 60);
            authFailure = true;
            let failed = await deleteAccount(d);
            assertEquals(failed.status, 500);
            assertEquals(await failed.json(), { error: "internal" });
            assertEquals(
              (await sql`select count(*)::int as n from auth.users where id = ${d}`)[
                0
              ].n,
              1,
            );
            authFailure = false;
            await sql.unsafe(
              `create or replace function retention_test.fail_cleanup() returns trigger language plpgsql as
          $$begin raise exception 'Synthetic cleanup failure'; end;$$;
          create trigger synthetic_cleanup_failure before delete on public.rate_limit_counters
          for each row execute function retention_test.fail_cleanup();`,
            );
            try {
              failed = await deleteAccount(d);
              assertEquals(failed.status, 500);
              assertEquals(await failed.json(), { error: "internal" });
              assertEquals(
                failed.headers.get("access-control-allow-origin"),
                "*",
              );
              assertEquals(
                (await sql`select count(*)::int as n from auth.users where id = ${d}`)[
                  0
                ].n,
                1,
              );
              assertEquals(
                (await sql`select count(*)::int as n from public.rate_limit_counters where account_id = ${d}`)[
                  0
                ].n,
                1,
              );
            } finally {
              await sql`drop trigger synthetic_cleanup_failure on public.rate_limit_counters`;
            }
            assertEquals((await deleteAccount(d)).status, 200);
            assertEquals(
              (await sql`select count(*)::int as n from public.rate_limit_counters where account_id = ${d}`)[
                0
              ].n,
              0,
            );
          },
        );
        await t.step(
          "least privilege and stored expiry cannot be bypassed by client roles",
          async () => {
            for (
              const role of [
                "anon",
                "authenticated",
                "service_role",
                "still_entitlement_writer",
              ]
            ) {
              const privileges = await sql`select
            has_table_privilege(${role}, 'public.rate_limit_counters', 'SELECT') as counters,
            has_table_privilege(${role}, 'public.rate_limit_window_keys', 'SELECT') as keys,
            has_function_privilege(${role}, 'public.cleanup_rate_limit_counters()', 'EXECUTE') as cleanup,
            has_function_privilege(${role}, 'public.consume_rate_limit(text,integer,integer)', 'EXECUTE') as consume`;
              assertEquals(privileges[0], {
                counters: false,
                keys: false,
                cleanup: false,
                consume: role === "still_entitlement_writer",
              });
            }
            await sql.begin(async (tx) => {
              await tx`set local role still_entitlement_writer`;
              assertEquals(
                await new PgRateLimiter(tx as unknown as typeof sql).consume(
                  `checkout:user:${B}`,
                  5,
                  60,
                ),
                0,
              );
            });
            await assertRejects(() => limiter.consume(`reconcile:user:${B}`, 10, 86400));
            await assertRejects(() =>
              sql`update public.rate_limit_counters set expires_at = expires_at + interval '1 day'`
            );
            await assertRejects(() => sql`update public.rate_limit_window_keys set expires_at = 'infinity'`);
          },
        );
        await t.step("persisted window lifetimes are finite", async () => {
          await assertRejects(() =>
            sql`insert into public.rate_limit_window_keys
            (window_start, window_seconds, secret, expires_at) values
            ('infinity', 60, decode('00', 'hex'), 'infinity')`
          );
        });
        await t.step(
          "a limiter racing account deletion cannot recreate an account-linked counter",
          async () => {
            const e = "55555555-5555-4555-8555-555555555555";
            const competing = postgres(databaseUrl!, {
              prepare: false,
              max: 1,
              onnotice: () => {},
            });
            try {
              const pid = (await competing`select pg_backend_pid() as pid`)[0].pid;
              for (const deletionFirst of [false, true]) {
                await sql`insert into auth.users(id, email) values (${e}, 'e@example.invalid')`;
                let pending: Promise<unknown>;
                await sql.begin(async (tx) => {
                  if (deletionFirst) {
                    await tx`delete from auth.users where id = ${e}`;
                    pending = new PgRateLimiter(competing).consume(
                      `reconcile:user:${e}`,
                      10,
                      60,
                    )
                      .then(() => "unexpected success", () => "refused");
                  } else {
                    await new PgRateLimiter(tx as unknown as typeof sql)
                      .consume(`reconcile:user:${e}`, 10, 60);
                    pending = competing`delete from auth.users where id = ${e}`
                      .then(() => "deleted");
                  }
                  let blocked = false;
                  for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
                    blocked = (await tx`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`)[
                      0
                    ].blocked;
                    if (!blocked) {
                      await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                  }
                  assert(
                    blocked,
                    "The competing operation must wait on the real database lock",
                  );
                });
                assertEquals(
                  await pending!,
                  deletionFirst ? "refused" : "deleted",
                );
                assertEquals(
                  (await sql`select count(*)::int as n from public.rate_limit_counters where account_id = ${e}`)[
                    0
                  ].n,
                  0,
                );
              }
            } finally {
              await competing.end();
            }
          },
        );
        await t.step(
          "expired persisted rows and window secrets are physically removed without another request",
          async () => {
            await sql`update retention_test.clock set instant = '2030-01-01T00:00:00Z'`;
            await sql`select public.cleanup_rate_limit_counters()`;
            await enforceRateLimit(limiter, "reconcile", B, request(), POLICY);
            await limiter.consume(
              "review-signin:verify:ip:203.0.113.42",
              30,
              600,
            );
            const before = await sql`select bucket_key, expires_at from public.rate_limit_counters order by bucket_key`;
            assertEquals(before.length, 3);
            assertEquals(before.map((r) => r.expires_at.toISOString()).sort(), [
              "2030-01-01T00:01:00.000Z",
              "2030-01-01T00:01:00.000Z",
              "2030-01-01T00:10:00.000Z",
            ]);
            await sql`update retention_test.clock set instant = '2030-01-01T00:01:00Z'`;
            await sql`select public.cleanup_rate_limit_counters()`;
            assertEquals(
              (await sql`select count(*)::int as n from public.rate_limit_counters`)[
                0
              ].n,
              1,
            );
            await enforceRateLimit(limiter, "reconcile", B, request(), POLICY);
            const after =
              await sql`select bucket_key from public.rate_limit_counters where bucket_key like 'reconcile:ip:%'`;
            assertEquals(
              before.some((r) => r.bucket_key === after[0].bucket_key),
              false,
            );
            await sql`update retention_test.clock set instant = '2030-01-01T00:10:00Z'`;
            await sql`select public.cleanup_rate_limit_counters()`;
            assertEquals(
              (await sql`select count(*)::int as n from public.rate_limit_counters`)[
                0
              ].n,
              0,
            );
            assertEquals(
              (await sql`select count(*)::int as n from public.rate_limit_window_keys`)[
                0
              ].n,
              0,
            );
          },
        );
        await t.step(
          "cleanup failure refuses traffic; the real scheduled job recovers without returning traffic",
          async () => {
            await limiter.consume(`checkout:user:${B}`, 5, 60);
            await sql`update retention_test.clock set instant = '2030-01-01T00:11:00Z'`;
            await sql.unsafe(
              `create trigger synthetic_cleanup_failure before delete on public.rate_limit_window_keys
          for each row execute function retention_test.fail_cleanup();`,
            );
            try {
              await assertRejects(() => sql`select public.cleanup_rate_limit_counters()`);
              await assertRejects(() => enforceRateLimit(limiter, "reconcile", B, request(), POLICY));
              assertEquals(
                (await sql`select count(*)::int as n from public.rate_limit_counters`)[
                  0
                ].n,
                1,
              );
            } finally {
              await sql`drop trigger synthetic_cleanup_failure on public.rate_limit_window_keys`;
            }
            const job =
              (await sql`select jobid, schedule, active from cron.job where jobname = 'still-rate-limit-retention'`)[
                0
              ];
            assertEquals(job.schedule, "* * * * *");
            assertEquals(job.active, true);
            const started = Date.now();
            let remaining = 1;
            while (remaining > 0 && Date.now() - started < 65000) {
              await new Promise((resolve) => setTimeout(resolve, 250));
              remaining = (await sql`select count(*)::int as n from public.rate_limit_counters`)[
                0
              ].n;
            }
            assertEquals(
              remaining,
              0,
              "The actual cron job must physically remove idle expired rows",
            );
            assertEquals(
              (await sql`select count(*)::int as n from public.rate_limit_window_keys`)[
                0
              ].n,
              0,
            );
            const run =
              (await sql`select status from cron.job_run_details where jobid = ${job.jobid} order by runid desc limit 1`)[
                0
              ];
            assertEquals(run.status, "succeeded");
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await sql.end();
    }
  },
});
