import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  A,
  B,
  connection,
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
