import { describe, it, expect, vi } from "vitest";
import { AnalyticsClient, QUEUE_KEY, type AnalyticsClientDeps } from "../client.js";
import { createAccountIdentifier, createExtensionAnalyticsHost, ANALYTICS_MESSAGE_KIND, START_HOLD_LIMIT_MS } from "../extension-host.js";
import type { AnalyticsKeyValue } from "../identity.js";

// Reproductions of the races found in the follow-up review of 797fa00. Each asserts the fixed
// behaviour: nothing restores a departed account, nothing reaches the server after sharing is off,
// an unconfirmed account's events never leave, and a stuck network never holds the switch.

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDENTITY = {
  installId: "11111111-1111-4111-8111-111111111111",
  anchorId: "22222222-2222-4222-8222-222222222222",
  created: false,
  returning: false,
};
const PAGE = { id: "ext", url: "chrome-extension://ext/popup.html" };

function memory(): AnalyticsKeyValue & { data: Record<string, unknown>; delay?: number } {
  const store: AnalyticsKeyValue & { data: Record<string, unknown>; delay?: number } = {
    data: {},
    get: async (k) => {
      if (store.delay) await new Promise((r) => setTimeout(r, store.delay));
      return structuredClone(store.data[k]);
    },
    set: async (k, v) => void (store.data[k] = structuredClone(v)),
  };
  return store;
}

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function client(over: Partial<AnalyticsClientDeps> & { consent?: () => Promise<boolean> } = {}) {
  const store = memory();
  const c = new AnalyticsClient({
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    surface: "chrome",
    appVersion: "2.1.0",
    store,
    identity: async () => IDENTITY,
    consent: async () => true,
    fetch: (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch,
    now: Date.now,
    uuid,
    schedule: () => {},
    ...over,
  });
  return { c, store };
}

describe("server email attach races", () => {
  it("a sign-out during the attach never restores the account and never calls the server", async () => {
    const { c, store } = client();
    await c.identify(U1);
    const identifyOnServer = vi.fn(async () => {});
    const accounts = createAccountIdentifier({ client: c, local: store, consent: async () => true, identifyOnServer });
    store.delay = 20; // the marker read is slow
    const attaching = accounts.attach();
    await new Promise((r) => setTimeout(r, 5));
    store.delay = 0;
    await c.reset(); // signed out meanwhile
    await attaching;
    expect(identifyOnServer).not.toHaveBeenCalled();
    expect(await c.signedInAs()).toBeNull();
  });

  it("sharing switched off during the attach stops the request", async () => {
    let consent = true;
    const { c, store } = client({ consent: async () => consent });
    await c.identify(U1);
    const identifyOnServer = vi.fn(async () => {});
    const accounts = createAccountIdentifier({ client: c, local: store, consent: async () => consent, identifyOnServer });
    store.delay = 20;
    const attaching = accounts.attach();
    await new Promise((r) => setTimeout(r, 5));
    consent = false;
    await attaching;
    expect(identifyOnServer).not.toHaveBeenCalled();
  });

  it("two screens at once make one server request", async () => {
    const { c, store } = client();
    await c.identify(U1);
    let calls = 0;
    const identifyOnServer = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
    };
    const accounts = createAccountIdentifier({ client: c, local: store, consent: async () => true, identifyOnServer });
    await Promise.all([accounts.attach(), accounts.attach(), accounts.attach()]);
    expect(calls).toBe(1);
  });
});

