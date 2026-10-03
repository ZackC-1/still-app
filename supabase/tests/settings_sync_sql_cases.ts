import { assert, assertEquals, assertRejects } from "@std/assert";
import type postgres from "postgres";
import { PgSettingsStore } from "../functions/_shared/pg-settings-store.ts";
import { PgRateLimiter } from "../functions/_shared/pg-store.ts";
import { syncSettings } from "../functions/_shared/settings-store.ts";
import { readSettingsOperationRequest } from "../../packages/shared-types/src/settings-operation.ts";
import { A, write } from "./synthetic_settings_helpers.ts";

type Database = ReturnType<typeof postgres>;
const DRIVER_ACCOUNT = "44444444-4444-4444-8444-444444444444";

/** Actual maintained-driver tests: mocks do not implement PostgreSQL parameter OID inference. */
export async function verifySettingsDriverJSON(
  fixture: Database,
  writer: Database,
) {
  await fixture`insert into auth.users(id,email) values (${DRIVER_ACCOUNT},'u3-driver@example.invalid')`;
  try {
    const store = new PgSettingsStore(writer);
    async function read() {
      const result = await syncSettings(store, DRIVER_ACCOUNT, null);
      assertEquals(result.status, "ready");
      if (result.status !== "ready") {
        throw new Error("Synthetic read unavailable");
      }
      return result;
    }
    async function commit(paths: [string, boolean][]) {
      const initial = await read();
      const decoded = readSettingsOperationRequest(
        write(initial, paths, initial.settingsVersion),
      );
      assertEquals(decoded.status, "parsed");
      if (decoded.status !== "parsed") {
        throw new Error("Synthetic request unavailable");
      }
      const result = await syncSettings(store, DRIVER_ACCOUNT, decoded.request);
      assertEquals(result.status, "ready");
      return result;
    }
    // Empty-profile CAS sends the literal JSON null through a text parameter, not "null".
    await commit([["globalOn", false], ["sites.youtube.related", true]]);
    const exact = "9007199254740990.00000000000000000000001";
    await fixture`update public.profiles set settings=pg_catalog.jsonb_set(pg_catalog.jsonb_set(settings,'{futureNumeric}',${exact}::text::jsonb),'{clocks,globalOn,opaqueNumber}',${exact}::text::jsonb) where id=${DRIVER_ACCOUNT}`;
    const result = await commit([["globalOn", true], [
      "sites.youtube.comments",
      true,
    ]]);
    if (result.status !== "ready") {
      throw new Error("Synthetic write unavailable");
    }
    assertEquals(result.settings.globalOn, true);
    assertEquals(result.settings.sites["youtube.comments"], true);
    assertEquals(
      (await fixture`select settings->'futureNumeric'=${exact}::text::jsonb and settings->'clocks'->'globalOn'->'opaqueNumber'=${exact}::text::jsonb as preserved from public.profiles where id=${DRIVER_ACCOUNT}`)[
        0
      ].preserved,
      true,
    );
    const bodies =
      await fixture`select pg_catalog.jsonb_typeof(body) as kind,pg_catalog.jsonb_typeof(body->'operations') as operations from private.settings_writes where user_id=${DRIVER_ACCOUNT}`;
    assertEquals(bodies.length, 2);
    for (const body of bodies) {
      assertEquals([body.kind, body.operations], ["object", "array"]);
    }
  } finally {
    await fixture`delete from auth.users where id=${DRIVER_ACCOUNT}`;
  }
}

