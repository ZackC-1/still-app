// Migration 0024 on the disposable settings rehearsal stack: the released apps' settings RPC
// refuses with a non-retryable code, directly and through the real PostgREST gateway.
//
// Modes (STILL_LEGACY_GUARD_TEST_MODE), run by scripts/backend/rehearse-settings.sh:
//   pre-upgrade  the database is at exactly 0023: the guard still raises 40001 and the 0024 gate
//                reports the old body. The PostgREST probe only records what the local gateway
//                does with 40001 (a hosted PostgREST 14 retries it forever; newer ones answer).
//   upgrade      the CLI then applied 0024 as the ordinary postgres role: the gate is clean, every
//                refusal is PT409 with the same message and no change, PostgREST answers HTTP 409
//                promptly, and no retry loop is left running.
// Synthetic accounts only; loopback runner database and gateway only.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  connection,
  createSyntheticSettingsAuthSession,
} from "./synthetic_settings_helpers.ts";

const cloud = Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted";
const url = Deno.env.get("STILL_LEGACY_GUARD_TEST_DATABASE_URL");
const mode = Deno.env.get("STILL_LEGACY_GUARD_TEST_MODE");
const apiKey = Deno.env.get("STILL_LEGACY_GUARD_API_KEY") ?? "";
const GATE =
  "scripts/backend/deploy/verify/0024_legacy_settings_guard_non_retryable.sql";
const RPC = "http://127.0.0.1:54321/rest/v1/rpc/write_profile_settings";
const MESSAGE = "settings client upgrade required";
const RETRYABLE = ["40001", "40P01"];
const L = "24242424-0000-4000-8000-000000000001"; // released apps only
const S = "24242424-0000-4000-8000-000000000002"; // stored document written by a newer client
const M = "24242424-0000-4000-8000-000000000003"; // has saved through the per-field path
const legacy = {
  globalOn: false,
  services: { youtube: true, instagram: true, facebook: false, tiktok: true },
  pauses: [],
  updatedAt: 1,
};
const newer = { schemaVersion: 2, globalOn: true };

