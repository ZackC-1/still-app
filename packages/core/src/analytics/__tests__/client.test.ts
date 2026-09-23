import { describe, it, expect, vi } from "vitest";
import { AnalyticsClient, BATCH_SIZE, MAX_QUEUE, QUEUE_KEY, analyticsConfigured, type AnalyticsClientDeps } from "../client.js";
import type { AnalyticsIdentity, AnalyticsKeyValue } from "../identity.js";

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
    queue: () => ((store.data[QUEUE_KEY] as unknown[] | undefined) ?? []) as { event: string; properties: Record<string, unknown> }[],
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

  it("sends nothing while analytics is off, and discards what was waiting when it turns off", async () => {
    const h = harness();
    await h.client.track("active", {});
    expect(h.queue()).toHaveLength(1);
    h.setConsent(false); // withdrawn outside Still, e.g. Firefox's add-on manager
    await h.client.track("signed_in", {});
    await h.client.flush();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.queue()).toHaveLength(0);
  });

  it("an unconfigured build does nothing at all", async () => {
    const h = harness({ config: { key: "" } });
    expect(h.client.enabled).toBe(false);
    await h.client.track("active", {});
    await h.client.identify(U1);
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
    await h.client.trackDaily("opened-today", "opened", { where: "popup" });
    expect(h.queue().map((e) => e.event)).toEqual(["active", "opened"]);
    h.advanceDays(1);
    await h.client.trackDaily("active", "active", {});
    expect(h.queue().map((e) => e.event)).toEqual(["active", "opened", "active"]);
  });

  it("identify merges the anonymous anchor into the account once, and later events use the account", async () => {
    const h = harness();
    await h.client.track("installed", { returning: false });
    await h.client.identify(U1);
    await h.client.identify(U1);
    await h.client.track("signed_in", {});
    const events = h.queue();
    expect(events.map((e) => e.event)).toEqual(["installed", "$identify", "signed_in"]);
    expect(events[1]!.properties).toMatchObject({
      distinct_id: U1,
      $anon_distinct_id: IDENTITY.anchorId,
      $set: { signed_in: true },
    });
    expect(events[2]!.properties).toMatchObject({ distinct_id: U1, signed_in: true });
  });

  it("an identify while analytics is off is sent once it is turned on", async () => {
    const h = harness();
    h.setConsent(false);
    await h.client.identify(U1);
    expect(h.queue()).toHaveLength(0);
    h.setConsent(true);
    await h.client.track("active", {});
    expect(h.queue().map((e) => e.event)).toEqual(["$identify", "active"]);
  });

  it("sign-out switches to a fresh anonymous id, and a different account identifies from it", async () => {
    const h = harness();
    await h.client.identify(U1);
    await h.client.track("signed_out", {});
    await h.client.reset();
    await h.client.track("active", {});
    await h.client.identify(U2);
    const events = h.queue();
    expect(events.map((e) => e.event)).toEqual(["$identify", "signed_out", "active", "$identify"]);
    expect(events[1]!.properties).toMatchObject({ distinct_id: U1, $set: { signed_in: false } });
    const fresh = events[2]!.properties.distinct_id;
    // The install anchor was merged into user-1; reusing it would keep attributing this device there.
    expect(fresh).not.toBe(IDENTITY.anchorId);
    expect(fresh).not.toBe(U1);
    expect(events[3]!.properties).toMatchObject({ distinct_id: U2, $anon_distinct_id: fresh });
  });

  it("a deleted account's waiting events are dropped so nothing recreates the person", async () => {
    const failing = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    const h = harness({ fetch: failing });
    await h.client.track("active", {});
    await h.client.identify(U1);
    await h.client.track("service_toggled", { service: "youtube", enabled: false });
    await h.client.reset({ forgetAccount: true });
    await h.client.track("account_deleted", {});
    const events = h.queue();
    expect(events.map((e) => e.event)).toEqual(["active", "account_deleted"]);
    expect(JSON.stringify(events)).not.toContain(U1);
  });

  it("stops instead of resending forever when the queue cannot be saved", async () => {
    const store = memory();
    let frozen = false;
    const queueStore: AnalyticsKeyValue = {
      get: (k) => store.get(k),
      set: async (k, v) => {
        if (frozen) throw new Error("quota");
        await store.set(k, v);
      },
    };
    const h = harness({ queueStore });
    await h.client.track("active", {});
    frozen = true;
    await h.client.flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the queue out of the main store when given a queue store", async () => {
    const queueStore = memory();
    const h = harness({ queueStore });
    await h.client.track("active", {});
    expect(h.store.data[QUEUE_KEY]).toBeUndefined();
    expect((queueStore.data[QUEUE_KEY] as unknown[]).length).toBe(1);
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

describe("AnalyticsClient.trackOnce", () => {
  it("fires once for the life of the install, across days", async () => {
    const h = harness();
    await h.client.trackOnce("setup", "setup_completed", {});
    h.advanceDays(3);
    await h.client.trackOnce("setup", "setup_completed", {});
    expect(h.queue().map((e) => e.event)).toEqual(["setup_completed"]);
  });

  it("does not use up the marker while analytics is off", async () => {
    const h = harness();
    h.setConsent(false);
    await h.client.trackOnce("setup", "setup_completed", {});
    h.setConsent(true);
    await h.client.trackOnce("setup", "setup_completed", {});
    expect(h.queue().map((e) => e.event)).toEqual(["setup_completed"]);
  });
});

describe("AnalyticsClient.reset onlyIfSignedIn", () => {
  it("keeps one anonymous id across starts while signed out", async () => {
    const h = harness();
    await h.client.track("active", {});
    await h.client.reset({ onlyIfSignedIn: true });
    await h.client.track("active", {});
    const ids = h.queue().map((e) => e.properties.distinct_id);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe("AnalyticsClient privacy failure modes", () => {
  it("a flush stops before its next request once sharing is switched off", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      if (calls === 1) await gate;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const h = harness({ fetch });
    for (let i = 0; i < BATCH_SIZE + 1; i++) await h.client.track("opened", { where: "popup" });
    const flushing = h.client.flush();
    await new Promise((r) => setTimeout(r, 0));
    h.setConsent(false);
    const cleared = h.client.clearQueue();
    release();
    await flushing;
    await cleared;
    expect(calls).toBe(1); // the 51st event never went out
    expect(h.queue()).toHaveLength(0);
  });

  it("unreadable consent reads as off", async () => {
    const { createStoredConsent } = await import("../consent.js");
    const consent = createStoredConsent({ get: async () => { throw new Error("io"); }, set: async () => {} }, true);
    expect(await consent.get()).toBe(false);
  });

  it("stops reporting if an identity reset cannot be saved", async () => {
    const store = memory();
    let broken = false;
    const failing: AnalyticsKeyValue = {
      get: (k) => store.get(k),
      set: async (k, v) => { if (broken && k === "still:analytics:state") throw new Error("io"); await store.set(k, v); },
    };
    const queueStore = memory();
    const h = harness({ store: failing, queueStore });
    await h.client.identify(U1);
    broken = true;
    await h.client.reset({ forgetAccount: true });
    await h.client.track("account_deleted", {});
    const events = (queueStore.data[QUEUE_KEY] as { properties: Record<string, unknown> }[]) ?? [];
    expect(JSON.stringify(events)).not.toContain(U1);
    expect(events.some((e) => (e as unknown as { event: string }).event === "account_deleted")).toBe(false);
  });

  it("only real ids and versions reach the payload", async () => {
    const h = harness();
    await h.client.identify("https://evil.example/?q=1");
    await h.client.track("active", {});
    expect(h.queue()[0]!.properties.distinct_id).toBe(IDENTITY.anchorId);

    const badVersion = harness({ appVersion: "https://x" });
    expect(badVersion.client.enabled).toBe(false);

    const badIds = harness({ identity: async () => ({ ...IDENTITY, installId: "https://x" }) });
    await badIds.client.track("active", {});
    expect(badIds.queue()).toHaveLength(0);
  });

  it("asks PostHog not to derive location from the connection", async () => {
    const h = harness();
    await h.client.identify(U1);
    await h.client.track("active", {});
    expect(h.queue().every((e) => e.properties.$geoip_disable === true)).toBe(true);
  });

  it("an $identify discarded with the queue is sent again later", async () => {
    const h = harness();
    await h.client.identify(U1);
    h.setConsent(false);
    await h.client.flush(); // discards the queued $identify
    h.setConsent(true);
    await h.client.track("active", {});
    expect(h.queue().map((e) => e.event)).toEqual(["$identify", "active"]);
  });

  it("merges an earlier anonymous id into a late-arriving anchor, once", async () => {
    const h = harness({ identity: async () => ({ ...IDENTITY, aliasOf: "33333333-3333-4333-8333-333333333333" }) });
    await h.client.track("active", {});
    await h.client.track("active", {});
    const aliases = h.queue().filter((e) => e.event === "$create_alias");
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.properties).toMatchObject({ distinct_id: IDENTITY.anchorId, alias: "33333333-3333-4333-8333-333333333333" });
  });
});
