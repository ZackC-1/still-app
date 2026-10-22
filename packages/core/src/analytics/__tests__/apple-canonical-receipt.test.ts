import { describe, it, expect, vi } from "vitest";
import { AnalyticsClient, QUEUE_KEY } from "../client.js";
import { TEST_PRIVACY, TEST_PERMISSION } from "./privacy-fixture.js";
import { createApplePurchaseAnalytics } from "../apple-purchase-analytics.js";
const clock = Date.now();
const receipt = {
  uuid: "11111111-1111-4111-8111-111111111111",
  event: "purchase_recorded",
  timestamp: new Date(clock - 1_000).toISOString(),
  properties: { product: "still-pro-v3", purchase_origin: "app_store" },
};
function harness() {
  const data: Record<string, unknown> = {};
  let on = true;
  const store = {
    get: async (k: string) => structuredClone(data[k]),
    set: async (k: string, v: unknown) => {
      data[k] = structuredClone(v);
    },
  };
  const fetch = vi.fn(async () => new Response("{}"));
  const client = new AnalyticsClient({
    ...TEST_PRIVACY,
    envelope: { build_channel: "release" },
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    surface: "app-ios",
    appVersion: "3.0.0",
    store,
    identity: async () => ({
      installId: "22222222-2222-4222-8222-222222222222",
      anchorId: "33333333-3333-4333-8333-333333333333",
      created: false,
      returning: false,
    }),
    consent: async () => on,
    fetch: fetch as typeof globalThis.fetch,
    now: () => clock,
    uuid: () => crypto.randomUUID(),
    schedule: () => {},
  });
  const context = async () => {
    const observation = await client.captureObservation();
    if (!observation) return null;
    const scope = await client.applePurchaseScope(observation);
    return scope
      ? {
          client,
          observation,
          scope,
          surface: "app-ios" as const,
          appVersion: "3.0.0",
        }
      : null;
  };
  return {
    client,
    fetch,
    store,
    data,
    context,
    off: () => {
      on = false;
      client.permissionChanged();
    },
    on: () => {
      on = true;
    },
  };
}
describe("Apple canonical result transport", () => {
  it("leaves generic purchase producers rejected and sends server UUID/time under existing anonymous identity", async () => {
    const h = harness();
    const c = (await h.context())!;
    expect(c).not.toBeNull();
    await h.client.trackUnchecked(receipt.event, receipt.properties);
    await h.client.flush();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(
      await h.client.deliverAppleCanonicalReceipt(
        receipt,
        c.observation,
        c.scope,
      ),
    ).toBe(true);
    const body = JSON.parse(
      (h.fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.batch[0]).toMatchObject({
      ...receipt,
      properties: {
        distinct_id: TEST_PERMISSION.provider.anonymousId,
        signed_in: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain("originProof");
    expect(JSON.stringify(body)).not.toContain("capability");
    expect((h.data[QUEUE_KEY] as unknown[] | undefined) ?? []).toEqual([]);
  });
  it("refuses off, changed account generation, foreign surface, arbitrary properties, old/future receipts", async () => {
    for (const value of [
      { ...receipt, properties: { ...receipt.properties, providerId: "123" } },
      {
        ...receipt,
        timestamp: new Date(clock - 31 * 86_400_000).toISOString(),
      },
      { ...receipt, timestamp: new Date(clock + 1_000).toISOString() },
      {
        ...receipt,
        properties: { ...receipt.properties, purchase_origin: "mac_app_store" },
      },
    ]) {
      const h = harness(),
        c = (await h.context())!;
      expect(
        await h.client.deliverAppleCanonicalReceipt(
          value,
          c.observation,
          c.scope,
        ),
      ).toBe(false);
      expect(h.fetch).not.toHaveBeenCalled();
    }
    const h = harness(),
      c = (await h.context())!;
    h.off();
    expect(
      await h.client.deliverAppleCanonicalReceipt(
        receipt,
        c.observation,
        c.scope,
      ),
    ).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
    const other = harness(),
      d = (await other.context())!;
    expect(
      await other.client.deliverAppleCanonicalReceipt(receipt, d.observation, {
        ...d.scope,
        accountGeneration: d.scope.accountGeneration + 1,
      }),
    ).toBe(false);
  });
  it("retry sends the same immutable canonical identity and never puts receipts into the ordinary queue", async () => {
    const h = harness(),
      c = (await h.context())!;
    h.fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(
      await h.client.deliverAppleCanonicalReceipt(
        receipt,
        c.observation,
        c.scope,
      ),
    ).toBe(false);
    expect(
      await h.client.deliverAppleCanonicalReceipt(
        receipt,
        c.observation,
        c.scope,
      ),
    ).toBe(true);
    const bodies = h.fetch.mock.calls.map((call) =>
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(h.data[QUEUE_KEY] ?? []).toEqual([]);
  });
  it("preparation alone and already-owned outcomes do not bind or produce a sale", async () => {
    const h = harness();
    const request = vi.fn(async () => ({
      schema: 1,
      status: "prepared",
      capability: "a".repeat(64),
    }));
    const a = createApplePurchaseAnalytics({
      context: h.context,
      store: h.store,
      projectKey: "phc_test",
      request,
    });
    const complete = await a.begin();
    expect(complete).not.toBeNull();
    complete!({
      outcome: "purchased",
      receipt: "entitled",
      productId: "still_pro_v3",
    });
    await a.observe();
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("clear after a native completion fences server result admission", async () => {
    const h = harness();
    let completeServer!: (v: unknown) => void;
    let reached!: () => void;
    const entered = new Promise<void>((r) => {
      reached = r;
    });
    const request = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "prepare"
        ? { schema: 1, status: "prepared", capability: "a".repeat(64) }
        : new Promise<unknown>((r) => {
            completeServer = r;
            reached();
          }),
    );
    const a = createApplePurchaseAnalytics({
      context: h.context,
      store: h.store,
      projectKey: "phc_test",
      request,
    });
    const complete = (await a.begin())!;
    complete({
      outcome: "purchased",
      receipt: "entitled",
      productId: "still_pro_v3",
      newPurchaseEvidence: {
        productId: "still_pro_v3",
        bundleId: "com.test.still",
        signedTransaction: "a.b.c",
      },
    });
    await entered;
    a.clear();
    h.off();
    completeServer({ schema: 1, status: "canonical", events: [receipt] });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.data["still:analytics:apple-purchase"]).toBeNull();
  });
  it("foreground retry preserves stable IDs, recovers bound delivery, and stops after local retention", async () => {
    const h = harness();
    const refund = {
      ...receipt,
      uuid: "44444444-4444-4444-8444-444444444444",
      event: "purchase_refunded",
    };
    let returned = false;
    const request = vi.fn(async (body: Record<string, unknown>) => {
      if (body.action === "prepare")
        return { schema: 1, status: "prepared", capability: "a".repeat(64) };
      if (body.action === "commit") return null; // Canonical binding succeeded but its response was lost.
      return {
        schema: 1,
        status: "canonical",
        events: returned ? [receipt, refund] : [receipt],
      };
    });
    const deps = {
      context: h.context,
      store: h.store,
      projectKey: "phc_test",
      request,
    };
    const a = createApplePurchaseAnalytics(deps),
      complete = (await a.begin())!;
    complete({
      outcome: "purchased",
      receipt: "entitled",
      productId: "still_pro_v3",
      newPurchaseEvidence: {
        productId: "still_pro_v3",
        bundleId: "com.test.still",
        signedTransaction: "a.b.c",
      },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    // Recreate the coordinator, preserving only its local scope/capability record.
    const restarted = createApplePurchaseAnalytics(deps);
    await restarted.observe();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    returned = true;
    await restarted.observe();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await restarted.observe();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const bodies = h.fetch.mock.calls.map((call) =>
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    );
    expect(bodies[0].batch[0].uuid).toBe(receipt.uuid);
    expect(bodies[1].batch[0].uuid).toBe(refund.uuid);
    (
      h.data["still:analytics:apple-purchase"] as { retainUntil: number }
    ).retainUntil = Date.now() - 1;
    const calls = request.mock.calls.length;
    await restarted.observe();
    expect(request).toHaveBeenCalledTimes(calls);
    expect(h.data["still:analytics:apple-purchase"]).toBeNull();
  });
  it("omits an expired sale while delivering a fresh refund within capability retention", async () => {
    const h = harness();
    const oldSale = {
      ...receipt,
      timestamp: new Date(clock - 31 * 86_400_000).toISOString(),
    };
    const refund = {
      ...receipt,
      uuid: "44444444-4444-4444-8444-444444444444",
      event: "purchase_refunded",
    };
    const request = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "prepare"
        ? { schema: 1, status: "prepared", capability: "a".repeat(64) }
        : { schema: 1, status: "canonical", events: [oldSale, refund] },
    );
    const a = createApplePurchaseAnalytics({
      context: h.context,
      store: h.store,
      projectKey: "phc_test",
      request,
    });
    const complete = (await a.begin())!;
    complete({
      outcome: "purchased",
      receipt: "entitled",
      productId: "still_pro_v3",
      newPurchaseEvidence: {
        productId: "still_pro_v3",
        bundleId: "com.test.still",
        signedTransaction: "a.b.c",
      },
    });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledOnce());
    const body = JSON.parse(
      (h.fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.batch[0].uuid).toBe(refund.uuid);
  });
});
