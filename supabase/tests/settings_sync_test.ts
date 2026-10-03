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
    const writer = connection(
      url!,
      "still_settings_writer",
      SYNTHETIC_PASSWORD,
    );
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
        },
      );
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
            const grants =
              await fixture`select has_function_privilege(${role},'private.lock_settings(uuid,uuid,text)','execute') as allowed`;
            assertEquals(grants[0].allowed, false);
          }
          assertEquals(
            (await fixture`select count(*)::int as n from pg_catalog.pg_auth_members where roleid=(select oid from pg_catalog.pg_roles where rolname='still_settings_writer') or member=(select oid from pg_catalog.pg_roles where rolname='still_settings_writer')`)[
              0
            ].n,
            0,
          );
        },
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
          }::jsonb,${id}::uuid)`;
        });
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
          await fixture`update public.profiles set settings=settings || '{"future":{"keep":true}}'::jsonb where id=${B}`;
          const preserved = await read(B);
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
          await assertRejects(() =>
            legacyWrite(B, { ...legacy, updatedAt: Date.now() })
          );
          assertEquals((await read(B)).settings.future, { keep: true });
          await legacyWrite(B, legacy, id); // exact old identity only returns current canonical
        },
      );
      await t.step(
        "future schema hold, overflow hold, stale future MAC, deletion waits for locked verifier then invalidates old receipt",
        async () => {
          await fixture`insert into public.profiles(id,settings,settings_version) values(${C},'{"schemaVersion":3}'::jsonb,1)`;
          assertEquals((await syncSettings(store, C, null)).status, "hold");
          const original = await read();
          await fixture`update public.profiles set settings_version=9007199254740991 where id=${A}`;
          const maximum = await read();
          assertEquals(
            (await syncSettings(
              store,
              A,
              parsed(
                write(maximum, [["globalOn", true]], maximum.settingsVersion),
              ),
            )).status,
            "hold",
          );
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
    } finally {
      await Promise.all([ordinary.end(), fixture.end(), writer.end()]);
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
    const bearer = await token(A, secret, "http://kong:8000/auth/v1");
    async function send(body: unknown, auth = bearer) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      return { status: response.status, data };
    }
    assertEquals(
      (await send({ protocol: 2, action: "read" }, "invalid")).status,
      401,
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
  },
});
