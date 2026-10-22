import { assertEquals } from "@std/assert";
import { mintHs256, TEST_EXPECTED_CLAIMS } from "../_shared/test-helpers.ts";
import {
  handlePurchaseAnalytics,
  type PurchaseAnalyticsDeps,
} from "./handler.ts";
import { sendPurchaseAnalytics } from "./posthog.ts";
import type { PurchaseAnalyticsClaim } from "./store.ts";
const SECRET = "test-jwt-secret-at-least-32-characters-long!!";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "a".repeat(64),
  PROJECT = "b".repeat(64);
const claim: PurchaseAnalyticsClaim = {
  operation: "22222222-2222-4222-8222-222222222222",
  token: "33333333-3333-4333-8333-333333333333",
  subject: "44444444-4444-4444-8444-444444444444",
  id: "55555555-5555-4555-8555-555555555555",
  event: "purchase_recorded",
  at: "2026-10-21T20:00:00.000Z",
  surface: "chrome",
  appVersion: "3.0.0",
};
async function request(
  body: unknown = { originProof: ORIGIN, projectKeySha256: PROJECT },
  signal?: AbortSignal,
) {
  return new Request("https://example.invalid/analytics-purchase", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${await mintHs256({ sub: ACCOUNT }, SECRET)}`,
    },
    body: JSON.stringify(body),
  });
}
function fixture() {
  const sent: PurchaseAnalyticsClaim[] = [],
    finished: boolean[] = [],
    scopes: string[][] = [];
  let clock = 0,
    active = true;
  const deps: PurchaseAnalyticsDeps = {
    jwtSecret: SECRET,
    expected: TEST_EXPECTED_CLAIMS,
    enabled: true,
    projectKeySha256: PROJECT,
    limiter: { consume: async () => 0 },
    now: () => clock,
    store: {
      claim: async (account, origin) => {
        scopes.push([account, origin]);
        return claim;
      },
      current: async () => active,
      finish: async (_, delivered) => {
        finished.push(delivered);
        return true;
      },
    },
    send: async (event) => {
      sent.push(event);
      return true;
    },
  };
  return {
    deps,
    sent,
    finished,
    scopes,
    setClock: (n: number) => {
      clock = n;
    },
    retire: () => {
      active = false;
    },
  };
}
Deno.test(
  "canonical purchase reports only server claims scoped by authenticated account and origin",
  async () => {
    const f = fixture();
    const response = await handlePurchaseAnalytics(await request(), f.deps);
    assertEquals(response.status, 200);
    assertEquals(f.sent.length, 2);
    assertEquals(f.scopes, [
      [ACCOUNT, ORIGIN],
      [ACCOUNT, ORIGIN],
    ]);
    assertEquals(f.finished, [true, true]);
  },
);
Deno.test(
  "no event body/subject/outcome override and no cross-project reporting",
  async () => {
    for (const body of [
      {
        originProof: ORIGIN,
        projectKeySha256: PROJECT,
        event: "purchase_recorded",
      },
      { originProof: ORIGIN, projectKeySha256: PROJECT, subject: ACCOUNT },
      { originProof: "bad", projectKeySha256: PROJECT },
    ]) {
      const f = fixture();
      assertEquals(
        (await handlePurchaseAnalytics(await request(body), f.deps)).status,
        400,
      );
      assertEquals(f.sent, []);
    }
    const f = fixture();
    assertEquals(
      await (
        await handlePurchaseAnalytics(
          await request({
            originProof: ORIGIN,
            projectKeySha256: "c".repeat(64),
          }),
          f.deps,
        )
      ).json(),
      { state: "test_channel" },
    );
    assertEquals(f.scopes, []);
  },
);
Deno.test("disabled reporting and retired subjects never send", async () => {
  const f = fixture();
  assertEquals(
    (
      await handlePurchaseAnalytics(await request(), {
        ...f.deps,
        enabled: false,
      })
    ).status,
    503,
  );
  f.retire();
  await handlePurchaseAnalytics(await request(), f.deps);
  assertEquals(f.sent, []);
  assertEquals(f.finished, [false]);
});
Deno.test(
  "a late final retirement check cannot exceed the dispatch lifetime",
  async () => {
    const f = fixture();
    const store = {
      ...f.deps.store!,
      current: async () => {
        f.setClock(4001);
        return true;
      },
    };
    await handlePurchaseAnalytics(await request(), { ...f.deps, store });
    assertEquals(f.sent, []);
    assertEquals(f.finished, [false]);
  },
);
Deno.test(
  "provider failure releases only the claim and no automatic retry happens",
  async () => {
    const f = fixture();
    await handlePurchaseAnalytics(await request(), {
      ...f.deps,
      send: async () => {
        throw new Error("offline");
      },
    });
    assertEquals(f.finished, [false]);
    assertEquals(f.scopes.length, 1);
  },
);
Deno.test("an aborted request does not claim or forward", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await handlePurchaseAnalytics(
    await request(undefined, controller.signal),
    f.deps,
  );
  assertEquals(f.scopes, []);
  assertEquals(f.sent, []);
});
Deno.test(
  "provider envelope is fixed and stable; references and consent proofs never leave",
  async () => {
    const payloads: unknown[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      payloads.push(JSON.parse(init!.body as string));
      return Promise.resolve(new Response("", { status: 200 }));
    };
    for (let i = 0; i < 2; i++)
      assertEquals(
        await sendPurchaseAnalytics(
          { projectKey: "public-key", host: "https://example.invalid" },
          claim,
          new AbortController().signal,
          fetchImpl,
        ),
        true,
      );
    assertEquals(payloads[0], payloads[1]);
    assertEquals(payloads[0], {
      api_key: "public-key",
      batch: [
        {
          event: "purchase_recorded",
          uuid: claim.id,
          timestamp: claim.at,
          properties: {
            distinct_id: claim.subject,
            $lib: "still-server",
            $geoip_disable: true,
            surface: "chrome",
            store: "chrome",
            app_version: "3.0.0",
            purchase_origin: "web",
            product: "still-pro-v3",
          },
        },
      ],
    });
  },
);