describe("unconfirmed accounts", () => {
  it("while the account is unconfirmed only anonymous events leave; account events wait", async () => {
    const bodies: string[] = [];
    const fetch = (async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response("{}"))) as unknown as typeof globalThis.fetch;
    const { c } = client({ fetch });
    await c.track("opened", { where: "popup" }); // anonymous
    await c.identify(U1);
    await c.track("opened", { where: "popup" }); // under the account
    c.setAccountVerified(false);
    await c.flush();
    expect(bodies.join("")).not.toContain(U1);
    expect(await c.queuedCount()).toBe(2); // $identify and the account event wait
    c.setAccountVerified(true);
    await c.flush();
    expect(bodies.join("")).toContain(U1);
  });

  it("the opt-out attempt is skipped under an unconfirmed account", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const { c } = client({ fetch: fetch as unknown as typeof globalThis.fetch });
    await c.identify(U1);
    c.setAccountVerified(false);
    await c.sendOptOut();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a background start that never reports is 'unknown', not a successful check", async () => {
    vi.useFakeTimers();
    try {
      const bodies: string[] = [];
      const local = memory();
      const host = createExtensionAnalyticsHost({
        surface: "chrome", config: { key: "phc_test", host: "https://us.i.posthog.com" }, appVersion: "2.1.0",
        local, identity: async () => IDENTITY, consent: async () => true, noticeApplies: false,
        isTrustedPage: () => true, uuid,
        fetch: (async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response("{}"))) as unknown as typeof fetch,
      });
      await host.client.identify(U1); // left from an earlier session
      await host.client.track("opened", { where: "popup" });
      // onStart never called (the account lookup hung past every limit)
      await vi.advanceTimersByTimeAsync(START_HOLD_LIMIT_MS + 10);
      await host.flushWhenReady();
      expect(bodies.join("")).not.toContain(U1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a stuck network never holds the off switch", () => {
  it("turning sharing off completes and empties the queue while a send hangs", async () => {
    let consent = true;
    const hang = vi.fn(() => new Promise<Response>(() => {})); // never answers, ignores abort
    const local = memory();
    const host = createExtensionAnalyticsHost({
      surface: "chrome", config: { key: "phc_test", host: "https://us.i.posthog.com" }, appVersion: "2.1.0",
      local, identity: async () => IDENTITY, consent: async () => consent,
      storeConsent: async (e) => void (consent = e), noticeApplies: false, isTrustedPage: () => true, uuid,
      fetch: hang as unknown as typeof fetch,
    });
    host.onStart(null);
    await host.client.track("opened", { where: "popup" });
    void host.client.flush(); // now stuck on the network
    await new Promise((r) => setTimeout(r, 10));
    const send = (m: unknown) => new Promise<unknown>((r) => { if (!host.listener(m, PAGE, r)) r(undefined); });
    const result = await Promise.race([
      send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: false }),
      new Promise((r) => setTimeout(() => r("stalled"), 500)),
    ]);
    expect(result).toBe(false);
    expect((local.data[QUEUE_KEY] as unknown[] | undefined) ?? []).toEqual([]);
  });
});

describe("aliases", () => {
  it("a delivered alias is never re-sent after sharing is turned off and on", async () => {
    const events: string[] = [];
    let consent = true;
    const fetch = (async (_u: string, init: RequestInit) => {
      for (const e of JSON.parse(String(init.body)).batch) events.push(e.event);
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    const { c } = client({
      fetch, consent: async () => consent,
      identity: async () => ({ ...IDENTITY, aliasOf: "33333333-3333-4333-8333-333333333333" }),
    });
    await c.track("active", {});
    await c.flush(); // alias delivered
    consent = false;
    await c.clearQueue();
    consent = true;
    await c.track("active", {});
    await c.flush();
    expect(events.filter((e) => e === "$create_alias")).toHaveLength(1);
  });

  it("an alias discarded unsent is sent later", async () => {
    const events: string[] = [];
    let consent = true;
    const fetch = (async (_u: string, init: RequestInit) => {
      for (const e of JSON.parse(String(init.body)).batch) events.push(e.event);
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    const { c } = client({
      fetch, consent: async () => consent,
      identity: async () => ({ ...IDENTITY, aliasOf: "33333333-3333-4333-8333-333333333333" }),
    });
    await c.track("active", {}); // alias queued, not sent
    consent = false;
    await c.clearQueue();
    consent = true;
    await c.track("active", {});
    await c.flush();
    expect(events.filter((e) => e === "$create_alias")).toHaveLength(1);
  });
});
