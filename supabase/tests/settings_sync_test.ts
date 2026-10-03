import { assert, assertEquals, assertRejects } from "@std/assert";
import { PgSettingsStore } from "../functions/_shared/pg-settings-store.ts";
import { PgRateLimiter } from "../functions/_shared/pg-store.ts";
import { handleSyncSettings } from "../functions/sync-settings/handler.ts";
import { syncSettings } from "../functions/_shared/settings-store.ts";
import {
  inspectCatalogPreconditions,
  verifySyntheticHardeningAuthority,
} from "./catalog_preconditions.ts";
import {
  A,
  B,
  C,
  connection,
  source,
  SYNTHETIC_PASSWORD,
  token,
  write,
} from "./synthetic_settings_helpers.ts";
import { readSettingsOperationRequest } from "../../packages/shared-types/src/settings-operation.ts";
import { migrateSettingsV2 } from "../../packages/core/src/storage/settings-v2.ts";
import { SETTINGS_FIELDS } from "@still/shared-types";
import {
  verifySettingsDriverJSON,
  verifySettingsLegacyOwnerGrants,
  verifySettingsLimiterBuckets,
} from "./settings_sync_sql_cases.ts";
const cloud = Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted";
const url = Deno.env.get("STILL_SETTINGS_TEST_DATABASE_URL");
const SECRET = "synthetic-settings-handler-jwt-secret-32-chars";
function parsed(request: unknown) {
  const decoded = readSettingsOperationRequest(request);
  assertEquals(decoded.status, "parsed");
  if (decoded.status !== "parsed") throw new Error("request");
  return decoded.request;
}
Deno.test({
  name:
    "U3 SQL lifecycle: maintained managed-owner denial, narrow authenticated atomic settings",
  ignore: !cloud || !url,
  async fn(t) {
    const ordinary = connection(url!);
    const fixture = connection(
      url!,
      "u1_catalog_fixture",
      "u1-synthetic-fixture-only",
    );
    let writerStatements = 0;
    const writer = connection(
      url!,
      "still_settings_writer",
      SYNTHETIC_PASSWORD,
      () => writerStatements++,
    );
    let historicalRights: unknown;
    try {
      await t.step(
        "real non-superuser authority failure rolls back; explicit synthetic admin applies",
        async () => {
          await inspectCatalogPreconditions(ordinary);
          await verifySyntheticHardeningAuthority(ordinary, fixture, source);
          await fixture.begin(async (tx) => {
            await tx.unsafe(await source("hardening-candidate"));
            await tx.unsafe(await source("assert-security"));
            await tx.unsafe(await source("settings-sync-candidate"));
            await tx.unsafe(await source("assert-security"));
          });
          await fixture.unsafe(
            `alter role still_settings_writer login password '${SYNTHETIC_PASSWORD}'`,
          );
          await fixture`insert into auth.users(id,email) values (${A},'u3-a@example.invalid'),(${B},'u3-b@example.invalid'),(${C},'u3-c@example.invalid')`;
          await fixture`select public.set_entitlement(${B}::uuid,true,'webhook',null)`;
        },
      );
      historicalRights =
        await fixture`select pg_catalog.row_to_json(e)::text as raw from public.entitlements e where user_id=${B}`;
      const store = new PgSettingsStore(writer);
      const read = async (subject = A) => {
        const result = await syncSettings(store, subject, null);
        assertEquals(result.status, "ready");
        if (result.status !== "ready") throw new Error("read");
        return result;
      };
      await t.step(
        "narrow writer has no table/entitlement/client authority and helpers have no public grant",
        async () => {
          for (
            const sql of [
              "select * from private.settings_anchors",
              "select * from public.profiles",
              "select * from public.entitlements",
              "select public.set_entitlement('11111111-1111-4111-8111-111111111111',true,'test',null)",
            ]
          ) {
            await assertRejects(() => writer.unsafe(sql));
          }
          for (const role of ["anon", "authenticated", "service_role"]) {
            for (
              const signature of [
                "private.lock_settings(uuid,uuid,text)",
                "private.claim_settings_write(uuid,uuid,jsonb)",
                "private.commit_settings(uuid,uuid,bigint,jsonb,jsonb,uuid,bigint,jsonb)",
                "private.cleanup_settings_writes()",
              ]
            ) {
              assertEquals(
                (await fixture`select has_function_privilege(${role},${signature},'execute') as allowed`)[
                  0
                ].allowed,
                false,
              );
            }
          }
          assertEquals(
            (await fixture`select has_function_privilege('still_settings_writer','private.cleanup_settings_writes()','execute') as allowed`)[
              0
            ].allowed,
            false,
          );
          assertEquals(
            (await fixture`select private.settings_fields() as fields`)[0]
              .fields,
            [...SETTINGS_FIELDS],
          );
          const paths =
            await fixture`select proname,proconfig from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and proname in ('lock_settings','claim_settings_write','commit_settings','cleanup_settings_writes')`;
          assertEquals(paths.length, 4);
          for (const path of paths) {
            assert(path.proconfig.includes('search_path=""'));
          }
          await fixture.begin(async (tx) => {
            for (const schema of ["private", "public"]) {
              await tx.unsafe(
                `create function ${schema}.u3_default_execute_probe() returns boolean language sql as 'select true'`,
              );
              for (
                const role of [
                  "anon",
                  "authenticated",
                  "service_role",
                  "still_settings_writer",
                ]
              ) {
                assertEquals(
                  (await tx`select has_function_privilege(${role},${
                    schema + ".u3_default_execute_probe()"
                  },'execute') as allowed`)[0].allowed,
                  false,
                );
              }
              await tx.unsafe(
                `drop function ${schema}.u3_default_execute_probe()`,
              );
            }
          });
          const logging =
            await writer`select name,setting from pg_catalog.pg_settings where name in ('log_parameter_max_length','log_parameter_max_length_on_error') order by name`;
          assertEquals(logging.map((r) => [r.name, r.setting]), [[
            "log_parameter_max_length",
            "0",
          ], ["log_parameter_max_length_on_error", "0"]]);
          const audit =
            (await writer`select pg_catalog.current_setting('pgaudit.log_parameter',true) as parameters`)[
              0
            ].parameters;
          assert(
            audit === null || audit === "off",
            "separate audit parameter logging must be disabled in the pinned fixture",
          );
          assertEquals(
            (await fixture`select count(*)::int as n from pg_catalog.pg_auth_members where roleid=(select oid from pg_catalog.pg_roles where rolname='still_settings_writer') or member=(select oid from pg_catalog.pg_roles where rolname='still_settings_writer')`)[
              0
            ].n,
            0,
          );
        },
      );
      await t.step(
        "legacy trusted owner helper grants reject client access and owner drift",
        () =>
          source("settings-sync-candidate").then((candidate) =>
            verifySettingsLegacyOwnerGrants(fixture, candidate)
          ),
      );
      await t.step(
        "retained limiter accepts settings-sync user/IP bounds and rejects unrelated surfaces",
        () => verifySettingsLimiterBuckets(fixture, writer),
      );
      await t.step(
        "actual driver preserves JSON null/object/arrays and raw decimal CAS bytes",
        () => verifySettingsDriverJSON(fixture, writer),
      );
      await t.step(
        "concurrent first reads converge immutable key/lineage; account receipt isolation",
        async () => {
          const [left, right] = await Promise.all([read(), read()]);
          assertEquals(left.lineage, right.lineage);
          assertEquals(left.receipt, right.receipt);
          const other = await read(B);
          const request = write(left, [["globalOn", false]], 0);
          assertEquals(
            (await syncSettings(store, B, parsed(request))).status,
            "rejected",
          );
          assert(other.lineage !== left.lineage);
          const deps = {
            jwtSecret: SECRET,
            store,
            limiter: new PgRateLimiter(writer),
          };
          const response = await handleSyncSettings(
            new Request("https://example.test", {
              method: "POST",
              headers: { authorization: `Bearer ${await token(A, SECRET)}` },
              body: JSON.stringify({ protocol: 2, action: "read" }),
            }),
            deps,
          );
          assertEquals(response.status, 200);
          assertEquals((await response.json()).lineage, left.lineage);
        },
      );
      await t.step(
        "multi-field atomic merge, independent offline peers, exact Off tie and immutable retries",
        async () => {
          const initial = await read();
          const request = write(initial, [["globalOn", false], [
            "sites.youtube.related",
            true,
          ]], 0);
          const first = await syncSettings(store, A, parsed(request));
          assertEquals(first.status, "ready");
          if (first.status !== "ready") throw new Error("write");
          assertEquals(first.settingsVersion, 1);
          const duplicate = await syncSettings(store, A, parsed(request));
          assertEquals(duplicate, first);
          assertEquals(
            (await syncSettings(
              store,
              A,
              parsed({
                ...request,
                operations: [{ ...request.operations[0], value: true }],
              }),
            )).status,
            "rejected",
          );
          const peers = await Promise.all([
            syncSettings(
              store,
              A,
              parsed(write(initial, [["sites.instagram.stories", true]], 0)),
            ),
            syncSettings(
              store,
              A,
              parsed(write(initial, [["sites.facebook.stories", true]], 0)),
            ),
          ]);
          assertEquals(peers.map((peer) => peer.status), ["ready", "ready"]);
          const tie = await syncSettings(
            store,
            A,
            parsed(write(initial, [["sites.youtube.related", false]], 0)),
          );
          assertEquals(tie.status, "ready");
          const canonical = await read();
          assertEquals(canonical.settings.sites["youtube.related"], false);
          assertEquals(canonical.settings.sites["instagram.stories"], true);
          assertEquals(canonical.settings.sites["facebook.stories"], true);
          assertEquals(canonical.settings.clocks["sites.youtube.related"], {
            baseRevision: 0,
            localStep: 1,
          });
          const old = await syncSettings(store, A, parsed(request));
          assertEquals(old, canonical);
          await fixture`update private.settings_writes set created_at=pg_catalog.clock_timestamp()-interval '31 days' where user_id=${A} and write_id=${request.writeId}::uuid`;
          assertEquals(
            await syncSettings(store, A, parsed(request)),
            canonical,
          );
          const before = canonical.settingsVersion;
          await syncSettings(
            store,
            A,
            parsed(write(initial, [["sites.youtube.related", true]], 0)),
          );
          assertEquals((await read()).settingsVersion, before);
        },
      );
      const legacy = {
        globalOn: false,
        services: {
          youtube: false,
          instagram: true,
          facebook: false,
          tiktok: true,
        },
        pauses: [],
        updatedAt: Date.now() - 10000,
      };
      const legacyWrite = async (
        subject: string,
        body: unknown,
        id = crypto.randomUUID(),
      ) => {
        return await fixture.begin(async (tx) => {
          await tx`set local role authenticated`;
          await tx`select pg_catalog.set_config('request.jwt.claim.sub',${subject},true)`;
          return await tx`select * from public.write_profile_settings(${
            JSON.stringify(body)
          }::text::jsonb,${id}::uuid)`;
        });
      };
      const snapshot = async (subject: string) => ({
        row:
          await fixture`select pg_catalog.row_to_json(p)::text as raw from public.profiles p where id=${subject}`,
        identities:
          await fixture`select write_id,body::text,created_at from private.settings_writes where user_id=${subject} order by write_id`,
      });
      const databaseTime = async () =>
        Number(
          (await fixture`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint as ms`)[
            0
          ].ms,
        );
      const rejectedLegacy = async (
        subject: string,
        body: unknown,
        message: string,
        code: string,
      ) => {
        const before = await snapshot(subject);
        const failure = await assertRejects(() => legacyWrite(subject, body));
        assertEquals((failure as Error & { code: string }).code, code);
        assertEquals((failure as Error).message, message);
        assertEquals(await snapshot(subject), before);
      };
      await t.step(
        "strict free legacy before/deny after modern; absent extras and future fields preserved",
        async () => {
          const id = crypto.randomUUID();
          await legacyWrite(B, legacy, id);
          await legacyWrite(B, legacy, id);
          for (
            const updatedAt of [-1, Date.now() + 60000, legacy.updatedAt, 1.2]
          ) await assertRejects(() => legacyWrite(B, { ...legacy, updatedAt }));
          const existing = await read(B);
          assertEquals(existing.settings.clocks.globalOn.baseRevision, 1);
          assertEquals(
            existing.settings.clocks["sites.youtube.related"].baseRevision,
            0,
          );
          const supplied = [
            "globalOn",
            "services.youtube",
            "services.instagram",
            "services.facebook",
            "services.tiktok",
          ];
          const expanded = JSON.parse(JSON.stringify(existing.settings));
          expanded.future = { keep: true };
          for (const field of [...supplied, "sites.youtube.related"]) {
            expanded.clocks[field].futureStamp = { keep: true, label: "é/é" };
          }
          await fixture`update public.profiles set settings=${
            JSON.stringify(expanded)
          }::text::jsonb,settings_server_updated_at=pg_catalog.clock_timestamp()-interval '1 second' where id=${B}`;
          const beforeLegacy = await read(B);
          const serverNow =
            (await fixture`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint as ms`)[
              0
            ].ms;
          await legacyWrite(B, {
            ...legacy,
            globalOn: true,
            updatedAt: Number(serverNow),
          });
          const preserved = await read(B);
          assertEquals(
            preserved.settingsVersion,
            beforeLegacy.settingsVersion + 1,
          );
          for (const field of supplied) {
            assertEquals(preserved.settings.clocks[field], {
              ...expanded.clocks[field],
              baseRevision: preserved.settingsVersion,
              localStep: 0,
            });
          }
          assertEquals(
            preserved.settings.clocks["sites.youtube.related"],
            expanded.clocks["sites.youtube.related"],
          );
          assertEquals(preserved.settings.future, { keep: true });
          await syncSettings(
            store,
            B,
            parsed(
              write(
                preserved,
                [["sites.youtube.related", true]],
                preserved.settingsVersion,
              ),
            ),
          );
          const current = await read(B);
          await fixture`select pg_catalog.pg_sleep(0.005)`;
          const admissibleTime = await databaseTime();
          assert(admissibleTime > current.settings.updatedAt);
          await rejectedLegacy(
            B,
            { ...legacy, updatedAt: admissibleTime },
            "settings client upgrade required",
            "40001",
          );
          const protectedState = await snapshot(B);
          let mutantAccepted = false;
          const rollback = await assertRejects(() =>
            fixture.begin(async (tx) => {
              const definition =
                (await tx`select pg_catalog.pg_get_functiondef('public.write_profile_settings(jsonb,uuid)'::regprocedure) as source`)[
                  0
                ].source as string;
              const mutant = definition.replace(
                /if exists\(select 1 from private\.settings_anchors[\s\S]*?raise exception 'settings client upgrade required' using errcode='40001'; end if;/,
                "if false then raise exception 'settings client upgrade required' using errcode='40001'; end if;",
              );
              assert(mutant !== definition);
              await tx.unsafe(mutant);
              await tx`set local role authenticated`;
              await tx`select pg_catalog.set_config('request.jwt.claim.sub',${B},true)`;
              const rows =
                await tx`select * from public.write_profile_settings(${
                  JSON.stringify({ ...legacy, updatedAt: admissibleTime })
                }::text::jsonb,${crypto.randomUUID()}::uuid)`;
              assertEquals(rows.length, 1);
              assertEquals(rows[0].settings.globalOn, false);
              mutantAccepted = true;
              throw new Error("synthetic upgrade mutant rollback");
            })
          );
          assert(
            mutantAccepted,
            "disabled modern guard must admit the proved timestamp",
          );
          assertEquals(
            (rollback as Error).message,
            "synthetic upgrade mutant rollback",
          );
          assertEquals(await snapshot(B), protectedState);
          assertEquals((await read(B)).settings.future, { keep: true });
          await legacyWrite(B, legacy, id); // exact old identity only returns current canonical
        },
      );
      await t.step(
        "legacy raw grammar, complete canonical holds and safe maximum roll back every identity",
        async () => {
          const now = await databaseTime();
          const acceptedId = crypto.randomUUID();
          const acceptedBody = { ...legacy, updatedAt: now };
          await legacyWrite(C, acceptedBody, acceptedId);
          for (
            const [body, message] of [
              [
                { ...legacy, updatedAt: now, unknown: true },
                "unrecognized legacy settings",
              ],
              [
                { ...legacy, updatedAt: now, schemaVersion: 2 },
                "unrecognized legacy settings",
              ],
              [
                { ...legacy, updatedAt: now, services: { youtube: true } },
                "invalid legacy services",
              ],
              [{
                ...legacy,
                updatedAt: now,
                services: { ...legacy.services, youtube: 1 },
              }, "invalid legacy services"],
              [{ ...legacy, updatedAt: now, pauses: [1] }, "invalid pauses"],
              [
                { ...legacy, updatedAt: now, pauses: ["x".repeat(8193)] },
                "invalid legacy settings",
              ],
              [
                { ...legacy, updatedAt: now, pauses: Array(129).fill("") },
                "invalid legacy settings",
              ],
            ] as const
          ) await rejectedLegacy(C, body, message, "22023");
          const fresh = migrateSettingsV2(null, { kind: "proven-fresh" });
          if (fresh.status !== "ready") throw new Error("fresh");
          const missing = JSON.parse(JSON.stringify(fresh.settings));
          missing.updatedAt = 1;
          delete missing.services.tiktok;
          const future = JSON.parse(JSON.stringify(fresh.settings));
          future.updatedAt = 1;
          future.clocks.globalOn.baseRevision = 2;
          const badSite = {
            ...legacy,
            updatedAt: 1,
            sites: { "youtube.related": "broken" },
          };
          for (
            const [raw, revision] of [[badSite, 1], [missing, 1], [future, 1], [
              { ...legacy, updatedAt: 1 },
              9007199254740991,
            ]] as const
          ) {
            await fixture`insert into public.profiles(id,settings,settings_version,settings_server_updated_at) values(${C},${
              JSON.stringify(raw)
            }::text::jsonb,${revision},'1970-01-01T00:00:00Z') on conflict(id) do update set settings=excluded.settings,settings_version=excluded.settings_version,settings_server_updated_at=excluded.settings_server_updated_at`;
            await rejectedLegacy(
              C,
              { ...legacy, updatedAt: await databaseTime() },
              "settings recovery required",
              "40001",
            );
            const oracle = await syncSettings(store, C, null);
            assertEquals(
              oracle.status,
              revision === 9007199254740991 ? "ready" : "hold",
            );
          }
          const maximumBefore = await snapshot(C);
          await legacyWrite(C, acceptedBody, acceptedId);
          assertEquals(await snapshot(C), maximumBefore);
          // Admission must check the migrated/merged document, not only raw input.
          for (const modern of [false, true]) {
            const nearLimit: Record<string, unknown> = modern
              ? { ...fresh.settings, updatedAt: 1, futurePadding: [] }
              : { ...legacy, updatedAt: 1, futurePadding: [] };
            const targetBytes = modern ? 65530 : 65000;
            const padding: string[] = [];
            nearLimit.futurePadding = padding;
            while (
              new TextEncoder().encode(JSON.stringify(nearLimit)).length <
                targetBytes
            ) {
              const remaining = targetBytes -
                new TextEncoder().encode(JSON.stringify(nearLimit)).length;
              if (remaining <= 3) {
                padding[padding.length - 1] += "x".repeat(remaining);
                break;
              }
              padding.push(
                "x".repeat(
                  Math.min(8192, remaining - (padding.length ? 3 : 2)),
                ),
              );
            }
            assertEquals(
              new TextEncoder().encode(JSON.stringify(nearLimit)).length,
              targetBytes,
            );
            const migrated = migrateSettingsV2(nearLimit, {
              kind: "acknowledged-account",
              revision: 1,
            });
            assertEquals(migrated.status, modern ? "ready" : "recovery");
            if (!modern && migrated.status === "recovery") {
              assertEquals(migrated.reason, "bounds");
            }
            await fixture`insert into public.profiles(id,settings,settings_version,settings_server_updated_at) values(${C},${
              JSON.stringify(nearLimit)
            }::text::jsonb,1,'1970-01-01T00:00:00Z') on conflict(id) do update set settings=excluded.settings,settings_version=excluded.settings_version,settings_server_updated_at=excluded.settings_server_updated_at`;
            await rejectedLegacy(
              C,
              { ...legacy, updatedAt: await databaseTime() },
              "settings recovery required",
              "40001",
            );
          }
          await fixture`delete from private.settings_writes where user_id=${C}`;
          await fixture`delete from public.profiles where id=${C}`;
        },
      );
      await t.step(
        "actual raw numeric JSON survives modern CAS and winning stamp overlay",
        async () => {
          const exact = "0.100000000000000000000000000001";
          await fixture`update public.profiles set settings=pg_catalog.jsonb_set(pg_catalog.jsonb_set(settings,'{futureNumeric}',${exact}::text::jsonb),'{clocks,globalOn,opaqueNumber}',${exact}::text::jsonb) where id=${B}`;
          const before = await read(B);
          const result = await syncSettings(
            store,
            B,
            parsed(
              write(before, [["globalOn", false]], before.settingsVersion),
            ),
          );
          assertEquals(result.status, "ready");
          assertEquals(
            (await fixture`select settings->'futureNumeric'=${exact}::text::jsonb and settings->'clocks'->'globalOn'->'opaqueNumber'=${exact}::text::jsonb as preserved from public.profiles where id=${B}`)[
              0
            ].preserved,
            true,
          );
          // A genuinely out-of-domain number must remain a typed hold, even where JS
          // rounds its exact decimal into the safe integer boundary.
          await fixture`update public.profiles set settings=pg_catalog.jsonb_set(settings,'{futureNumeric}','9007199254740991.00000000000000000000001'::jsonb) where id=${B}`;
          const heldBefore = await snapshot(B);
          assertEquals(await syncSettings(store, B, null), {
            status: "hold",
            reason: "bounds",
          });
          assertEquals(await snapshot(B), heldBefore);
          await fixture`update public.profiles set settings=pg_catalog.jsonb_set(settings,'{futureNumeric}',${exact}::text::jsonb) where id=${B}`;
        },
      );
      await t.step(
        "measured reads, near-bound payload, multi-field retries, holds and failed lock waits release transactions",
        async () => {
          const metrics: Record<
            string,
            { samples: number; elapsedMs: number; driverStatements: number }
          > = {};
          async function measure(
            name: string,
            work: () => Promise<unknown>,
            samples = 1,
          ) {
            const start = performance.now();
            const beforeStatements = writerStatements;
            for (let i = 0; i < samples; i++) await work();
            metrics[name] = {
              samples,
              elapsedMs: performance.now() - start,
              driverStatements: writerStatements - beforeStatements,
            };
            const resources =
              await fixture`select count(*) filter(where state='idle in transaction')::int as transactions,count(*) filter(where state='active')::int as active,count(*)::int as connections from pg_catalog.pg_stat_activity where usename='still_settings_writer'`;
            assertEquals(resources[0].transactions, 0);
            assertEquals(resources[0].active, 0);
            assert(resources[0].connections <= 4);
          }
          await measure("read", () => read(B), 20);
          const initial = await read(B);
          const request = parsed(
            write(
              initial,
              SETTINGS_FIELDS.map((path) => [path, false]),
              initial.settingsVersion,
            ),
          );
          await measure(
            "twenty-field-write",
            () => syncSettings(store, B, request),
          );
          await measure(
            "exact-retry",
            () => syncSettings(store, B, request),
            10,
          );
          const payload = JSON.parse(JSON.stringify((await read(B)).settings));
          payload.futurePadding = [];
          while (
            new TextEncoder().encode(JSON.stringify(payload)).length < 65530
          ) {
            payload.futurePadding.push("");
            payload.futurePadding[payload.futurePadding.length - 1] = "x"
              .repeat(
                Math.min(
                  8192,
                  65530 -
                    new TextEncoder().encode(JSON.stringify(payload)).length,
                ),
              );
          }
          assertEquals(
            migrateSettingsV2(payload, { kind: "readable-local" }).status,
            "ready",
          );
          await fixture`update public.profiles set settings=pg_catalog.jsonb_set(settings,'{futurePadding}',${
            JSON.stringify(payload.futurePadding)
          }::text::jsonb) where id=${B}`;
          await measure("maximum-canonical-read", () => read(B), 10);
          await fixture`update public.profiles set settings=settings-'futurePadding' where id=${B}`;
          await fixture`insert into public.profiles(id,settings,settings_version) values(${C},'{"schemaVersion":3}'::jsonb,1)`;
          await measure(
            "hold",
            async () =>
              assertEquals((await syncSettings(store, C, null)).status, "hold"),
            5,
          );
          await fixture`delete from public.profiles where id=${C}`;
          await measure(
            "slow-statement-timeout",
            () => assertRejects(() => writer`select pg_catalog.pg_sleep(3)`),
          );
          let entered!: () => void;
          let release!: () => void;
          const began = new Promise<void>((r) => entered = r);
          const resume = new Promise<void>((r) => release = r);
          const blocker = fixture.begin(async (tx) => {
            await tx`select id from auth.users where id=${B} for update`;
            entered();
            await resume;
          });
          await began;
          try {
            await measure("lock-timeout", () => assertRejects(() => read(B)));
            const abort = new AbortController();
            const pending = syncSettings(store, B, null, abort.signal);
            // Observe an actual server lock wait before cancellation, not a fixed sleep.
            let waiting = false;
            for (let i = 0; i < 50; i++) {
              const row =
                await fixture`select count(*)::int as n from pg_catalog.pg_stat_activity where usename='still_settings_writer' and wait_event_type='Lock'`;
              if (row[0].n > 0) {
                waiting = true;
                break;
              }
              await new Promise((r) => setTimeout(r, 10));
            }
            assert(waiting);
            abort.abort();
            await measure(
              "cancelled-lock-wait",
              () => assertRejects(() => pending),
            );
          } finally {
            release();
            await blocker;
          }
          await measure("recovered-read", () => read(B));
          // Retain the maximum fixture for the separately served HTTP probe.
          await fixture`update public.profiles set settings=pg_catalog.jsonb_set(settings,'{futurePadding}',${
            JSON.stringify(payload.futurePadding)
          }::text::jsonb) where id=${B}`;
          console.log(
            JSON.stringify({
              syntheticSettingsMetrics: metrics,
              units: "milliseconds",
              latencyThresholds: false,
            }),
          );
        },
      );
      await t.step(
        "database new-write rate and retained count/byte admission preserve exact retries",
        async () => {
          const id = crypto.randomUUID();
          const body = { ...legacy, updatedAt: await databaseTime() };
          await legacyWrite(C, body, id);
          const retained = await snapshot(C);
          // Synthetic prefill is explicit fixture authority; all admission calls remain authenticated.
          for (
            const [count, bytes, message] of [
              [120, 0, "settings new write rate limited"],
              [4096, 0, "settings identity storage full"],
              [512, 8192, "settings identity storage full"],
            ] as const
          ) {
            await fixture`delete from private.settings_writes where user_id=${C} and write_id<>${id}::uuid`;
            await fixture`insert into private.settings_writes(user_id,write_id,body,created_at) select ${C}::uuid,gen_random_uuid(),pg_catalog.jsonb_build_object('padding',pg_catalog.repeat('x',${bytes})),case when ${count}=120 then pg_catalog.clock_timestamp() else pg_catalog.clock_timestamp()-interval '2 minutes' end from pg_catalog.generate_series(1,${count})`;
            await rejectedLegacy(
              C,
              { ...body, updatedAt: await databaseTime() },
              message,
              "P0001",
            );
            const beforeRetry = await snapshot(C);
            await legacyWrite(C, body, id);
            assertEquals(await snapshot(C), beforeRetry);
          }
          await fixture`delete from private.settings_writes where user_id=${C} and write_id<>${id}::uuid`;
          assertEquals((await snapshot(C)).row, retained.row);
          await fixture`update private.settings_writes set created_at=pg_catalog.clock_timestamp()-interval '31 days' where user_id=${C}`;
          await fixture`select private.cleanup_settings_writes()`;
          assertEquals((await snapshot(C)).identities.length, 0);
          await rejectedLegacy(C, body, "legacy timestamp conflict", "40001");
          await fixture`delete from public.profiles where id=${C}`;
        },
      );
      await t.step(
        "future schema hold, overflow hold, stale future MAC, deletion waits for locked verifier then invalidates old receipt",
        async () => {
          await fixture`insert into public.profiles(id,settings,settings_version) values(${C},'{"schemaVersion":3}'::jsonb,1)`;
          assertEquals((await syncSettings(store, C, null)).status, "hold");
          const original = await read();
          const forged = {
            ...write(
              original,
              [["globalOn", true]],
              original.settingsVersion + 1,
            ),
            receipt: {
              ...original.receipt,
              revision: original.settingsVersion + 1,
            },
          };
          assertEquals(
            (await syncSettings(store, A, parsed(forged))).status,
            "rejected",
          );
          await fixture`update public.profiles set settings_version=9007199254740991 where id=${A}`;
          assertEquals(
            (await syncSettings(store, A, parsed(forged))).status,
            "rejected",
          );
          const maximum = await read();
          const saturated = parsed(
            write(maximum, [["globalOn", true]], maximum.settingsVersion),
          );
          for (let attempt = 0; attempt < 2; attempt++) {
            assertEquals(await syncSettings(store, A, saturated), {
              status: "hold",
              reason: "revision-saturated",
            });
            assertEquals(
              (await fixture`select count(*)::int as n from private.settings_writes where user_id=${A} and write_id=${saturated.writeId}::uuid`)[
                0
              ].n,
              0,
            );
            assertEquals(await read(), maximum);
          }
          await fixture`update public.profiles set settings_version=${original.settingsVersion} where id=${A}`;
          let entered!: () => void;
          const began = new Promise<void>((r) => entered = r);
          let release!: () => void;
          const resume = new Promise<void>((r) => release = r);
          const locked = store.locked(A, async () => {
            entered();
            await resume;
            return true;
          });
          await began;
          // FK key-share from ordinary auth-session creation must remain compatible
          // with the settings serialization/deletion lock.
          try {
            await fixture.begin(async (tx) => {
              await tx`set local lock_timeout='500ms'`;
              const sessionId = crypto.randomUUID();
              await tx`insert into auth.sessions(id,user_id) values(${sessionId}::uuid,${A}::uuid)`;
              await tx`delete from auth.sessions where id=${sessionId}::uuid`;
            });
          } catch (error) {
            release();
            await locked;
            throw error;
          }
          let deleted = false;
          const deleting = fixture`delete from auth.users where id=${A}`.then(
            () => {
              deleted = true;
            },
          );
          let observedWait = false;
          let stillBlocked = false;
          try {
            for (let attempt = 0; attempt < 50; attempt++) {
              const waits =
                await fixture`select count(*)::int as n from pg_catalog.pg_stat_activity where usename='u1_catalog_fixture' and wait_event_type='Lock' and query like 'delete from auth.users%'`;
              if (waits[0].n > 0) {
                observedWait = true;
                break;
              }
              await new Promise((r) => setTimeout(r, 20));
            }
            stillBlocked = !deleted;
          } finally {
            release();
          }
          await locked;
          await deleting;
          assert(
            observedWait,
            "actual server lock wait must be visible, not inferred from a delay",
          );
          assert(stillBlocked);
          await fixture`insert into auth.users(id,email) values(${A},'u3-new@example.invalid')`;
          const recreated = await read();
          assert(recreated.lineage !== original.lineage);
          assertEquals(
            (await syncSettings(
              store,
              A,
              parsed(
                write(
                  original,
                  [["globalOn", false]],
                  original.settingsVersion,
                ),
              ),
            )).status,
            "rejected",
          );
          assertEquals(
            (await fixture`select count(*)::int as n from private.settings_writes where user_id=${A}`)[
              0
            ].n,
            0,
          );
        },
      );
      await t.step(
        "merged size hold rolls back claimed identity and preserves complete canonical row",
        async () => {
          const fresh = migrateSettingsV2(null, { kind: "proven-fresh" });
          if (fresh.status !== "ready") throw new Error("fresh settings");
          const padding: string[] = [];
          const raw = {
            ...fresh.settings,
            updatedAt: 1,
            futurePadding: padding,
          };
          while (JSON.stringify(raw).length < 65530) {
            padding.push("");
            padding[padding.length - 1] = "x".repeat(
              Math.min(8192, 65530 - JSON.stringify(raw).length),
            );
          }
          assertEquals(
            migrateSettingsV2(raw, { kind: "readable-local" }).status,
            "ready",
          );
          await fixture`update public.profiles set settings=${
            JSON.stringify(raw)
          }::text::jsonb,settings_version=0 where id=${C}`;
          const before = await read(C);
          const snapshot =
            await fixture`select * from public.profiles where id=${C}`;
          const request = parsed(write(before, [["globalOn", false]], 0));
          for (let attempt = 0; attempt < 2; attempt++) {
            assertEquals(await syncSettings(store, C, request), {
              status: "hold",
              reason: "bounds",
            });
            assertEquals(
              (await fixture`select count(*)::int as n from private.settings_writes where user_id=${C} and write_id=${request.writeId}::uuid`)[
                0
              ].n,
              0,
            );
            assertEquals(
              await fixture`select * from public.profiles where id=${C}`,
              snapshot,
            );
            assertEquals(await read(C), before);
          }
        },
      );
    } finally {
      try {
        if (historicalRights !== undefined) {
          assertEquals(
            await fixture`select pg_catalog.row_to_json(e)::text as raw from public.entitlements e where user_id=${B}`,
            historicalRights,
          );
        }
      } finally {
        await writer.end();
        try {
          assertEquals(
            (await fixture`select count(*)::int as n from pg_catalog.pg_stat_activity where usename='still_settings_writer'`)[
              0
            ].n,
            0,
          );
        } finally {
          await Promise.all([ordinary.end(), fixture.end()]);
        }
      }
    }
  },
});
Deno.test({
  name:
    "U3 actual Supabase CLI packaged function authenticates narrow own-row read/write",
  ignore: !cloud || !Deno.env.get("STILL_SETTINGS_SERVED_URL"),
  async fn() {
    const endpoint = Deno.env.get("STILL_SETTINGS_SERVED_URL")!;
    assertEquals(endpoint, "http://127.0.0.1:54321/functions/v1/sync-settings");
    const secret = Deno.env.get("STILL_SETTINGS_CLI_JWT_SECRET")!;
    const metrics: {
      status: number;
      requestBytes: number;
      responseBytes: number;
      elapsedMs: number;
    }[] = [];
    const bearer = await token(A, secret, "http://kong:8000/auth/v1");
    async function send(body: unknown, auth = bearer, signal?: AbortSignal) {
      const requestBody = JSON.stringify(body);
      const start = performance.now();
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 2000);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth}`,
            "content-type": "application/json",
          },
          body: requestBody,
          signal: signal
            ? AbortSignal.any([signal, deadline.signal])
            : deadline.signal,
        });
        const text = await response.text();
        metrics.push({
          status: response.status,
          requestBytes: new TextEncoder().encode(requestBody).length,
          responseBytes: new TextEncoder().encode(text).length,
          elapsedMs: performance.now() - start,
        });
        const data = JSON.parse(text);
        return {
          status: response.status,
          data,
          instance: response.headers.get("x-still-settings-rehearsal"),
        };
      } finally {
        clearTimeout(timer);
        deadline.abort();
      }
    }
    const instance = Deno.env.get("STILL_SETTINGS_REHEARSAL_INSTANCE");
    assert(instance);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const probe = await send({ protocol: 2, action: "read" });
        if (
          probe.status === 200 && probe.instance === instance &&
          probe.data.status === "ready"
        ) {
          ready = true;
          break;
        }
      } catch { /* bounded startup poll */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(ready, "authenticated exact served instance did not become ready");
    const gateway = await send({ protocol: 2, action: "read" }, "invalid");
    assertEquals(gateway.status, 401);
    assertEquals(
      gateway.instance,
      null,
      "gateway must reject before function process",
    );
    assert(
      gateway.data.error !== "unauthorized",
      "function-layer 401 cannot prove gateway verification",
    );
    const read = await send({ protocol: 2, action: "read" });
    assertEquals(read.status, 200);
    assertEquals(read.data.status, "ready");
    const request = write(
      read.data,
      [["globalOn", false]],
      read.data.settingsVersion,
    );
    const accepted = await send(request);
    assertEquals(accepted.status, 200);
    assertEquals(accepted.data.settings.globalOn, false);
    assertEquals((await send(request)).data, accepted.data);
    const other = await token(B, secret, "http://kong:8000/auth/v1");
    assertEquals((await send(request, other)).status, 409);
    for (let i = 0; i < 10; i++) {
      const maximum = await send({ protocol: 2, action: "read" }, other);
      assertEquals(maximum.status, 200);
      assert(maximum.data.settings.futurePadding.length >= 7);
    }
    const fixture = connection(
      url!,
      "u1_catalog_fixture",
      "u1-synthetic-fixture-only",
    );
    let cancelledMetric: unknown;
    try {
      const baseline = Number(
        (await fixture`select count(*)::int as n from pg_catalog.pg_stat_activity where usename='still_settings_writer'`)[
          0
        ].n,
      );
      let entered!: () => void;
      let release!: () => void;
      const began = new Promise<void>((r) => entered = r);
      const resume = new Promise<void>((r) => release = r);
      const blocker = fixture.begin(async (tx) => {
        await tx`select id from auth.users where id=${B} for update`;
        entered();
        await resume;
      });
      await began;
      const abort = new AbortController();
      const pending = send(
        { protocol: 2, action: "read" },
        other,
        abort.signal,
      );
      void pending.catch(() => {});
      try {
        let waiting = false;
        for (let i = 0; i < 50; i++) {
          if (
            (await fixture`select count(*)::int as n from pg_catalog.pg_stat_activity where usename='still_settings_writer' and wait_event_type='Lock'`)[
              0
            ].n > 0
          ) {
            waiting = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        assert(
          waiting,
          "served request must reach an observed database lock wait",
        );
        const start = performance.now();
        abort.abort();
        await assertRejects(() => pending);
        let released = false;
        for (let i = 0; i < 100; i++) {
          if (
            (await fixture`select count(*)::int as n from pg_catalog.pg_stat_activity where usename='still_settings_writer' and state in ('active','idle in transaction')`)[
              0
            ].n === 0
          ) {
            released = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        assert(
          released,
          "aborted served request must release within configured database deadlines",
        );
        assert(
          Number(
            (await fixture`select count(*)::int as n from pg_catalog.pg_stat_activity where usename='still_settings_writer'`)[
              0
            ].n,
          ) <= baseline,
        );
        cancelledMetric = {
          elapsedMs: performance.now() - start,
          fetchAborted: true,
          transactionsReleased: true,
          releaseCause:
            "request abort or configured lock deadline; not distinguished",
        };
      } finally {
        abort.abort();
        release();
        await blocker;
        await pending.catch(() => {});
      }
      assertEquals(
        (await send({ protocol: 2, action: "read" }, other)).status,
        200,
      );
    } finally {
      await fixture.end();
    }
    console.log(
      JSON.stringify({
        syntheticServedSettingsMetrics: metrics,
        cancelledMetric,
        units: "milliseconds",
        latencyThresholds: false,
      }),
    );
  },
});
