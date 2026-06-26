import { assertEquals } from "@std/assert";
import { handleWebhook } from "./handler.ts";
import type { EntitlementStore } from "../_shared/store.ts";
import type { RevenueCatClient, RcSubscriber } from "../_shared/revenuecat.ts";

const TOKEN = "secret-webhook-token";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

const activeSub: RcSubscriber = {
  entitlements: { still_sync: { expires_date: null } },
  original_app_user_id: "rc_orig",
};
const inactiveSub: RcSubscriber = { entitlements: {} };

type Write = { userId: string; stillSync: boolean; source: string };

function mockStore() {
  const events = new Set<string>();
  const writes: Write[] = [];
  const payloads: unknown[] = [];
  const store: EntitlementStore = {
    recordEvent(eventId, _appUserId, payload) {
      if (events.has(eventId)) return Promise.resolve(false);
      events.add(eventId);
      payloads.push(payload);
      return Promise.resolve(true);
    },
    setEntitlement(userId, stillSync, source) {
      writes.push({ userId, stillSync, source });
      return Promise.resolve();
    },
  };
  return { store, writes, payloads };
}

function mockRc(subs: Record<string, RcSubscriber | null>): RevenueCatClient {
  return { getSubscriber: (id) => Promise.resolve(subs[id] ?? null) };
}

function req(body: unknown, token: string = TOKEN): Request {
  return new Request("http://x/webhook", {
    method: "POST",
    headers: { Authorization: token, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("valid webhook + active subscriber → entitlement true", async () => {
  const { store, writes } = mockStore();
  const res = await handleWebhook(
    req({ event: { id: "e1", type: "INITIAL_PURCHASE", app_user_id: A } }),
    { token: TOKEN, store, rc: mockRc({ [A]: activeSub }) },
  );
  assertEquals(res.status, 200);
  assertEquals(writes, [{ userId: A, stillSync: true, source: "webhook" }]);
});

Deno.test("valid webhook + inactive/refunded subscriber → entitlement false", async () => {
  const { store, writes } = mockStore();
  await handleWebhook(
    req({ event: { id: "e1", type: "CANCELLATION", app_user_id: A } }),
    { token: TOKEN, store, rc: mockRc({ [A]: inactiveSub }) },
  );
  assertEquals(writes[0]?.stillSync, false);
});

Deno.test("bad token → 401, no writes", async () => {
  const { store, writes } = mockStore();
  const res = await handleWebhook(
    req({ event: { id: "e", type: "X", app_user_id: A } }, "wrong-token"),
    { token: TOKEN, store, rc: mockRc({ [A]: activeSub }) },
  );
  assertEquals(res.status, 401);
  assertEquals(writes.length, 0);
});

Deno.test("duplicate event id → processed once (idempotent)", async () => {
  const { store, writes } = mockStore();
  const body = { event: { id: "dup", type: "INITIAL_PURCHASE", app_user_id: A } };
  const deps = { token: TOKEN, store, rc: mockRc({ [A]: activeSub }) };
  await handleWebhook(req(body), deps);
  const res2 = await handleWebhook(req(body), deps);
  // The event is recorded after successful reconcile, so duplicates may harmlessly re-run the
  // idempotent reconcile before the duplicate commit is noticed.
  assertEquals(writes.length, 2);
  assertEquals(((await res2.json()) as { status: string }).status, "duplicate");
});

Deno.test("out-of-order events collapse to current subscriber state", async () => {
  // A late CANCELLATION arrives, but the subscriber is currently active (re-purchased) → true.
  const { store, writes } = mockStore();
  await handleWebhook(
    req({ event: { id: "late-cancel", type: "CANCELLATION", app_user_id: A } }),
    { token: TOKEN, store, rc: mockRc({ [A]: activeSub }) },
  );
  assertEquals(writes[0]?.stillSync, true);
});

Deno.test("TRANSFER reconciles both affected UUIDs", async () => {
  const { store, writes } = mockStore();
  await handleWebhook(
    req({ event: { id: "t", type: "TRANSFER", transferred_from: [A], transferred_to: [B] } }),
    { token: TOKEN, store, rc: mockRc({ [A]: inactiveSub, [B]: activeSub }) },
  );
  assertEquals(writes.length, 2);
  assertEquals(writes.find((w) => w.userId === A)?.stillSync, false);
  assertEquals(writes.find((w) => w.userId === B)?.stillSync, true);
});

Deno.test("alias-only app_user_id resolves to the canonical UUID", async () => {
  const { store, writes } = mockStore();
  await handleWebhook(
    req({ event: { id: "al", type: "INITIAL_PURCHASE", app_user_id: "$RCAnonymousID:abc", aliases: [A] } }),
    { token: TOKEN, store, rc: mockRc({ [A]: activeSub }) },
  );
  assertEquals(writes[0]?.userId, A);
});

Deno.test("forged client customerInfo cannot grant (server lookup wins)", async () => {
  const { store, writes } = mockStore();
  await handleWebhook(
    req({
      event: { id: "f", type: "X", app_user_id: A },
      customerInfo: { entitlements: { still_sync: { active: true } } },
    }),
    { token: TOKEN, store, rc: mockRc({ [A]: inactiveSub }) },
  );
  assertEquals(writes[0]?.stillSync, false);
});

Deno.test("webhook audit log stores a minimized payload, not raw billing/customerInfo fields", async () => {
  const { store, payloads } = mockStore();
  await handleWebhook(
    req({
      event: {
        id: "min",
        type: "INITIAL_PURCHASE",
        app_user_id: "$RCAnonymousID:abc",
        aliases: [A, "$RCAnonymousID:def"],
        environment: "SANDBOX",
        product_identifier: "still_sync_web",
        expiration_date: null,
      },
      customerInfo: { entitlements: { still_sync: { active: true } } },
      subscriber_attributes: { email: { value: "buyer@example.com" } },
    }),
    { token: TOKEN, store, rc: mockRc({ [A]: activeSub }) },
  );
  assertEquals(payloads[0], {
    event: {
      id: "min",
      type: "INITIAL_PURCHASE",
      app_user_id: null,
      original_app_user_id: null,
      aliases: [A],
      transferred_from: [],
      transferred_to: [],
      environment: "SANDBOX",
      product_identifier: "still_sync_web",
      expiration_at_ms: null,
      expiration_date: null,
    },
  });
});

Deno.test("reconcile failure returns 5xx and does not commit the duplicate guard", async () => {
  const { store, payloads } = mockStore();
  const rc: RevenueCatClient = {
    getSubscriber: () => Promise.reject(new Error("RevenueCat timeout")),
  };
  const res = await handleWebhook(
    req({ event: { id: "retry-me", type: "INITIAL_PURCHASE", app_user_id: A } }),
    { token: TOKEN, store, rc },
  );
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "reconcile_failed");
  assertEquals(payloads.length, 0);
});

Deno.test("malformed JSON body → 400", async () => {
  const { store } = mockStore();
  const res = await handleWebhook(req("not json at all"), { token: TOKEN, store, rc: mockRc({}) });
  assertEquals(res.status, 400);
});
