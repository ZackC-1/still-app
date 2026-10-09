// Real SQL only on a disposable GitHub-hosted Linux rehearsal. Local SKIP is not a PASS.
// Runs the pinned transaction bodies of the qa-sandbox-subjects operation (scripts/backend/deploy/
// operations/qa-sandbox-subjects-{enable,disable}.sql) against the real 0021 wrappers, with the same
// loopback-only connection guard as qa_sandbox_access_test.ts. Synthetic accounts only.
import { assert, assertEquals, assertRejects } from "@std/assert";
import type postgres from "postgres";
import { connection } from "./synthetic_settings_helpers.ts";

type Tx = postgres.TransactionSql;

const target = Deno.env.get("STILL_ACCESS_TEST_DATABASE_URL");
const enabled = !!target && Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted" &&
  Deno.build.os === "linux";
if (Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1" && !enabled) {
  throw new Error("required-cloud-tests-disabled");
}

const A = "d4141414-0000-4000-8000-000000000001";
const B = "d4141414-0000-4000-8000-000000000002";
const FREE = "d4141414-0000-4000-8000-000000000003";
const UNCONFIRMED = "d4141414-0000-4000-8000-000000000004";
const EMAIL: Record<string, string> = {
  [A]: "qa-subjects-a@example.invalid",
  [B]: "qa-subjects-b@example.invalid",
  [FREE]: "qa-subjects-free@example.invalid",
  [UNCONFIRMED]: "qa-subjects-unconfirmed@example.invalid",
};
const PASSWORD = "qa-subjects-synthetic-only";

async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The pinned transaction body (`do $$ ... $$`) of one operation file, byte for byte. */
async function transactionBody(mode: "enable" | "disable") {
  const sql = await Deno.readTextFile(
    new URL(
      `../../scripts/backend/deploy/operations/qa-sandbox-subjects-${mode}.sql`,
      import.meta.url,
    ),
  );
  const match = /\ndo \$\$\n([\s\S]*?)\n\$\$;\n/.exec(sql);
  assert(match, `${mode}: transaction body not found`);
  return `do $$\n${match[1]}\n$$`;
}

