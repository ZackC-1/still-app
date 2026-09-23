import { describe, it, expect, vi } from "vitest";
import { AnalyticsClient, BATCH_SIZE, MAX_QUEUE, STATE_KEY, analyticsConfigured, type AnalyticsClientDeps } from "../client.js";
import type { AnalyticsIdentity, AnalyticsKeyValue } from "../identity.js";

const IDENTITY: AnalyticsIdentity = {
  installId: "11111111-1111-4111-8111-111111111111",
  anchorId: "22222222-2222-4222-8222-222222222222",
  created: false,
  returning: false,
};

function memory(): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: async (k) => structuredClone(data[k]), set: async (k, v) => void (data[k] = structuredClone(v)) };
}

function harness(over: Partial<AnalyticsClientDeps> = {}) {
  const store = memory();
  let consent = true;
  let clock = new Date(2026, 8, 23, 10, 0, 0).getTime();
  let seq = 0;
  const bodies: { api_key: string; batch: { event: string; properties: Record<string, unknown> }[] }[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response("{}", { status: 200 });
  });
  const timers: (() => void)[] = [];
  const client = new AnalyticsClient({
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    surface: "chrome",
    appVersion: "2.1.0",
    store,
    identity: async () => IDENTITY,
    consent: async () => consent,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => clock,
    uuid: () => `uuid-${++seq}`,
    schedule: (run) => void timers.push(run),
    ...over,
  });
  return {
    client, store, fetch, bodies, timers,
    setConsent: (v: boolean) => void (consent = v),
    advanceDays: (d: number) => void (clock += d * 86_400_000),
    queue: () => ((store.data[STATE_KEY] as { queue?: unknown[] } | undefined)?.queue ?? []) as { event: string; properties: Record<string, unknown> }[],
  };
}

describe("analyticsConfigured", () => {
  it("needs a key and an https host", () => {
    expect(analyticsConfigured({ key: "phc_x", host: "https://us.i.posthog.com" })).toBe(true);
    expect(analyticsConfigured({ key: "", host: "https://us.i.posthog.com" })).toBe(false);
    expect(analyticsConfigured({ key: "phc_x", host: "http://us.i.posthog.com" })).toBe(false);
    expect(analyticsConfigured({ key: "phc_x" })).toBe(false);
  });
});

