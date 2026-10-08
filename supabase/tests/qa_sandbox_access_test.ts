// Real SQL only on a disposable GitHub-hosted Linux rehearsal. Local SKIP is not a PASS.
// Uses the existing loopback-only connection guard, never the owner's hosted backend.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connection } from "./synthetic_settings_helpers.ts";

const target = Deno.env.get("STILL_ACCESS_TEST_DATABASE_URL");
const enabled = !!target && Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted" &&
  Deno.build.os === "linux";
if (Deno.env.get("STILL_REQUIRE_CLOUD_TESTS") === "1" && !enabled) {
  throw new Error("required-cloud-tests-disabled");
}
const A = "a2121212-0000-4000-8000-000000000001";
const B = "b2121212-0000-4000-8000-000000000002";
const C = "c2121212-0000-4000-8000-000000000003";
const RC = "f212".repeat(16);
const APPLE = "a212".repeat(16);
const CONFIG = "c".repeat(64);
const snapshot = [{ key: RC, product: "still_pro_v3" }];
const revoked = [{ ...snapshot[0]!, state: "revoked" }];
const qaSignatures = [
  "public.qa_sandbox_begin_access_observation(uuid)",
  "public.qa_sandbox_commit_access_observation(uuid,uuid,jsonb)",
  "public.qa_sandbox_confirm_access_observation(uuid,uuid)",
  "public.qa_sandbox_read_access_removals(uuid,uuid)",
  "public.qa_sandbox_transfer_access_right(uuid,uuid,uuid,uuid,bigint)",
  "public.qa_sandbox_begin_apple_access_observation(text,text,text,text)",
  "public.qa_sandbox_commit_apple_local(text,uuid,boolean)",
  "public.qa_sandbox_commit_apple_link(text,uuid,boolean,uuid,uuid,bigint,uuid)",
  "public.qa_sandbox_confirm_apple_local(text,uuid,uuid,bigint,bigint)",
  "public.qa_sandbox_confirm_apple_account(text,uuid,uuid,uuid,bigint,bigint)",
  "public.qa_sandbox_read_linked_apple_transactions(uuid)",
  "public.qa_sandbox_prepare_checkout_operation(uuid,uuid,text)",
  "public.qa_sandbox_bind_checkout_session(uuid,uuid,text,text)",
  "public.qa_sandbox_claim_checkout_creation(uuid,uuid,text)",
  "public.qa_sandbox_read_checkout_operation(uuid,uuid)",
  "public.qa_sandbox_record_checkout_status(uuid,text,text)",
  "public.qa_sandbox_consume_rate_limit(text,integer,integer)",
  "public.qa_sandbox_account_enabled(uuid)",
];