export async function verifySettingsLimiterBuckets(
  fixture: Database,
  writer: Database,
) {
  const limiter = new PgRateLimiter(writer);
  for (
    const surface of [
      "checkout",
      "reconcile",
      "review-signin:request",
      "review-signin:verify",
    ]
  ) {
    assertEquals(
      await limiter.consume(`${surface}:ip:198.51.100.42`, 100, 600),
      0,
    );
  }
  for (const suffix of [`user:${A}`, "ip:198.51.100.43"]) {
    const key = `settings-sync:${suffix}`;
    assertEquals(await limiter.consume(key, 2, 600), 0);
    assertEquals(await limiter.consume(key, 2, 600), 0);
    // A window boundary may intervene once; repeated calls must still reach their bound.
    const waits = await Promise.all(
      Array.from({ length: 4 }, () => limiter.consume(key, 2, 600)),
    );
    assert(waits.some((wait) => wait > 0));
  }
  const before =
    await fixture`select pg_catalog.row_to_json(c)::text as raw from public.rate_limit_counters c order by bucket_key,window_start`;
  await assertRejects(() =>
    limiter.consume("settings-sync-unknown:ip:198.51.100.44", 2, 600)
  );
  assertEquals(
    await fixture`select pg_catalog.row_to_json(c)::text as raw from public.rate_limit_counters c order by bucket_key,window_start`,
    before,
  );
  for (const role of ["anon", "authenticated", "service_role"]) {
    assertEquals(
      (await fixture`select has_function_privilege(${role},'public.consume_rate_limit(text,integer,integer)','execute') as allowed`)[
        0
      ].allowed,
      false,
    );
  }
}

export async function verifySettingsLegacyOwnerGrants(
  fixture: Database,
  candidate: string,
) {
  const owner =
    await fixture`select r.rolname,r.rolsuper from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid=p.proowner where p.oid='public.write_profile_settings(jsonb,uuid)'::regprocedure`;
  assertEquals(owner.map((row) => [row.rolname, row.rolsuper]), [[
    "postgres",
    false,
  ]]);
  for (
    const helper of [
      "private.settings_json_bounded(jsonb)",
      "private.settings_fields()",
      "private.settings_canonical_valid(jsonb,bigint)",
    ]
  ) {
    assertEquals(
      (await fixture`select has_function_privilege('postgres',${helper},'execute') as allowed`)[
        0
      ].allowed,
      true,
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
        (await fixture`select has_function_privilege(${role},${helper},'execute') as allowed`)[
          0
        ].allowed,
        false,
      );
      const failure = await assertRejects(() =>
        fixture.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select private.settings_json_bounded('{}'::jsonb)`;
        })
      );
      assertEquals((failure as Error & { code: string }).code, "42501");
    }
  }
  assertEquals(
    (await fixture`select has_function_privilege('postgres','private.claim_settings_write(uuid,uuid,jsonb)','execute') as allowed`)[
      0
    ].allowed,
    true,
  );
  // The first precondition must fail before any candidate DDL. The surrounding transaction
  // also proves the deliberately drifted owner is restored; no grants bless the new owner.
  const failure = await assertRejects(() =>
    fixture.begin(async (tx) => {
      await tx`alter function public.write_profile_settings(jsonb,uuid) owner to u1_catalog_fixture`;
      await tx.unsafe(candidate);
    })
  );
  assertEquals((failure as Error & { code: string }).code, "42501");
  assertEquals(
    (failure as Error).message,
    "legacy settings owner precondition",
  );
  assertEquals(
    await fixture`select r.rolname,r.rolsuper from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid=p.proowner where p.oid='public.write_profile_settings(jsonb,uuid)'::regprocedure`,
    owner,
  );
  const creator =
    await fixture`select proowner,proacl from pg_catalog.pg_proc where oid='private.settings_json_bounded(jsonb)'::regprocedure`;
  const grantStart = candidate.lastIndexOf("do $$ declare helper text;");
  assert(grantStart >= 0);
  const creatorFailure = await assertRejects(() =>
    fixture.begin(async (tx) => {
      await tx`alter function private.settings_json_bounded(jsonb) owner to postgres`;
      await tx.unsafe(candidate.slice(grantStart));
    })
  );
  assertEquals((creatorFailure as Error & { code: string }).code, "42501");
  assertEquals(
    (creatorFailure as Error).message,
    "settings helper creator precondition",
  );
  assertEquals(
    await fixture`select proowner,proacl from pg_catalog.pg_proc where oid='private.settings_json_bounded(jsonb)'::regprocedure`,
    creator,
  );
}
