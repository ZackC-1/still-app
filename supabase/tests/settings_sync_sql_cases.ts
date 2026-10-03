import { assert, assertEquals, assertRejects } from "@std/assert";
import type postgres from "postgres";
import { PgSettingsStore } from "../functions/_shared/pg-settings-store.ts";
import { PgRateLimiter } from "../functions/_shared/pg-store.ts";
import { syncSettings } from "../functions/_shared/settings-store.ts";
import { readSettingsOperationRequest } from "../../packages/shared-types/src/settings-operation.ts";
import {
  SETTINGS_FIELDS,
  type SettingsField,
  type SettingsV2,
} from "@still/shared-types";
import { migrateSettingsV2 } from "../../packages/core/src/storage/settings-v2.ts";
import { A, write } from "./synthetic_settings_helpers.ts";

type Database = ReturnType<typeof postgres>;
const DRIVER_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const BOUNDS_ACCOUNT = "55555555-5555-4555-8555-555555555555";

/** Assert results inside the measured work, including every immutable retained retry. */
export async function verifySettingsTwentyFieldWrite(
  store: PgSettingsStore,
  fixture: Database,
  subject: string,
  measure: (
    name: string,
    work: () => Promise<void>,
    samples?: number,
  ) => Promise<void>,
) {
  const initial = await syncSettings(store, subject, null);
  assertEquals(initial.status, "ready");
  if (initial.status !== "ready") {
    throw new Error("Synthetic workload read unavailable");
  }
  const decoded = readSettingsOperationRequest(write(
    initial,
    SETTINGS_FIELDS.map((field) => [field, false]),
    initial.settingsVersion,
  ));
  assertEquals(decoded.status, "parsed");
  if (decoded.status !== "parsed") {
    throw new Error("Synthetic workload request unavailable");
  }
  const request = decoded.request;
  const fieldValue = (settings: SettingsV2, field: SettingsField) => {
    if (field === "globalOn") return settings.globalOn;
    const [group, ...parts] = field.split(".");
    return (settings[group!] as Record<string, unknown>)[parts.join(".")];
  };
  const snapshot = async () => ({
    profile:
      await fixture`select pg_catalog.row_to_json(p)::text as raw from public.profiles p where id=${subject}`,
    identities:
      await fixture`select write_id::text,body::text,created_at::text from private.settings_writes where user_id=${subject} order by write_id`,
  });
  let accepted: Awaited<ReturnType<typeof syncSettings>> | undefined;
  await measure("twenty-field-write", async () => {
    const result = await syncSettings(store, subject, request);
    assertEquals(result.status, "ready");
    if (result.status !== "ready") {
      throw new Error("Synthetic workload write unavailable");
    }
    assertEquals(result.settingsVersion, initial.settingsVersion + 1);
    assertEquals(result.writeId, request.writeId);
    for (const field of SETTINGS_FIELDS) {
      assertEquals(fieldValue(result.settings, field), false, field);
      assertEquals(
        result.settings.clocks[field].baseRevision,
        initial.settingsVersion,
        field,
      );
      assertEquals(result.settings.clocks[field].localStep, 1, field);
    }
    accepted = result;
  });
  assert(accepted);
  assertEquals(await syncSettings(store, subject, null), accepted);
  const durable = await snapshot();
  const bodies =
    await fixture`select body from private.settings_writes where user_id=${subject} and write_id=${request.writeId}::uuid`;
  assertEquals(bodies.length, 1);
  assertEquals(bodies[0].body, request);
  await measure("exact-retry", async () => {
    assertEquals(await syncSettings(store, subject, request), accepted);
    assertEquals(await snapshot(), durable);
  }, 10);
  assertEquals(await syncSettings(store, subject, null), accepted);
}