Deno.test({
  name:
    "QA fixed sandbox SQL: live preservation, membership races, anonymous Apple, refund fences and checkout recovery",
  ignore: !enabled,
  fn: async (t) => {
    const admin = connection(target!);
    let qa: ReturnType<typeof connection> | undefined;
    let writer: ReturnType<typeof connection> | undefined;
    const seed = await Deno.readTextFile(
      new URL("./qa_sandbox_access_seed.sql", import.meta.url),
    );
    const gate = await Deno.readTextFile(
      new URL(
        "../../scripts/backend/deploy/verify/qa-sandbox-access.sql",
        import.meta.url,
      ),
    );
    const rollback = await Deno.readTextFile(
      new URL(
        "../../scripts/backend/deploy/rollback/0021_qa_sandbox_access.sql",
        import.meta.url,
      ),
    );
    try {
      if (
        !(await admin`select to_regclass('qa_sandbox_fixture.baseline') as fixture`)[
          0
        ]?.fixture
      ) {
        await admin.unsafe(seed);
      }
      await t.step(
        "upgrade changes no existing rows, prior fixture records actual absent QA path",
        async () => {
          assertEquals(
            Array.from(
              await admin`select name,digest from qa_sandbox_fixture.fingerprints order by name`,
            ),
            Array.from(
              await admin`select name,digest from qa_sandbox_fixture.baseline order by name`,
            ),
          );
          const pre =
            (await admin`select qa_present,absent_invocation_rejected from qa_sandbox_fixture.pre_state`)[
              0
            ]!;
          assert(typeof pre.qa_present === "boolean");
          // false proves an actual pre-apply absence on the upgrade rehearsal. true is clean-install
          // evidence only; the orchestration must run both, never relabel true as a red upgrade probe.
          if (Deno.env.get("STILL_QA_SANDBOX_UPGRADE_REQUIRED") === "1") {
            assertEquals(pre.qa_present, false);
            assertEquals(pre.absent_invocation_rejected, !pre.qa_present);
          }
          assertEquals((await admin.unsafe(gate))[0]?.coalesce, []);
        },
      );
      await admin`alter role still_qa_sandbox_writer login password 'qa-sandbox-synthetic-only'`;
      await admin`alter role still_entitlement_writer login password 'qa-production-synthetic-only'`;
      qa = connection(
        target!,
        "still_qa_sandbox_writer",
        "qa-sandbox-synthetic-only",
      );
      writer = connection(
        target!,
        "still_entitlement_writer",
        "qa-production-synthetic-only",
      );
      const q = qa, live = writer;
      await t.step(
        "real login denied live/general/core/table/membership privileges",
        async () => {
          await assertRejects(async () =>
            q`select public.begin_access_observation(${A}::uuid,'production')`
          );
          await assertRejects(async () =>
            q`select public.commit_access_observation(${A}::uuid,'production',${crypto.randomUUID()}::uuid,'[]'::jsonb)`
          );
          await assertRejects(async () =>
            q`select private.begin_access_observation_core(${A}::uuid,'production')`
          );
          await assertRejects(async () =>
            q`select public.consume_rate_limit('checkout:ip:198.51.100.21',5,60)`
          );
          await assertRejects(async () =>
            q`select public.set_entitlement(${A}::uuid,false,'reconcile',null)`
          );
          await assertRejects(async () =>
            q`select * from private.access_rights`
          );
          await assertRejects(async () =>
            q`update private.qa_sandbox_subjects set enabled=true`
          );
          await assertRejects(async () => q`set role still_qa_sandbox_owner`);
          await assertRejects(async () => q`set role still_entitlement_writer`);
          for (
            const role of [
              "anon",
              "authenticated",
              "service_role",
              "still_entitlement_writer",
            ]
          ) {
            for (const signature of qaSignatures) {
              assertEquals(
                (await admin`select has_function_privilege(${role},${signature},'EXECUTE') as allowed`)[
                  0
                ]?.allowed,
                false,
              );
            }
          }
        },
      );
      await admin`insert into private.qa_sandbox_subjects(holder,enabled) values(${A}::uuid,true),(${B}::uuid,true)`;
      const begin = async (holder = A) =>
        String(
          (await q`select public.qa_sandbox_begin_access_observation(${holder}::uuid) as token`)[
            0
          ]?.token,
        );
      const commit = async (
        holder: string,
        token: string,
        value: unknown = snapshot,
      ) =>
        (await q`select public.qa_sandbox_commit_access_observation(${holder}::uuid,${token}::uuid,${
          JSON.stringify(value)
        }::jsonb) as result`)[0]?.result;
      const appleBegin = async () =>
        String(
          (await q`select public.qa_sandbox_begin_apple_access_observation(${APPLE},'com.example.still','still_pro_v3','212121212121') as token`)[
            0
          ]?.token,
        );
      let rcRight = "", appleRight = "";
      let productionBefore: unknown[] = [];
      await t.step(
        "fixed sandbox wrapper works while same-key production row remains unchanged",
        async () => {
          await assertRejects(async () => begin(C));
          const token = await begin();
          const first = await commit(A, token);
          assertEquals(first.status, "committed");
          assertEquals(first.rights.length, 1);
          rcRight = first.rights[0].right;
          assertEquals(await commit(A, token), first);
          await assertRejects(async () => commit(A, token, []));
          const before = Array.from(
            await admin`select to_jsonb(r) as row from private.access_rights r where environment='sandbox' and right_id=${rcRight}::uuid`,
          );
          const liveToken =
            (await live`select public.begin_access_observation(${A}::uuid,'production') as token`)[
              0
            ]!.token;
          const result =
            (await live`select public.commit_access_observation(${A}::uuid,'production',${liveToken}::uuid,${
              JSON.stringify(snapshot)
            }::jsonb) as result`)[0]!.result;
          assertEquals(result.status, "committed");
          assert(
            result.rights.some((r: { right: string }) => r.right !== rcRight),
          );
          assertEquals(
            Array.from(
              await admin`select to_jsonb(r) as row from private.access_rights r where environment='sandbox' and right_id=${rcRight}::uuid`,
            ),
            before,
          );
          assertEquals(
            (await admin`select count(*)::int as count from private.access_rights where provider_key=${RC}`)[
              0
            ]?.count,
            2,
          );
        },
      );
      productionBefore = Array.from(
        await admin`select to_jsonb(r) as row from private.access_rights r where environment='production' order by right_id`,
      );
      await t.step(
        "canonical RC refund from disabled former provider holder revokes the transferred current holder",
        async () => {
          const key = "f213".repeat(16),
            purchase = [{ key, product: "still_pro_v3" }];
          const first = await commit(A, await begin(), purchase);
          const right = first.observed_rights[0].right;
          const op = crypto.randomUUID();
          const move = async () =>
            (await q`select public.qa_sandbox_transfer_access_right(${op}::uuid,${right}::uuid,${A}::uuid,${B}::uuid,0) as result`)[
              0
            ]!.result;
          const [one, two] = await Promise.all([move(), move()]);
          assertEquals(one, { status: "transferred", revision: 1 });
          assertEquals(two, one);
          await assertRejects(async () =>
            q`select public.qa_sandbox_transfer_access_right(${crypto.randomUUID()}::uuid,${right}::uuid,${B}::uuid,${C}::uuid,1)`
          );
          await admin`update private.qa_sandbox_subjects set enabled=false,revision=revision+1 where holder=${A}::uuid`;
          const refund = await commit(A, await begin(), [{
            ...purchase[0],
            state: "revoked",
          }]);
          assertEquals(refund.rights, []);
          assertEquals(refund.observed_rights, []);
          const current =
            (await admin`select active,holder,ownership_revision::int as revision from private.access_rights where right_id=${right}::uuid`)[
              0
            ]!;
          assertEquals(current.active, false);
          assertEquals(current.holder, B);
          assertEquals(current.revision, 2);
          assertEquals(
            (await admin`select revision::int as revision from private.access_revocations where holder=${B}::uuid and right_id=${right}::uuid`)[
              0
            ]?.revision,
            2,
          );
          const late = await commit(B, await begin(B), purchase);
          assertEquals(late.observed_rights, []);
          assertEquals(
            (await admin`select active from private.access_rights where right_id=${right}::uuid`)[
              0
            ]?.active,
            false,
          );
          await admin`update private.qa_sandbox_subjects set enabled=true,revision=revision+1 where holder=${A}::uuid`;
        },
      );
      await t.step(
        "membership disable waits on common row lock and denies in-flight positive commit atomically",
        async () => {
          const token = await begin();
          let ready!: () => void, release!: () => void;
          const locked = new Promise<void>((resolve) => {
            ready = resolve;
          });
          const unlocked = new Promise<void>((resolve) => {
            release = resolve;
          });
          const disabling = admin.begin(async (tx) => {
            await tx`update private.qa_sandbox_subjects set enabled=false,revision=revision+1 where holder=${A}::uuid`;
            ready();
            await unlocked;
          });
          await locked;
          const attempted = commit(A, token).then(
            (result) => ({ result, error: null }),
            (error) => ({ result: null, error }),
          );
          try {
            let blocked = false;
            for (let i = 0; i < 100; i++) {
              blocked = Number(
                (await admin`select count(*)::int as count from pg_stat_activity where usename='still_qa_sandbox_writer' and wait_event_type='Lock'`)[
                  0
                ]?.count,
              ) > 0;
              if (blocked) break;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert(
              blocked,
              "actual positive commit did not wait on the operator membership transaction",
            );
          } finally {
            release();
            await disabling;
          }
          assert((await attempted).error instanceof Error);
          assertEquals(
            (await admin`select enabled from private.qa_sandbox_subjects where holder=${A}::uuid`)[
              0
            ]?.enabled,
            false,
          );
          assertEquals(
            (await admin`select ownership_revision::int as revision from private.access_rights where right_id=${rcRight}::uuid`)[
              0
            ]?.revision,
            0,
          );
        },
      );
      await t.step(
        "disabled subject exact refund persists removal and cannot resurrect; unknown negative cannot create",
        async () => {
          const token = await begin();
          const negative = await commit(A, token, revoked);
          assertEquals(negative.rights, []);
          assertEquals(negative.observed_rights, []);
          assert(
            negative.revocations.some((
              removal: { right: string; revision: number },
            ) => removal.right === rcRight && removal.revision === 1),
          );
          const removals =
            (await q`select public.qa_sandbox_read_access_removals(${A}::uuid,${token}::uuid) as result`)[
              0
            ]!.result;
          assertEquals(removals.holder, A);
          assertEquals(removals.environment, "sandbox");
          await assertRejects(async () =>
            commit(A, await begin(), [{
              key: "8".repeat(64),
              product: "still_pro_v3",
              state: "revoked",
            }])
          );
          await admin`update private.qa_sandbox_subjects set enabled=true,revision=revision+1 where holder=${A}::uuid`;
          const late = await commit(A, await begin());
          assertEquals(late.rights, []);
          assertEquals(late.observed_rights, []);
          assertEquals(
            (await admin`select active from private.access_rights where right_id=${rcRight}::uuid`)[
              0
            ]?.active,
            false,
          );
          assertEquals(
            (await admin`select count(*)::int as count from private.access_rights where provider_key=${
              "8".repeat(64)
            }`)[0]?.count,
            0,
          );
        },
      );
      await t.step(
        "local Apple has no sign-in/member requirement or holder/link arguments",
        async () => {
          await admin`update private.qa_sandbox_subjects set enabled=false,revision=revision+1`;
          const token = await appleBegin();
          const local =
            (await q`select public.qa_sandbox_commit_apple_local(${APPLE},${token}::uuid,true) as result`)[
              0
            ]!.result;
          assertEquals(local.status, "verified");
          appleRight = local.right.right;
          assertEquals(local.right.holder, appleRight);
          assertEquals(
            (await q`select public.qa_sandbox_confirm_apple_local(${APPLE},${token}::uuid,${appleRight}::uuid,${local.right.revision},${local.right.verified_at}) as confirmed`)[
              0
            ]?.confirmed,
            true,
          );
          assertEquals(
            (await admin`select holder from private.access_rights where right_id=${appleRight}::uuid`)[
              0
            ]?.holder,
            null,
          );
          await assertRejects(async () =>
            q`select public.qa_sandbox_commit_apple_local(${APPLE},${token}::uuid,true,${A}::uuid)`
          );
          await assertRejects(async () =>
            q`select public.qa_sandbox_commit_apple_link(${APPLE},${token}::uuid,true,${A}::uuid,${crypto.randomUUID()}::uuid,0,null)`
          );
        },
      );
      await t.step(
        "explicit link/transfer requires both enabled authorities; ordinary account check cannot link",
        async () => {
          await admin`update private.qa_sandbox_subjects set enabled=true,revision=revision+1 where holder=${A}::uuid`;
          await q`select public.qa_sandbox_account_enabled(${A}::uuid)`;
          assertEquals(
            (await admin`select holder from private.access_rights where right_id=${appleRight}::uuid`)[
              0
            ]?.holder,
            null,
          );
          const linked =
            (await q`select public.qa_sandbox_commit_apple_link(${APPLE},${await appleBegin()}::uuid,true,${A}::uuid,${crypto.randomUUID()}::uuid,0,null) as result`)[
              0
            ]!.result;
          assertEquals(linked.status, "linked");
          assertEquals(linked.right.revision, 1);
          const transferOp = crypto.randomUUID();
          await assertRejects(async () =>
            q`select public.qa_sandbox_commit_apple_link(${APPLE},${await appleBegin()}::uuid,true,${B}::uuid,${transferOp}::uuid,1,${A}::uuid)`
          );
          await admin`update private.qa_sandbox_subjects set enabled=true,revision=revision+1 where holder=${B}::uuid`;
          const moved =
            (await q`select public.qa_sandbox_commit_apple_link(${APPLE},${await appleBegin()}::uuid,true,${B}::uuid,${transferOp}::uuid,1,${A}::uuid) as result`)[
              0
            ]!.result;
          assertEquals(moved.status, "linked");
          assertEquals(moved.right.revision, 2);
          const repeated =
            (await q`select public.qa_sandbox_commit_apple_link(${APPLE},${await appleBegin()}::uuid,true,${B}::uuid,${transferOp}::uuid,1,${A}::uuid) as result`)[
              0
            ]!.result;
          assertEquals(repeated.right.revision, 2);
          await admin`update private.qa_sandbox_subjects set enabled=false,revision=revision+1`;
          const refund =
            (await q`select public.qa_sandbox_commit_apple_link(${APPLE},${await appleBegin()}::uuid,false,${C}::uuid,${crypto.randomUUID()}::uuid,99,null) as result`)[
              0
            ]!.result;
          assertEquals(refund, { status: "revoked" });
          const late =
            (await q`select public.qa_sandbox_commit_apple_local(${APPLE},${await appleBegin()}::uuid,true) as result`)[
              0
            ]!.result;
          assertEquals(late, { status: "revoked" });
        },
      );
      await t.step(
        "checkout operation/Session immutable, ambiguous paid recovery cannot release another charge",
        async () => {
          await admin`update private.qa_sandbox_subjects set enabled=true,revision=revision+1 where holder=${A}::uuid`;
          const operation = crypto.randomUUID(),
            session = "cs_test_synthetic_bound_2121";
          const prepare = async (op = operation, holder = A, config = CONFIG) =>
            (await q`select public.qa_sandbox_prepare_checkout_operation(${op}::uuid,${holder}::uuid,${config}) as result`)[
              0
            ]!.result;
          const first = await prepare();
          assertEquals(
            (await prepare(crypto.randomUUID())).operation_id,
            first.operation_id,
          );
          await assertRejects(async () => prepare(operation, B));
          await assertRejects(async () =>
            prepare(operation, A, "d".repeat(64))
          );
          const claim = async () =>
            (await q`select public.qa_sandbox_claim_checkout_creation(${operation}::uuid,${A}::uuid,${CONFIG}) as result`)[
              0
            ]!.result;
          const claims = await Promise.all([claim(), claim()]);
          assertEquals(claims.filter((value) => value.claimed).length, 1);
          assert(
            claims.every((value) =>
              value.operation.creation_started_at !== null
            ),
          );
          await assertRejects(async () =>
            q`select public.qa_sandbox_bind_checkout_session(${operation}::uuid,${A}::uuid,${session},${
              "d".repeat(64)
            })`
          );
          await q`select public.qa_sandbox_record_checkout_status(${operation}::uuid,null,'recovery_required')`;
          await assertRejects(async () =>
            q`select public.qa_sandbox_record_checkout_status(${operation}::uuid,null,'closed_unpaid')`
          );
          assertEquals((await claim()).claimed, false);
          await q`select public.qa_sandbox_bind_checkout_session(${operation}::uuid,${A}::uuid,${session},${CONFIG})`;
          await assertRejects(async () =>
            q`select public.qa_sandbox_bind_checkout_session(${operation}::uuid,${A}::uuid,'cs_test_different',${CONFIG})`
          );
          const status = async (value: string) =>
            (await q`select public.qa_sandbox_record_checkout_status(${operation}::uuid,${session},${value}) as result`)[
              0
            ]!.result;
          await status("paid_verified");
          await status("import_pending");
          const before = Array.from(
            await admin`select to_jsonb(r) as row from private.access_rights r where holder=${A}::uuid order by right_id`,
          );
          await status("recovery_required");
          await assertRejects(async () => status("closed_unpaid"));
          assertEquals(
            (await prepare(crypto.randomUUID())).operation_id,
            operation,
          );
          await status("imported");
          await status("access_observed");
          await admin`update private.qa_sandbox_subjects set enabled=false,revision=revision+1 where holder=${A}::uuid`;
          assertEquals((await status("refunded")).status, "refunded");
          assertEquals((await status("refunded")).status, "refunded");
          await assertRejects(async () => status("imported"));
          await assertRejects(async () => prepare(crypto.randomUUID()));
          assertEquals(
            (await q`select public.qa_sandbox_read_checkout_operation(${operation}::uuid,${A}::uuid) as result`)[
              0
            ]!.result.status,
            "refunded",
          );
          assertEquals(
            Array.from(
              await admin`select to_jsonb(r) as row from private.access_rights r where holder=${A}::uuid order by right_id`,
            ),
            before,
          );
          assertEquals(
            (await admin`select still_sync from public.entitlements where user_id=${A}::uuid`)[
              0
            ]?.still_sync,
            true,
          );
        },
      );
      await t.step(
        "QA limiter uses exact separate quotas and never stores clear IP/subject",
        async () => {
          const bucket = "qa-sandbox-checkout:ip:198.51.100.212";
          assertEquals(
            (await q`select public.qa_sandbox_consume_rate_limit(${bucket},20,60) as retry`)[
              0
            ]?.retry,
            0,
          );
          for (let i = 0; i < 20; i++) {
            await q`select public.qa_sandbox_consume_rate_limit(${bucket},20,60)`;
          }
          assert(
            Number(
              (await q`select public.qa_sandbox_consume_rate_limit(${bucket},20,60) as retry`)[
                0
              ]?.retry,
            ) > 0,
          );
          await assertRejects(async () =>
            q`select public.qa_sandbox_consume_rate_limit('checkout:ip:198.51.100.212',20,60)`
          );
          await assertRejects(async () =>
            q`select public.qa_sandbox_consume_rate_limit(${bucket},100,60)`
          );
          await assertRejects(async () =>
            q`select public.qa_sandbox_consume_rate_limit(${bucket},20,600)`
          );
          const counters =
            await admin`select bucket_key from private.qa_sandbox_rate_counters`;
          assert(counters.length > 0);
          for (const row of counters) {
            assert(!String(row.bucket_key).includes("198.51.100.212"));
            assert(/:[a-f0-9]{64}$/.test(row.bucket_key));
          }
        },
      );
      assertEquals(
        Array.from(
          await admin`select to_jsonb(r) as row from private.access_rights r where environment='production' order by right_id`,
        ),
        productionBefore,
      );
      await t.step(
        "forward rollback restores prior production guard/body/ACL in a rolled-back rehearsal transaction",
        async () => {
          const before = Array.from(
            await admin`select p.oid::regprocedure::text as signature,p.prosrc,p.proacl,p.proowner,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('begin_access_observation','commit_access_observation','confirm_access_observation','transfer_access_right','begin_apple_access_observation','commit_apple_access_observation','confirm_apple_access_observation','read_linked_apple_transactions','read_access_removals') order by signature`,
          );
          const body = rollback.replace(/^([\s\S]*?)\bbegin;\n/, "").replace(
            /commit;\s*$/,
            "",
          );
          await assertRejects(
            async () =>
              admin.begin(async (tx) => {
                await tx.unsafe(body);
                for (
                  const row
                    of await tx`select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('begin_access_observation','commit_access_observation','confirm_access_observation','transfer_access_right','begin_apple_access_observation','commit_apple_access_observation','confirm_apple_access_observation','read_linked_apple_transactions','read_access_removals')`
                ) {
                  assert(
                    String(row.prosrc).includes(
                      "session_user <> 'still_entitlement_writer'",
                    ),
                  );
                  assert(!String(row.prosrc).includes("_core("));
                }
                const upgrade =
                  (await tx`select qa_present,absent_invocation_rejected from qa_sandbox_fixture.pre_state`)[
                    0
                  ]!.qa_present === false;
                if (upgrade) {
                  assertEquals(
                    Array.from(
                      await tx`select p.oid::regprocedure::text as signature,p.prosrc,p.proacl,p.proowner,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace join qa_sandbox_fixture.live_routines f on p.oid::regprocedure::text=f.signature order by signature`,
                    ),
                    Array.from(
                      await tx`select * from qa_sandbox_fixture.live_routines order by signature`,
                    ),
                  );
                }
                assertEquals(
                  (await tx`select rolcanlogin from pg_roles where rolname='still_qa_sandbox_writer'`)[
                    0
                  ]?.rolcanlogin,
                  false,
                );
                for (const signature of qaSignatures) {
                  assertEquals(
                    (await tx`select has_function_privilege('still_qa_sandbox_writer',${signature},'EXECUTE') as allowed`)[
                      0
                    ]?.allowed,
                    false,
                  );
                }
                throw new Error("rollback-rehearsal-only");
              }),
            Error,
            "rollback-rehearsal-only",
          );
          assertEquals(
            Array.from(
              await admin`select p.oid::regprocedure::text as signature,p.prosrc,p.proacl,p.proowner,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('begin_access_observation','commit_access_observation','confirm_access_observation','transfer_access_right','begin_apple_access_observation','commit_apple_access_observation','confirm_apple_access_observation','read_linked_apple_transactions','read_access_removals') order by signature`,
            ),
            before,
          );
          assertEquals((await admin.unsafe(gate))[0]?.coalesce, []);
        },
      );
    } finally {
      await qa?.end();
      await writer?.end();
      await admin`alter role still_qa_sandbox_writer nologin password null`;
      await admin`alter role still_entitlement_writer nologin password null`;
      await admin.end();
      // Disposable rehearsal owns fixture teardown/reset; no hosted cleanup or ledger deletion.
    }
  },
});
