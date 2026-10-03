import { assert, assertEquals, assertRejects } from "@std/assert";
import { signEs256, verifyJwt } from "../functions/_shared/jwt.ts";
import { migrateSettingsV2 } from "../../packages/core/src/storage/settings-v2.ts";
import {
  A,
  B,
  connection,
  createSyntheticSettingsAuthSession,
  token,
  write,
} from "./synthetic_settings_helpers.ts";
// Readiness evidence is a closed schema: never echo response bodies, instance
// identifiers, exception messages, tokens, or driver/CLI text.
function readinessObservation(
  status: number,
  actualInstance: string | null,
  expectedInstance: string,
  data: unknown,
) {
  const record =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {};
  return {
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null,
    instance: actualInstance === null
      ? "missing"
      : actualInstance === expectedInstance
      ? "exact"
      : "mismatch",
    protocolStatus:
      ["ready", "hold", "rejected"].includes(record.status as string)
        ? record.status
        : "other",
    errorCode:
      ["unauthorized", "internal", "settings-unavailable", "request-shape"]
          .includes(record.error as string)
        ? record.error
        : "other",
  };
}
Deno.test("readiness diagnostics redact arbitrary bodies and instance markers", () => {
  const sentinel = "private-credential-payload-sentinel";
  assertEquals(
    readinessObservation(401, "expected", "expected", {
      error: "unauthorized",
      secret: sentinel,
    }),
    {
      httpStatus: 401,
      instance: "exact",
      protocolStatus: "other",
      errorCode: "unauthorized",
    },
  );
  const redacted = readinessObservation(999, sentinel, "expected", {
    error: sentinel,
    status: sentinel,
    body: sentinel,
  });
  assertEquals(redacted, {
    httpStatus: null,
    instance: "mismatch",
    protocolStatus: "other",
    errorCode: "other",
  });
  assert(!JSON.stringify(redacted).includes(sentinel));
  assertEquals(readinessObservation(200, null, "expected", null), {
    httpStatus: 200,
    instance: "missing",
    protocolStatus: "other",
    errorCode: "other",
  });
});
// I/O substitution controls for the fixture helper, not actual Auth/CLI proof.
Deno.test("Auth session fixture verifies signing context and rejects unsafe responses", async () => {
  const originalFetch = globalThis.fetch;
  const issuer = "http://kong:8000/auth/v1";
  const sentinel = "private-auth-response-sentinel";
  try {
    for (
      const mode of [
        "valid",
        "legacy-hs",
        "wrong-key",
        "missing-jwk",
        "foreign-issuer",
        "wrong-audience",
        "wrong-role",
        "wrong-subject",
        "missing-session",
        "malformed-session",
        "numeric-session",
        "expired",
        "identity-mismatch",
        "http-failure",
        "transport-failure",
        "malformed-json",
      ]
    ) {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      ) as CryptoKeyPair;
      const kid = crypto.randomUUID();
      const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const claims: Record<string, unknown> = {
        sub: A,
        iss: issuer,
        aud: "authenticated",
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 300,
        session_id: crypto.randomUUID(),
      };
      if (mode === "foreign-issuer") {
        claims.iss = "http://127.0.0.1:54321/auth/v1";
      }
      if (mode === "wrong-audience") claims.aud = "anon";
      if (mode === "wrong-role") claims.role = "service_role";
      if (mode === "wrong-subject") claims.sub = B;
      if (mode === "missing-session") delete claims.session_id;
      if (mode === "malformed-session") claims.session_id = "invalid-session";
      if (mode === "numeric-session") claims.session_id = 1;
      if (mode === "expired") claims.exp = 1;
      const signer = mode === "wrong-key"
        ? (await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"],
        ) as CryptoKeyPair).privateKey
        : pair.privateKey;
      const issued = mode === "legacy-hs"
        ? await token(A, "synthetic-auth-legacy-secret", issuer)
        : await signEs256(claims, signer, kid);
      const paths: string[] = [];
      let signupCredentials: Record<string, unknown> | undefined;
      globalThis.fetch = (input, init) => {
        const target = new URL(
          input instanceof Request ? input.url : String(input),
        );
        assert(
          target.origin === "http://127.0.0.1:54321",
          "Auth fixture must stay on loopback",
        );
        paths.push(target.pathname + target.search);
        if (target.pathname.endsWith("/.well-known/jwks.json")) {
          return Promise.resolve(
            Response.json({
              keys: mode === "missing-jwk" ? [] : [{ ...publicKey, kid }],
            }),
          );
        }
        assert(
          init?.method === "POST",
          "Auth fixture must use maintained POST endpoints",
        );
        const headers = new Headers(init.headers);
        assert(headers.get("apikey") === "synthetic-api-key");
        assert(headers.get("authorization") === "Bearer synthetic-api-key");
        if (mode === "transport-failure") throw new Error(sentinel);
        if (mode === "http-failure") {
          return Promise.resolve(
            Response.json({ error: sentinel }, { status: 400 }),
          );
        }
        if (mode === "malformed-json") {
          return Promise.resolve(new Response(sentinel));
        }
        const body = JSON.parse(init.body as string);
        assert(
          typeof body.email === "string" &&
            body.email.endsWith("@example.invalid"),
        );
        assert(typeof body.password === "string" && body.password.length >= 32);
        assert(body.id === undefined, "Auth must assign the user identity");
        if (target.pathname.endsWith("/signup")) {
          signupCredentials = body;
          return Promise.resolve(
            Response.json({
              user: { id: mode === "identity-mismatch" ? B : A },
            }),
          );
        }
        assert(
          target.pathname + target.search ===
            "/auth/v1/token?grant_type=password",
        );
        assert(
          signupCredentials?.email === body.email &&
            signupCredentials?.password === body.password,
        );
        return Promise.resolve(
          Response.json({
            user: { id: A },
            access_token: issued,
            refresh_token: sentinel,
          }),
        );
      };
      if (mode === "valid") {
        const session = await createSyntheticSettingsAuthSession(
          "synthetic-api-key",
        );
        assert(session.subject === A && session.bearer === issued);
        assertEquals(session.sessionId, claims.session_id);
        assertEquals(paths, [
          "/auth/v1/signup",
          "/auth/v1/token?grant_type=password",
          "/auth/v1/.well-known/jwks.json",
        ]);
        // Original fabricated HS bearer cannot pass the secret-free worker context.
        assertEquals(
          await verifyJwt(
            await token(A, "synthetic-auth-legacy-secret", issuer),
            {
              jwksUrl: "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json",
              expected: {
                iss: issuer,
                aud: "authenticated",
                role: "authenticated",
              },
            },
          ),
          null,
        );
      } else {
        const error = await assertRejects(
          () => createSyntheticSettingsAuthSession("synthetic-api-key"),
          Error,
          "synthetic-auth-",
        );
        assert(
          !error.message.includes(sentinel),
          "Auth errors must redact arbitrary responses",
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
const cloud = Deno.env.get("GITHUB_ACTIONS") === "true" &&
  Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted";
const url = Deno.env.get("STILL_SETTINGS_TEST_DATABASE_URL");
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
    const instance = Deno.env.get("STILL_SETTINGS_REHEARSAL_INSTANCE")!;
    assert(instance);
    let lastReadiness: unknown = { outcome: "not-attempted" };
    const apiKey = Deno.env.get("STILL_SETTINGS_CLI_ANON_KEY")!;
    const first = await createSyntheticSettingsAuthSession(apiKey);
    const second = await createSyntheticSettingsAuthSession(apiKey);
    assert(
      first.subject !== second.subject,
      "Auth must create distinct own accounts",
    );
    const bearer = first.bearer;
    const other = second.bearer;
    // Reuse the exact maximum canonical SQL fixture as synthetic account data,
    // without moving any old account anchor, write identity or entitlement.
    const setup = connection(
      url!,
      "u1_catalog_fixture",
      "u1-synthetic-fixture-only",
    );
    try {
      const seeded =
        await setup`insert into public.profiles(id,settings,settings_version,settings_server_updated_at,updated_at)
        select ${second.subject}::uuid,settings,settings_version,settings_server_updated_at,updated_at
        from public.profiles where id=${B}`;
      assert(
        seeded.count === 1,
        "Auth account must receive the maximum canonical fixture",
      );
    } finally {
      await setup.end();
    }
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
        lastReadiness = {
          ...readinessObservation(
            response.status,
            response.headers.get("x-still-settings-rehearsal"),
            instance,
            null,
          ),
          outcome: "invalid-json",
        };
        const data = JSON.parse(text);
        lastReadiness = {
          ...readinessObservation(
            response.status,
            response.headers.get("x-still-settings-rehearsal"),
            instance,
            data,
          ),
          outcome: "response",
        };
        return {
          status: response.status,
          data,
          instance: response.headers.get("x-still-settings-rehearsal"),
        };
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          lastReadiness = {
            outcome: deadline.signal.aborted || signal?.aborted
              ? "aborted"
              : "transport-error",
          };
        }
        throw error;
      } finally {
        clearTimeout(timer);
        deadline.abort();
      }
    }
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
    if (!ready) {
      console.log(JSON.stringify({ settingsReadinessFailure: lastReadiness }));
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
    // Retain the original HS fixture as a separate function-auth denial control:
    // a valid gateway signature must still fail at the exact function instance.
    const legacyBearer = await token(
      first.subject,
      secret,
      "http://kong:8000/auth/v1",
    );
    const functionDenied = await send(
      { protocol: 2, action: "read" },
      legacyBearer,
    );
    assertEquals(functionDenied.status, 401);
    assert(
      functionDenied.instance === instance,
      "function denial must reach the exact instance",
    );
    assertEquals(functionDenied.data.error, "unauthorized");
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
      assert(
        Number(
              (await fixture`select count(*)::int as n from auth.sessions where id=${first.sessionId}::uuid and user_id=${first.subject}::uuid`)[
                0
              ].n,
            ) === 1 &&
          Number(
              (await fixture`select count(*)::int as n from auth.sessions where id=${second.sessionId}::uuid and user_id=${second.subject}::uuid`)[
                0
              ].n,
            ) === 1,
        "both served identities must own their exact verified Auth sessions",
      );
      assert(
        (await fixture`select settings->'globalOn' = 'false'::jsonb as own_write from public.profiles where id=${first.subject}`)[
          0
        ]?.own_write === true,
        "served writer must update exactly its verified Auth subject",
      );
      assert(
        Number(
          (await fixture`select count(*)::int as n from private.settings_writes where user_id=${second.subject} and write_id=${request.writeId}::uuid`)[
            0
          ].n,
        ) === 0,
        "other verified Auth account must not acquire the first account write",
      );
      // Repeat the actual SQL raw-overlay boundary shape through HTTP. Exact
      // decimals shrink when decoded into JS, but the SQL overlay preserves them.
      const seeded = await send(write(
        accepted.data,
        [["globalOn", true]],
        accepted.data.settingsVersion,
      ));
      assertEquals(seeded.status, 200);
      assertEquals(seeded.data.settings.globalOn, true);
      const exact = "0." + "1".repeat(1000);
      const marker = "synthetic-exact-decimal";
      const payload = JSON.parse(JSON.stringify(seeded.data.settings));
      payload.futureNumeric = marker;
      payload.clocks.globalOn.opaqueNumber = marker;
      payload.futurePadding = [];
      function raw() {
        return JSON.stringify(payload).replaceAll(
          JSON.stringify(marker),
          exact,
        );
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
      await fixture`update public.profiles set settings=${raw()}::text::jsonb where id=${first.subject}`;
      const snapshot = async () => ({
        profile: [
          ...await fixture`select pg_catalog.row_to_json(p)::text as raw from public.profiles p where id=${first.subject}`,
        ],
        identities: [
          ...await fixture`select write_id::text,body::text,created_at::text from private.settings_writes where user_id=${first.subject} order by write_id`,
        ],
        anchor: [
          ...await fixture`select lineage::text,modern_used from private.settings_anchors where user_id=${first.subject}`,
        ],
      });
      const boundary = await send({ protocol: 2, action: "read" });
      assertEquals(boundary.status, 200);
      assertEquals(boundary.data.status, "ready");
      const boundedRequest = write(
        boundary.data,
        [["globalOn", false]],
        boundary.data.settingsVersion,
      );
      const before = await snapshot();
      for (let attempt = 0; attempt < 2; attempt++) {
        const held = await send(boundedRequest);
        assertEquals(held.status, 409);
        assertEquals(held.instance, instance);
        assertEquals(held.data, { status: "hold", reason: "bounds" });
        assertEquals(await snapshot(), before);
        assertEquals(
          (await fixture`select count(*)::int as n from private.settings_writes where user_id=${first.subject} and write_id=${boundedRequest.writeId}::uuid`)[
            0
          ].n,
          0,
        );
      }
      // Independent canonical shrink; retain the SAME immutable request/receipt.
      const last = payload.futurePadding.length - 1;
      payload.futurePadding[last] = payload.futurePadding[last].slice(0, -1);
      assertEquals(raw().length, 65535);
      await fixture`update public.profiles set settings=${raw()}::text::jsonb where id=${first.subject}`;
      const recovered = await send(boundedRequest);
      assertEquals(recovered.status, 200);
      assertEquals(recovered.data.status, "ready");
      assertEquals(recovered.data.writeId, boundedRequest.writeId);
      assertEquals(recovered.data.settings.globalOn, false);
      assertEquals(
        recovered.data.settingsVersion,
        boundary.data.settingsVersion + 1,
      );
      assertEquals(
        (await fixture`select private.settings_json_bounded(settings) as bounded,settings->'futureNumeric'=${exact}::text::jsonb and settings->'clocks'->'globalOn'->'opaqueNumber'=${exact}::text::jsonb as preserved from public.profiles where id=${first.subject}`)[
          0
        ],
        { bounded: true, preserved: true },
      );
      const bodies =
        await fixture`select body from private.settings_writes where user_id=${first.subject} and write_id=${boundedRequest.writeId}::uuid`;
      assertEquals(bodies.length, 1);
      assertEquals(bodies[0].body, boundedRequest);
      const durable = await snapshot();
      assertEquals((await send(boundedRequest)).data, recovered.data);
      assertEquals(await snapshot(), durable);
      assertEquals(
        (await send({ protocol: 2, action: "read" })).data,
        recovered.data,
      );
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
        // The limiter locks auth.users first. Only the settings store touches
        // this profile, so this blocker cannot be satisfied by a limiter wait.
        await tx`select id from public.profiles where id=${second.subject} for update`;
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
            (await fixture`select count(*)::int as n from pg_catalog.pg_stat_activity where usename='still_settings_writer' and wait_event_type='Lock' and query like '%private.lock_settings(%'`)[
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
          "served request must reach an observed private.lock_settings wait",
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
          settingsStoreWaitObserved: true,
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