Deno.test({
  name:
    "QA subjects operation: refusals write nothing, admission, and disable against in-flight grants",
  ignore: !enabled,
  fn: async (t) => {
    const admin = connection(target!);
    let qa: ReturnType<typeof connection> | undefined;
    const enableBody = await transactionBody("enable");
    const disableBody = await transactionBody("disable");
    const outcome = async (tx: Tx) =>
      JSON.parse(
        String(
          (await tx`select current_setting('still_operation.outcome') as o`)[0]!
            .o,
        ),
      );
    const enable = (holders: string[]) =>
      admin.begin(async (tx) => {
        const hashes = JSON.stringify(
          (await Promise.all(holders.map((h) => sha256(EMAIL[h] ?? h)))).sort(),
        );
        await tx`select set_config('still_operation.subject_hashes', ${hashes}, true)`;
        await tx.unsafe(enableBody);
        return outcome(tx);
      });
    const members = async () =>
      Array.from(
        await admin`select holder::text, enabled, revision::int from private.qa_sandbox_subjects where holder in (${A}::uuid,${B}::uuid,${FREE}::uuid,${UNCONFIRMED}::uuid) order by holder`,
      );
    const code = (error: unknown) => (error as { code?: string }).code;
    try {
      await admin`insert into auth.users(id,email,email_confirmed_at) values
        (${A}::uuid,${EMAIL[A]},now()),(${B}::uuid,${EMAIL[B]},now()),
        (${FREE}::uuid,${EMAIL[FREE]},now()),(${UNCONFIRMED}::uuid,${
        EMAIL[UNCONFIRMED]
      },null)`;
      await admin.unsafe(
        `alter role still_qa_sandbox_writer login password '${PASSWORD}'`,
      );
      qa = connection(target!, "still_qa_sandbox_writer", PASSWORD);
      const q = qa;
      const begin = async (holder: string) =>
        String(
          (await q`select public.qa_sandbox_begin_access_observation(${holder}::uuid) as token`)[
            0
          ]?.token,
        );
      const commit = async (
        holder: string,
        token: string,
        key: string,
        tx: postgres.Sql | Tx = q,
      ) =>
        (await tx`select public.qa_sandbox_commit_access_observation(${holder}::uuid,${token}::uuid,${
          q.json([{ key, product: "still_pro_v3" }])
        }::jsonb) as result`)[0]?.result;
      const rightsFor = async (key: string) =>
        Number(
          (await admin`select count(*)::int as count from private.access_rights where environment='sandbox' and provider_key=${key}`)[
            0
          ]?.count,
        );

      await t.step(
        "enable refuses an unknown, an unconfirmed or a malformed list and writes nothing",
        async () => {
          for (
            const [list, sqlstate] of [
              [[A, "qa-subjects-unknown@example.invalid"], "QS002"],
              [[A, UNCONFIRMED], "QS004"],
            ] as const
          ) {
            await assertRejects(
              () => enable([...list]),
              Error,
            ).then((error) => assertEquals(code(error), sqlstate));
          }
          const malformed = await admin.begin(async (tx) => {
            await tx`select set_config('still_operation.subject_hashes', '["not-a-hash"]', true)`;
            return tx.unsafe(enableBody);
          }).then(() => null, (error) => code(error));
          assertEquals(malformed, "QS001");
          assertEquals(await members(), []);
        },
      );

      await t.step("enable admits exactly the approved accounts", async () => {
        assertEquals(await enable([A, B]), {
          listed: 2,
          admitted: 2,
          changed: 2,
        });
        assertEquals(await enable([A, B]), {
          listed: 2,
          admitted: 2,
          changed: 0,
        });
        assertEquals(
          (await members()).map((m) => [m.holder, m.enabled, m.revision]),
          [[A, true, 1], [B, true, 1]],
        );
        assertEquals(
          (await q`select public.qa_sandbox_account_enabled(${A}::uuid) as on`)[
            0
          ]?.on,
          true,
        );
        assertEquals(
          (await q`select public.qa_sandbox_account_enabled(${FREE}::uuid) as on`)[
            0
          ]?.on,
          false,
        );
      });

      await t.step(
        "disable holds the shared row lock and an in-flight positive grant gets no right",
        async () => {
          const key = "d414".repeat(16);
          const token = await begin(A);
          let ready!: () => void, release!: () => void;
          const locked = new Promise<void>((resolve) => {
            ready = resolve;
          });
          const unlocked = new Promise<void>((resolve) => {
            release = resolve;
          });
          const disabling = admin.begin(async (tx) => {
            await tx.unsafe(disableBody);
            ready();
            await unlocked;
            return outcome(tx);
          });
          await locked;
          const attempted = commit(A, token, key).then(
            (result) => ({ result, error: null }),
            (error) => ({ result: null, error }),
          );
          let blocked = false;
          try {
            for (let i = 0; i < 20 && !blocked; i++) {
              blocked = Number(
                (await admin`select count(*)::int as count from pg_stat_activity where usename='still_qa_sandbox_writer' and wait_event_type='Lock'`)[
                  0
                ]?.count,
              ) > 0;
              if (!blocked) await new Promise((r) => setTimeout(r, 20));
            }
          } finally {
            release();
          }
          assertEquals((await disabling).disabled, 2);
          const result = await attempted;
          assert(
            blocked || code(result.error) === "55P03",
            "no actual lock wait or bounded lock-timeout denial observed",
          );
          if (result.error) assertEquals(code(result.error), "55P03");
          else {
            assertEquals(result.result.rights, []);
            assertEquals(result.result.observed_rights, []);
          }
          assertEquals(await rightsFor(key), 0);
          assertEquals(
            (await members()).map((m) => [m.holder, m.enabled, m.revision]),
            [[A, false, 2], [B, false, 2]],
          );
        },
      );

      await t.step(
        "a positive call already in flight finishes first; disable then waits and nothing positive follows",
        async () => {
          assertEquals((await enable([A])).changed, 1);
          const first = "d415".repeat(16), later = "d416".repeat(16);
          const token = await begin(A);
          let ready!: () => void, release!: () => void;
          const holding = new Promise<void>((resolve) => {
            ready = resolve;
          });
          const unlocked = new Promise<void>((resolve) => {
            release = resolve;
          });
          // The writer's transaction holds A's membership row lock until it commits.
          const granting = q.begin(async (tx) => {
            const result = await commit(A, token, first, tx);
            ready();
            await unlocked;
            return result;
          });
          await holding;
          const disabling = admin.begin(async (tx) => {
            await tx.unsafe(disableBody);
            return outcome(tx);
          });
          let waited = false;
          try {
            for (let i = 0; i < 40 && !waited; i++) {
              waited = Number(
                (await admin`select count(*)::int as count from pg_stat_activity where usename='postgres' and wait_event_type='Lock' and query like '%qa_sandbox_subjects%'`)[
                  0
                ]?.count,
              ) > 0;
              if (!waited) await new Promise((r) => setTimeout(r, 20));
            }
          } finally {
            release();
          }
          assert(
            waited,
            "disable did not wait for the in-flight call's row lock",
          );
          assertEquals((await granting).status, "committed");
          assertEquals((await disabling).disabled, 1);
          assertEquals(await rightsFor(first), 1);
          await commit(A, await begin(A), later);
          assertEquals(await rightsFor(later), 0);
          assertEquals(
            (await q`select public.qa_sandbox_account_enabled(${A}::uuid) as on`)[
              0
            ]?.on,
            false,
          );
        },
      );

      await t.step("disable never deletes a membership", async () => {
        const before = await members();
        const result = await admin.begin(async (tx) => {
          await tx.unsafe(disableBody);
          return outcome(tx);
        });
        assertEquals(result.disabled, 0);
        assert(result.members >= 2);
        assertEquals(await members(), before);
        assertEquals(before.length, 2);
      });
    } finally {
      await qa?.end();
      await admin`alter role still_qa_sandbox_writer nologin password null`;
      await admin.end();
    }
  },
});
