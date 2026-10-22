import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { AnalyticsClient } from "../client.js";
import {
  purchaseAnalyticsContext,
  purchaseAnalyticsReporter,
  withCheckoutAnalytics,
  type PurchaseAnalyticsContext,
} from "../purchase-analytics.js";
import { TEST_PERMISSION, TEST_PRIVACY } from "./privacy-fixture.js";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUBJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const config = { key: "phc_synthetic", host: "https://us.i.posthog.com" };
const endpoint =
  "https://synthetic.supabase.co/functions/v1/create-web-checkout";
function context(): PurchaseAnalyticsContext {
  return {
    account: ACCOUNT,
    body: { originProof: "a".repeat(64), projectKeySha256: "b".repeat(64) },
    signal: new AbortController().signal,
    current: () => true,
  };
}
const token = (sub = ACCOUNT) =>
  `header.${btoa(JSON.stringify({ sub }))}.signature`;
const checkout = (analytics?: unknown): RequestInit => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token()}` },
  body: JSON.stringify({
    access_schema: 1,
    operation_id: "synthetic",
    analytics,
  }),
});
const drain = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

async function clientFixture() {
  const data = new Map<string, unknown>();
  let permission: unknown = TEST_PERMISSION;
  const client = new AnalyticsClient({
    ...TEST_PRIVACY,
    config,
    surface: "chrome",
    appVersion: "3.0.0.1",
    store: {
      get: async (key) => data.get(key),
      set: async (key, value) => {
        data.set(key, value);
      },
    },
    permission: async () => permission,
    consent: async () => true,
    identity: async () => ({
      installId: "11111111-1111-4111-8111-111111111111",
      anchorId: "22222222-2222-4222-8222-222222222222",
      created: false,
      returning: false,
    }),
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    schedule: () => {},
    fetch: vi.fn(),
  });
  await client.confirm(SUBJECT, { accountId: ACCOUNT, quiet: true });
  return {
    client,
    stop: () => {
      permission = null;
      client.permissionChanged();
    },
  };
}

describe("consented canonical purchase dispatch", () => {
  it("uses the existing confirmed subject and fresh permission; off invalidates captured scopes synchronously", async () => {
    const f = await clientFixture();
    const capture = purchaseAnalyticsContext(f.client, config);
    const captured = await capture();
    expect(captured?.account).toBe(ACCOUNT);
    expect(captured?.body.originProof).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(captured?.body)).not.toContain(
      TEST_PERMISSION.origin,
    );
    f.stop();
    expect(captured?.current()).toBe(false);
    expect(captured?.signal.aborted).toBe(true);
    expect(await capture()).toBeNull();
  });
  it("test/dev builds and unconfirmed/raw account identities never produce attribution", async () => {
    const f = await clientFixture();
    for (const channel of ["test", "dev"] as const)
      expect(
        await purchaseAnalyticsContext(f.client, config, channel)(),
      ).toBeNull();
    await f.client.identify(ACCOUNT);
    expect(await purchaseAnalyticsContext(f.client, config)()).toBeNull();
  });
  it("runs after real Supabase Functions authorization and preserves the functional request", async () => {
    const requests: RequestInit[] = [];
    const wire = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(init!);
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    });
    const capture = vi.fn(async () => context());
    const client = createClient(
      "https://synthetic.supabase.co",
      "synthetic-key",
      {
        accessToken: async () => token(),
        global: { fetch: withCheckoutAnalytics(wire, endpoint, capture) },
      },
    );
    const body = { access_schema: 1, operation_id: "synthetic" };
    await client.functions.invoke("create-web-checkout", { body });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(JSON.parse(requests[0]!.body as string)).toEqual({
      ...body,
      analytics: context().body,
    });
    await client.functions.invoke("complete-web-checkout", { body });
    expect(capture).toHaveBeenCalledTimes(1); // Completing/restoring never creates provenance.
  });
  it("retries strip cached attribution when permission or account changed", async () => {
    const wire = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}"),
    );
    let stale = context();
    const capture = vi.fn(async () => stale);
    const wrapped = withCheckoutAnalytics(wire, endpoint, capture);
    stale.current = () => false;
    await wrapped(endpoint, checkout(context().body));
    expect(
      JSON.parse(wire.mock.calls[0]![1]!.body as string),
    ).not.toHaveProperty("analytics");
    stale.current = () => true;
    stale = { ...stale, account: SUBJECT };
    await wrapped(endpoint, checkout());
    expect(
      JSON.parse(wire.mock.calls[1]![1]!.body as string),
    ).not.toHaveProperty("analytics");
  });
  it("unavailable optional capture cannot delay checkout beyond its bounded wait", async () => {
    vi.useFakeTimers();
    try {
      const wire = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response("{}"),
      );
      const wrapped = withCheckoutAnalytics(
        wire,
        endpoint,
        () => new Promise(() => {}),
      );
      const result = wrapped(endpoint, checkout());
      await vi.advanceTimersByTimeAsync(251);
      await result;
      expect(wire).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("reads Auth before final consent, skips stale accounts and never schedules a retry", async () => {
    const order: string[] = [];
    const send = vi.fn(async () => {});
    let active = true;
    let clock = 1;
    const c = context();
    c.current = () => active;
    const pulse = purchaseAnalyticsReporter({
      now: () => clock,
      prepare: async () => {
        order.push("auth");
        return { account: ACCOUNT, send };
      },
      capture: async () => {
        order.push("consent");
        return c;
      },
    });
    pulse();
    pulse();
    await drain();
    expect(order).toEqual(["auth", "consent"]);
    expect(send).toHaveBeenCalledTimes(1);
    clock += 30_001;
    active = false;
    pulse();
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    clock += 30_001;
    pulse();
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
