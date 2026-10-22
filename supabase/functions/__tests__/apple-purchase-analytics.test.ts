import { assert, assertEquals } from "@std/assert";
import {
  type AppleAnalyticsDeps,
  handleApplePurchaseAnalytics,
} from "../analytics-apple-purchase/handler.ts";
import type { AppleAnalyticsState } from "../analytics-apple-purchase/store.ts";
import type { VerifiedAppleTransaction } from "../_shared/apple-access.ts";
const proof = "a".repeat(64),
  project = "b".repeat(64),
  capability = "c".repeat(64);
const tx: VerifiedAppleTransaction = {
  key: "d".repeat(64),
  environment: "production",
  bundleId: "com.test.still",
  productId: "still_pro_v3",
  transactionId: "123",
  originalTransactionId: "123",
  active: true,
  purchasedAt: 1_000,
};
const evidence = {
  productId: "still_pro_v3",
  bundleId: "com.test.still",
  signedTransaction: "e30.e30.signature",
};
function harness() {
  let allowed = true,
    retired = false,
    prepared = 0,
    reads = 0,
    verified = 0,
    commits = 0;
  let transaction: VerifiedAppleTransaction = { ...tx };
  let state: AppleAnalyticsState = {
    transaction: null,
    saleId: "11111111-1111-4111-8111-111111111111",
    refundId: "22222222-2222-4222-8222-222222222222",
    purchasedAt: null,
    refundedAt: null,
    surface: "app-ios",
    appVersion: "3.0.0",
  };
  const deps: AppleAnalyticsDeps = {
    jwtSecret: "",
    enabled: true,
    projectKeySha256: project,
    limiter: { consume: async () => allowed ? 0 : 60 },
    verifier: {
      authenticate: async () => {
        verified++;
        return transaction;
      },
      refresh: async () => transaction,
    },
    store: {
      prepare: async () => {
        prepared++;
        return !retired;
      },
      read: async () => {
        reads++;
        return retired ? null : state;
      },
      commit: async (_hash, _scope, t) => {
        commits++;
        if (retired) return null;
        state = {
          ...state,
          transaction: t,
          purchasedAt: t.purchasedAt ?? null,
          refundedAt: t.fullRefundAt ?? null,
        };
        return state;
      },
    },
  };
  const send = (
    body: Record<string, unknown>,
    headers: Record<string, string> = { "x-forwarded-for": "192.0.2.10" },
  ) =>
    handleApplePurchaseAnalytics(
      new Request("https://example.test/analytics-apple-purchase", {
        method: "POST",
        headers,
        body: JSON.stringify({
          originProof: proof,
          projectKeySha256: project,
          scope: { kind: "anonymous", anonIndex: 0 },
          ...body,
        }),
      }),
      deps,
    ).then((r) => r.json());
  return {
    deps,
    send,
    retire: () => {
      retired = true;
    },
    deny: () => {
      allowed = false;
    },
    setTransaction: (t: VerifiedAppleTransaction) => {
      transaction = t;
    },
    counts: () => ({ prepared, reads, verified, commits }),
  };
}
Deno.test("Apple anonymous preparation has fixed IP admission before allocation", async () => {
  const h = harness();
  h.deny();
  assertEquals(
    (await h.send({
      action: "prepare",
      surface: "app-ios",
      appVersion: "3.0.0",
    })).status,
    "unavailable",
  );
  assertEquals(h.counts().prepared, 0);
  const other = harness();
  assertEquals(
    (await other.send({
      action: "prepare",
      surface: "app-ios",
      appVersion: "3.0.0",
    }, {})).status,
    "unavailable",
  );
  assertEquals(other.counts().prepared, 0);
  const ok = harness();
  const prepared = await ok.send({
    action: "prepare",
    surface: "app-ios",
    appVersion: "3.0.0",
  });
  assertEquals(prepared.status, "prepared");
  assert(/^[0-9a-f]{64}$/.test(prepared.capability));
});
Deno.test("Apple actual canonical transaction yields stable closed sale/refund descriptors", async () => {
  const h = harness();
  const first = await h.send({
    action: "commit",
    capability,
    transaction: evidence,
  });
  assertEquals(first.events[0], {
    uuid: "11111111-1111-4111-8111-111111111111",
    event: "purchase_recorded",
    timestamp: new Date(1_000).toISOString(),
    properties: { product: "still-pro-v3", purchase_origin: "app_store" },
  });
  assertEquals(
    (await h.send({ action: "observe", capability })).events,
    first.events,
  );
  h.setTransaction({ ...tx, active: false, fullRefundAt: 2_000 });
  const refunded = await h.send({ action: "observe", capability });
  assertEquals(refunded.events.map((x: { event: string }) => x.event), [
    "purchase_recorded",
    "purchase_refunded",
  ]);
  assertEquals(refunded.events[0], first.events[0]);
  assertEquals(refunded.events[1].timestamp, new Date(2_000).toISOString());
  assert(!JSON.stringify(refunded).includes(capability));
  assert(!JSON.stringify(refunded).includes("transactionId"));
});
Deno.test("Apple refuses test/family/foreign project and supplied identity/outcome", async () => {
  for (
    const variant of [{ ...tx, environment: "sandbox" as const }, {
      ...tx,
      localOnly: true as const,
    }]
  ) {
    const h = harness();
    h.setTransaction(variant);
    assertEquals(
      (await h.send({ action: "commit", capability, transaction: evidence }))
        .status,
      "unavailable",
    );
    assertEquals(h.counts().commits, 0);
  }
  for (
    const extra of [{ projectKeySha256: "f".repeat(64) }, {
      distinct_id: "arbitrary",
    }, { event: "purchase_recorded" }]
  ) {
    const h = harness();
    assertEquals(
      (await h.send({
        action: "prepare",
        surface: "app-ios",
        appVersion: "3.0.0",
        ...extra,
      })).status,
      "unavailable",
    );
    assertEquals(h.counts().prepared, 0);
  }
});
Deno.test("Apple erasure after provider wait suppresses canonical results", async () => {
  const h = harness();
  h.deps.verifier!.refresh = async () => {
    h.retire();
    return tx;
  };
  assertEquals(
    (await h.send({ action: "commit", capability, transaction: evidence }))
      .status,
    "unavailable",
  );
});
Deno.test("Apple subject lane needs Auth and an unbound observe cannot invent a purchase", async () => {
  const h = harness();
  assertEquals(
    (await h.send({ action: "observe", capability })).status,
    "unavailable",
  );
  assertEquals(h.counts().verified, 0);
  const r = await h.send({
    action: "prepare",
    surface: "app-ios",
    appVersion: "3.0.0",
    scope: { kind: "subject" },
  });
  assertEquals(r.error, "unauthorized");
  assertEquals(h.counts().prepared, 0);
});