describe("AnalyticsClient", () => {
  it("queues a valid event with surface, store, version and person properties, then sends it", async () => {
    const h = harness();
    await h.client.track("service_toggled", { service: "instagram", enabled: false });
    expect(h.timers).toHaveLength(1);
    await h.client.flush();
    expect(h.fetch).toHaveBeenCalledWith("https://us.i.posthog.com/batch/", expect.objectContaining({ method: "POST" }));
    const [sent] = h.bodies[0]!.batch;
    expect(h.bodies[0]!.api_key).toBe("phc_test");
    expect(sent!.event).toBe("service_toggled");
    expect(sent!.properties).toMatchObject({
      service: "instagram",
      enabled: false,
      distinct_id: IDENTITY.anchorId,
      $device_id: IDENTITY.installId,
      surface: "chrome",
      store: "chrome",
      app_version: "2.1.0",
      signed_in: false,
      $set: { uses_chrome: true, uses_store_chrome: true, last_version_chrome: "2.1.0", last_surface: "chrome" },
      $set_once: { first_surface: "chrome", first_store: "chrome" },
    });
    expect(h.queue()).toHaveLength(0);
  });

  it("drops events that do not match the schema", async () => {
    const h = harness();
    await h.client.trackUnchecked("active", { url: "https://www.youtube.com/shorts/abc" });
    await h.client.trackUnchecked("page_view", {});
    expect(h.queue()).toHaveLength(0);
  });

  it("queues and sends nothing while analytics is off, and clearQueue empties what was waiting", async () => {
    const h = harness();
    await h.client.track("active", {});
    h.setConsent(false);
    await h.client.track("signed_in", {});
    await h.client.flush();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.queue()).toHaveLength(1);
    await h.client.clearQueue();
    expect(h.queue()).toHaveLength(0);
  });

  it("an unconfigured build does nothing at all", async () => {
    const h = harness({ config: { key: "" } });
    expect(h.client.enabled).toBe(false);
    await h.client.track("active", {});
    await h.client.identify("user-1");
    await h.client.flush();
    expect(h.store.data).toEqual({});
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("keeps events for a later retry when the network or server fails", async () => {
    const failing = vi.fn(async () => { throw new TypeError("offline"); });
    const h = harness({ fetch: failing as unknown as typeof fetch });
    await h.client.track("active", {});
    await h.client.flush();
    expect(h.queue()).toHaveLength(1);

    const h2 = harness({ fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
    await h2.client.track("active", {});
    await h2.client.flush();
    expect(h2.queue()).toHaveLength(1);
  });

  it("drops a batch PostHog rejects as malformed instead of blocking the queue", async () => {
    const h = harness({ fetch: (async () => new Response("", { status: 400 })) as unknown as typeof fetch });
    await h.client.track("active", {});
    await h.client.flush();
    expect(h.queue()).toHaveLength(0);
  });

  it("sends in batches and caps the stored queue", async () => {
    const failing = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    const h = harness({ fetch: failing });
    for (let i = 0; i < MAX_QUEUE + 5; i++) await h.client.track("opened", { where: "popup" });
    expect(h.queue()).toHaveLength(MAX_QUEUE);

    const ok = harness();
    for (let i = 0; i < BATCH_SIZE + 3; i++) await ok.client.track("opened", { where: "popup" });
    await ok.client.flush();
    expect(ok.bodies.map((b) => b.batch.length)).toEqual([BATCH_SIZE, 3]);
  });

  it("trackDaily fires once per local day", async () => {
    const h = harness();
    await h.client.trackDaily("active", "active", {});
    await h.client.trackDaily("active", "active", {});
    await h.client.trackDaily("blocked:youtube", "blocking_worked", { service: "youtube" });
    expect(h.queue().map((e) => e.event)).toEqual(["active", "blocking_worked"]);
    h.advanceDays(1);
    await h.client.trackDaily("active", "active", {});
    expect(h.queue().map((e) => e.event)).toEqual(["active", "blocking_worked", "active"]);
  });

  it("identify merges the anonymous anchor into the account once, and later events use the account", async () => {
    const h = harness();
    await h.client.track("installed", { returning: false });
    await h.client.identify("user-1");
    await h.client.identify("user-1");
    await h.client.track("signed_in", {});
    const events = h.queue();
    expect(events.map((e) => e.event)).toEqual(["installed", "$identify", "signed_in"]);
    expect(events[1]!.properties).toMatchObject({
      distinct_id: "user-1",
      $anon_distinct_id: IDENTITY.anchorId,
      $set: { signed_in: true },
    });
    expect(events[2]!.properties).toMatchObject({ distinct_id: "user-1", signed_in: true });
  });

  it("an identify while analytics is off is sent once it is turned on", async () => {
    const h = harness();
    h.setConsent(false);
    await h.client.identify("user-1");
    expect(h.queue()).toHaveLength(0);
    h.setConsent(true);
    await h.client.track("active", {});
    expect(h.queue().map((e) => e.event)).toEqual(["$identify", "active"]);
  });

  it("sign-out then a different account identifies the new account", async () => {
    const h = harness();
    await h.client.identify("user-1");
    await h.client.track("signed_out", {});
    await h.client.reset();
    await h.client.track("active", {});
    await h.client.identify("user-2");
    const events = h.queue();
    expect(events.map((e) => [e.event, e.properties.distinct_id])).toEqual([
      ["$identify", "user-1"],
      ["signed_out", "user-1"],
      ["active", IDENTITY.anchorId],
      ["$identify", "user-2"],
    ]);
    expect(events[1]!.properties.$set).toMatchObject({ signed_in: false });
  });

  it("never throws when storage fails", async () => {
    const broken: AnalyticsKeyValue = {
      get: async () => { throw new Error("quota"); },
      set: async () => { throw new Error("quota"); },
    };
    const h = harness({ store: broken });
    await expect(h.client.track("active", {})).resolves.toBeUndefined();
    await expect(h.client.flush()).resolves.toBeUndefined();
  });
});