Deno.test({
  name:
    "0024 legacy settings guard: non-retryable refusal, unchanged rows, prompt HTTP 409",
  ignore: !cloud || !url || (mode !== "pre-upgrade" && mode !== "upgrade"),
  async fn(t) {
    const upgraded = mode === "upgrade";
    const code = upgraded ? "PT409" : "40001";
    const ordinary = connection(url!);
    const fixture = connection(
      url!,
      "u1_catalog_fixture",
      "u1-synthetic-fixture-only",
    );
    try {
      const versions =
        (await ordinary`select version from supabase_migrations.schema_migrations order by version`)
          .map((row) => row.version as string);
      assertEquals(versions.at(-1), upgraded ? "0024" : "0023");

      await t.step("the 0024 end-state gate", async () => {
        const issues = (await ordinary.unsafe(await Deno.readTextFile(GATE)))[0]
          .issues as string[];
        if (upgraded) assertEquals(issues, []);
        else {
          assert(issues.includes("migration_version"), JSON.stringify(issues));
          assert(issues.includes("routine_body"), JSON.stringify(issues));
          assert(
            issues.includes("routine_retryable_sqlstate"),
            JSON.stringify(issues),
          );
        }
      });

      // Idempotent synthetic state; both modes run against the same database.
      await fixture`insert into auth.users(id,email) values (${L},'legacy-guard-l@example.invalid'),(${S},'legacy-guard-s@example.invalid'),(${M},'legacy-guard-m@example.invalid') on conflict (id) do nothing`;
      await fixture`insert into public.profiles(id,settings,settings_version,settings_server_updated_at) values(${S},${
        JSON.stringify(newer)
      }::text::jsonb,3,'1970-01-01T00:00:00Z') on conflict(id) do update set settings=excluded.settings,settings_version=excluded.settings_version`;
      await fixture`insert into private.settings_anchors(user_id,lineage,secret,modern_used) values(${M},gen_random_uuid(),decode(repeat('ab',32),'hex'),true) on conflict(user_id) do update set modern_used=true`;

      const legacyWrite = (subject: string, body: unknown) =>
        fixture.begin(async (tx) => {
          await tx`set local role authenticated`;
          await tx`select pg_catalog.set_config('request.jwt.claim.sub',${subject},true)`;
          return await tx`select * from public.write_profile_settings(${
            JSON.stringify(body)
          }::text::jsonb,${crypto.randomUUID()}::uuid)`;
        });
      const snapshot = async (subject: string) => ({
        profile: [
          ...await fixture`select pg_catalog.row_to_json(p)::text as raw from public.profiles p where id=${subject}`,
        ],
        anchor: [
          ...await fixture`select pg_catalog.row_to_json(a)::text as raw from private.settings_anchors a where user_id=${subject}`,
        ],
        identities: [
          ...await fixture`select count(*)::int as n from private.settings_writes where user_id=${subject}`,
        ],
      });

      await t.step(
        "released-app writes keep replacing the row (0012 behaviour)",
        async () => {
          const before =
            (await fixture`select settings_version from public.profiles where id=${L}`)[
              0
            ];
          const row = (await legacyWrite(L, legacy))[0];
          assertEquals(row.settings, legacy);
          assertEquals(
            BigInt(row.settings_version),
            before ? BigInt(before.settings_version) + 1n : 1n,
          );
        },
      );

      await t.step(
        `every refusal raises ${code} with the same message and changes nothing`,
        async () => {
          for (
            const [subject, body] of [
              [S, legacy],
              [M, legacy],
              [L, { ...legacy, schemaVersion: 2 }],
            ] as const
          ) {
            const before = await snapshot(subject);
            const failure = await assertRejects(() =>
              legacyWrite(subject, body)
            ) as Error & { code: string };
            assertEquals(failure.code, code);
            assertEquals(failure.message, MESSAGE);
            if (upgraded) assert(!RETRYABLE.includes(failure.code));
            assertEquals(await snapshot(subject), before);
          }
        },
      );

      const rollbacks = async () =>
        BigInt(
          (await fixture`select xact_rollback from pg_catalog.pg_stat_database where datname=pg_catalog.current_database()`)[
            0
          ].xact_rollback,
        );
      const loopObservation = async () => {
        const start = await rollbacks();
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const looping =
          (await fixture`select count(*)::int as n from pg_catalog.pg_stat_activity where usename='authenticator' and state='active' and query ilike '%write_profile_settings%'`)[
            0
          ].n as number;
        return { rollbacksIn3s: Number((await rollbacks()) - start), looping };
      };

      await t.step("through the real PostgREST gateway", async () => {
        assert(apiKey, "the disposable stack's anon key is required");
        const plain = await createSyntheticSettingsAuthSession(apiKey);
        const guarded = await createSyntheticSettingsAuthSession(apiKey);
        await fixture`insert into public.profiles(id,settings,settings_version,settings_server_updated_at) values(${guarded.subject},${
          JSON.stringify(newer)
        }::text::jsonb,3,'1970-01-01T00:00:00Z') on conflict(id) do update set settings=excluded.settings,settings_version=excluded.settings_version`;
        const call = async (bearer: string) => {
          const started = performance.now();
          try {
            const response = await fetch(RPC, {
              method: "POST",
              headers: {
                apikey: apiKey,
                authorization: `Bearer ${bearer}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                p_settings: legacy,
                p_write_id: crypto.randomUUID(),
              }),
              signal: AbortSignal.timeout(5000),
            });
            const text = await response.text();
            let body: Record<string, unknown> | unknown[] | null = null;
            try {
              body = JSON.parse(text);
            } catch { /* recorded as null */ }
            return {
              status: response.status,
              body,
              elapsedMs: Math.round(performance.now() - started),
            };
          } catch (error) {
            if ((error as Error).name !== "TimeoutError") throw error;
            return {
              status: null,
              body: null,
              elapsedMs: Math.round(performance.now() - started),
            };
          }
        };
        const accepted = await call(plain.bearer);
        assertEquals(accepted.status, 200);
        assertEquals(
          (accepted.body as Record<string, unknown>[])[0].settings,
          legacy,
        );
        const before = await snapshot(guarded.subject);
        const refused = await call(guarded.bearer);
        const error = refused.body as Record<string, unknown> | null;
        // Fixed fields only: no token, account id or settings document is printed.
        console.log(JSON.stringify({
          legacyGuardGateway: {
            mode,
            status: refused.status,
            code: error?.code ?? null,
            elapsedMs: refused.elapsedMs,
          },
        }));
        if (upgraded) {
          assertEquals(refused.status, 409);
          assertEquals(error?.code, "PT409");
          assertEquals(error?.message, MESSAGE);
          assert(refused.elapsedMs < 5000);
        } else {
          // Either the gateway retries 40001 (no answer within the deadline), or it answers with
          // an error; it never accepts the write and never says 409.
          assert(
            refused.status === null || refused.status >= 400,
            JSON.stringify(refused.status),
          );
          assert(refused.status !== 409);
          if (refused.status !== null) assertEquals(error?.code, "40001");
        }
        assertEquals(await snapshot(guarded.subject), before);
      });

      await t.step("no PostgREST retry loop is left running", async () => {
        const observation = await loopObservation();
        console.log(
          JSON.stringify({ legacyGuardLoop: { mode, ...observation } }),
        );
        // A looping backend rolls back hundreds to thousands of transactions a second.
        if (upgraded) {
          assertEquals(observation.looping, 0);
          assert(observation.rollbacksIn3s < 300, JSON.stringify(observation));
        }
      });
    } finally {
      await fixture.end();
      await ordinary.end();
    }
  },
});