/** The decoded JS document fits while preserving its exact raw decimals grows past the limit. */
export async function verifySettingsRawOverlayBounds(
  fixture: Database,
  writer: Database,
) {
  await fixture`insert into auth.users(id,email) values (${BOUNDS_ACCOUNT},'u3-bounds@example.invalid')`;
  try {
    const store = new PgSettingsStore(writer);
    const fresh = await syncSettings(store, BOUNDS_ACCOUNT, null);
    assertEquals(fresh.status, "ready");
    if (fresh.status !== "ready") {
      throw new Error("Synthetic bounds read unavailable");
    }
    const seed = readSettingsOperationRequest(
      write(fresh, [["globalOn", true]], fresh.settingsVersion),
    );
    assertEquals(seed.status, "parsed");
    if (seed.status !== "parsed") {
      throw new Error("Synthetic bounds seed unavailable");
    }
    const seeded = await syncSettings(store, BOUNDS_ACCOUNT, seed.request);
    assertEquals(seeded.status, "ready");
    if (seeded.status !== "ready") {
      throw new Error("Synthetic bounds seed unavailable");
    }
    const exact = "0." + "1".repeat(1000);
    const marker = "synthetic-exact-decimal";
    const payload = JSON.parse(JSON.stringify(seeded.settings));
    payload.futureNumeric = marker;
    payload.clocks.globalOn.opaqueNumber = marker;
    payload.futurePadding = [];
    function raw() {
      return JSON.stringify(payload).replaceAll(JSON.stringify(marker), exact);
    }
    while (raw().length < 65536) {
      const overhead = payload.futurePadding.length ? 3 : 2;
      const remaining = 65536 - raw().length;
      assert(remaining >= overhead);
      payload.futurePadding.push(
        "x".repeat(Math.min(8192, remaining - overhead)),
      );
    }
    assertEquals(raw().length, 65536);
    assertEquals(
      migrateSettingsV2(JSON.parse(raw()), { kind: "readable-local" }).status,
      "ready",
    );
    await fixture`update public.profiles set settings=${raw()}::text::jsonb where id=${BOUNDS_ACCOUNT}`;
    const snapshot = async () => ({
      profile:
        await fixture`select pg_catalog.row_to_json(p)::text as raw from public.profiles p where id=${BOUNDS_ACCOUNT}`,
      identities:
        await fixture`select write_id::text,body::text,created_at::text from private.settings_writes where user_id=${BOUNDS_ACCOUNT} order by write_id`,
      anchor:
        await fixture`select lineage::text,modern_used from private.settings_anchors where user_id=${BOUNDS_ACCOUNT}`,
    });
    const initial = await syncSettings(store, BOUNDS_ACCOUNT, null);
    assertEquals(initial.status, "ready");
    if (initial.status !== "ready") {
      throw new Error("Synthetic bounds read unavailable");
    }
    const decoded = readSettingsOperationRequest(
      write(initial, [["globalOn", false]], initial.settingsVersion),
    );
    assertEquals(decoded.status, "parsed");
    if (decoded.status !== "parsed") {
      throw new Error("Synthetic bounds request unavailable");
    }
    const before = await snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      assertEquals(await syncSettings(store, BOUNDS_ACCOUNT, decoded.request), {
        status: "hold",
        reason: "bounds",
      });
      assertEquals(await snapshot(), before);
      assertEquals(
        (await fixture`select count(*)::int as n from private.settings_writes where user_id=${BOUNDS_ACCOUNT} and write_id=${decoded.request.writeId}::uuid`)[
          0
        ].n,
        0,
      );
    }
    // The identity was rolled back: the same immutable intent can be accepted once
    // independent canonical data fits, without rewriting retained opaque values.
    const last = payload.futurePadding.length - 1;
    payload.futurePadding[last] = payload.futurePadding[last].slice(0, -1);
    assertEquals(raw().length, 65535);
    await fixture`update public.profiles set settings=${raw()}::text::jsonb where id=${BOUNDS_ACCOUNT}`;
    const accepted = await syncSettings(store, BOUNDS_ACCOUNT, decoded.request);
    assertEquals(accepted.status, "ready");
    if (accepted.status !== "ready") {
      throw new Error("Synthetic bounds recovery unavailable");
    }
    assertEquals(accepted.settings.globalOn, false);
    assertEquals(accepted.settingsVersion, initial.settingsVersion + 1);
    assertEquals(
      (await fixture`select private.settings_json_bounded(settings) as bounded,settings->'futureNumeric'=${exact}::text::jsonb and settings->'clocks'->'globalOn'->'opaqueNumber'=${exact}::text::jsonb as preserved from public.profiles where id=${BOUNDS_ACCOUNT}`)[
        0
      ],
      { bounded: true, preserved: true },
    );
    const durable = await snapshot();
    assertEquals(
      await syncSettings(store, BOUNDS_ACCOUNT, decoded.request),
      accepted,
    );
    assertEquals(await snapshot(), durable);
  } finally {
    await fixture`delete from auth.users where id=${BOUNDS_ACCOUNT}`;
  }
}

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
