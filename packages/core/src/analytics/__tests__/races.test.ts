import { describe, it, expect, vi } from "vitest";
import { AnalyticsClient, QUEUE_KEY, STATE_KEY, type AnalyticsClientDeps } from "../client.js";
import {
  ANALYTICS_MESSAGE_KIND,
  SERVER_ATTACH_LIMIT_MS,
  SERVER_IDENTIFIED_KEY,
  START_HOLD_LIMIT_MS,
  createAccountIdentifier,
  createExtensionAnalyticsHost,
} from "../extension-host.js";
import type { AnalyticsKeyValue } from "../identity.js";

// Race reproductions. Each pauses the code at the exact boundary where the race happens (a storage
// read, a network request) with a gate the test releases, rather than relying on elapsed time, and
// asserts the fixed behaviour.

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IDENTITY = {
  installId: "11111111-1111-4111-8111-111111111111",
  anchorId: "22222222-2222-4222-8222-222222222222",
  created: false,
  returning: false,
};
const PAGE = { id: "ext", url: "chrome-extension://ext/popup.html" };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

/** Memory storage whose reads of one key can be paused. */
function pausable() {
  const data: Record<string, unknown> = {};
  let pause: { key: string; gate: ReturnType<typeof gate>; reached: () => void } | null = null;
  const store: AnalyticsKeyValue & { data: Record<string, unknown>; pauseNextRead(key: string): Promise<() => void> } = {
    data,
    async get(k) {
      if (pause && pause.key === k) {
        const p = pause;
        pause = null;
        p.reached();
        await p.gate.opened;
      }
      return structuredClone(data[k]);
    },
    async set(k, v) {
      data[k] = structuredClone(v);
    },
    pauseNextRead(key) {
      const g = gate();
      return new Promise((reached) => {
        pause = { key, gate: g, reached: () => reached(g.open) };
      });
    },
  };
  return store;
}

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function makeClient(over: Partial<AnalyticsClientDeps> = {}) {
  const store = pausable();
  const client = new AnalyticsClient({
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
  return { client, store };
}

function recordingFetch() {
  const bodies: { event: string; properties: Record<string, unknown> }[][] = [];
  const fetch = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)).batch);
    return new Response("{}");
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies, events: () => bodies.flat() };
}

describe("a queued batch never starts after sharing is off", () => {
  it("switching off while the flush is reading the queue sends nothing", async () => {
    let consent = true;
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch, consent: async () => consent });
    await client.track("opened", { where: "popup" });
    const release = store.pauseNextRead(QUEUE_KEY);
    const flushing = client.flush();
    const open = await release; // the flush is now inside its queue read
    consent = false;
    const clearing = client.clearQueue();
    open();
    await flushing;
    await clearing;
    expect(rec.events()).toEqual([]);
  });
});

describe("server email attach", () => {
  function setup(over: Partial<AnalyticsClientDeps> = {}) {
    const { client, store } = makeClient(over);
    const calls: string[] = [];
    let consent = true;
    let hang: Promise<void> | null = null;
    const accounts = createAccountIdentifier({
      client,
      local: store,
      consent: async () => consent,
      identifyOnServer: async () => {
        calls.push("attach");
        if (hang) await hang;
      },
    });
    return { client, store, accounts, calls, setConsent: (v: boolean) => void (consent = v), setHang: (p: Promise<void> | null) => void (hang = p) };
  }

  it("a sign-out while the attach reads its marker never restores the account or calls the server", async () => {
    const { client, store, accounts, calls } = setup();
    client.confirmAccount();
    await client.identify(U1);
    const reached = store.pauseNextRead(SERVER_IDENTIFIED_KEY);
    const attaching = accounts.attach();
    const open = await reached;
    await client.reset();
    open();
    await attaching;
    expect(calls).toEqual([]);
    expect(await client.signedInAs()).toBeNull();
  });

  it("sharing switched off while the attach reads its marker stops the request", async () => {
    const { client, store, accounts, calls, setConsent } = setup();
    client.confirmAccount();
    await client.identify(U1);
    const reached = store.pauseNextRead(SERVER_IDENTIFIED_KEY);
    const attaching = accounts.attach();
    const open = await reached;
    setConsent(false);
    open();
    await attaching;
    expect(calls).toEqual([]);
  });

  it("never runs for an unconfirmed account", async () => {
    const { client, accounts, calls } = setup({ startsUnconfirmed: true });
    await client.identify(U1); // stored from before, not confirmed
    await accounts.attach();
    expect(calls).toEqual([]);
  });

  it("concurrent screens for one account make one request", async () => {
    const { client, accounts, calls, setHang } = setup();
    client.confirmAccount();
    await client.identify(U1);
    const g = gate();
    setHang(g.opened);
    const all = Promise.all([accounts.attach(), accounts.attach(), accounts.attach()]);
    await new Promise((r) => setTimeout(r, 0));
    g.open();
    await all;
    expect(calls).toEqual(["attach"]);
  });

  it("a request still running for account A does not stand in for account B", async () => {
    const { client, accounts, calls, setHang } = setup();
    client.confirmAccount();
    await client.identify(U1);
    const g = gate();
    setHang(g.opened);
    const forA = accounts.attach();
    await new Promise((r) => setTimeout(r, 0));
    setHang(null);
    await client.reset();
    await client.identify(U2);
    await accounts.attach();
    expect(calls).toEqual(["attach", "attach"]);
    g.open();
    await forA;
  });

  it("a hung request is abandoned, so a later screen can try again", async () => {
    vi.useFakeTimers();
    try {
      const { client, accounts, calls, setHang } = setup();
      client.confirmAccount();
      await client.identify(U1);
      setHang(new Promise(() => {})); // never answers
      const first = accounts.attach();
      await vi.advanceTimersByTimeAsync(SERVER_ATTACH_LIMIT_MS + 10);
      await first;
      setHang(null);
      await accounts.attach();
      expect(calls).toEqual(["attach", "attach"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("unconfirmed accounts", () => {
  it("events recorded before confirmation carry no person and are attributed at send time", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch, startsUnconfirmed: true });
    store.data[STATE_KEY] = { userId: U1, identifiedAs: U1, daily: {}, anonId: null }; // stale account from before
    await client.track("opened", { where: "popup" });
    await client.flush(); // held: nothing attributed may leave yet
    expect(rec.events()).toEqual([]);
    expect(JSON.stringify(store.data[QUEUE_KEY])).not.toContain(U1);
    await client.reset(); // the start finds nobody signed in
    client.confirmAccount();
    await client.flush();
    const opened = rec.events().find((e) => e.event === "opened")!;
    expect(opened.properties.distinct_id).not.toBe(U1);
    expect(opened.properties.signed_in).toBe(false);
  });

  it("the opt-out attempt is skipped under an unconfirmed account", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const { client, store } = makeClient({ fetch: fetch as unknown as typeof globalThis.fetch, startsUnconfirmed: true });
    store.data[STATE_KEY] = { userId: U1, identifiedAs: U1, daily: {}, anonId: null };
    await client.sendOptOut();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an extension start that never reports never sends the stored account's events", async () => {
    vi.useFakeTimers();
    try {
      const rec = recordingFetch();
      const local = pausable();
      local.data[STATE_KEY] = { userId: U1, identifiedAs: U1, daily: {}, anonId: null };
      const host = createExtensionAnalyticsHost({
        surface: "chrome", config: { key: "phc_test", host: "https://us.i.posthog.com" }, appVersion: "2.1.0",
        local, identity: async () => IDENTITY, consent: async () => true, noticeApplies: false,
        isTrustedPage: () => true, uuid, fetch: rec.fetch,
      });
      await host.client.track("opened", { where: "popup" });
      await vi.advanceTimersByTimeAsync(START_HOLD_LIMIT_MS + 10);
      await host.flushWhenReady();
      expect(JSON.stringify(rec.events())).not.toContain(U1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a later confirmation is never overruled by the startup timeout", async () => {
    vi.useFakeTimers();
    try {
      const rec = recordingFetch();
      const host = createExtensionAnalyticsHost({
        surface: "chrome", config: { key: "phc_test", host: "https://us.i.posthog.com" }, appVersion: "2.1.0",
        local: pausable(), identity: async () => IDENTITY, consent: async () => true, noticeApplies: false,
        isTrustedPage: () => true, uuid, fetch: rec.fetch,
      });
      const send = (m: unknown) => new Promise<unknown>((r) => { if (!host.listener(m, PAGE, r)) r(undefined); });
      await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: U1 }); // a page confirms
      await vi.advanceTimersByTimeAsync(START_HOLD_LIMIT_MS + 10); // then the start limit passes
      await host.client.track("opened", { where: "popup" });
      await host.flushWhenReady();
      expect(JSON.stringify(rec.events())).toContain(U1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a stuck network never holds the off switch", () => {
  it("turning sharing off completes and empties the queue while a send hangs", async () => {
    let consent = true;
    const local = pausable();
    const host = createExtensionAnalyticsHost({
      surface: "chrome", config: { key: "phc_test", host: "https://us.i.posthog.com" }, appVersion: "2.1.0",
      local, identity: async () => IDENTITY, consent: async () => consent,
      storeConsent: async (e) => void (consent = e), noticeApplies: false, isTrustedPage: () => true, uuid,
      fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch, // never answers, ignores abort
    });
    host.onStart(null);
    await host.client.track("opened", { where: "popup" });
    void host.client.flush();
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
  const ALIAS = "33333333-3333-4333-8333-333333333333";

  it("a delivered alias is never re-sent after sharing is turned off and on", async () => {
    let consent = true;
    const rec = recordingFetch();
    const { client } = makeClient({ fetch: rec.fetch, consent: async () => consent, identity: async () => ({ ...IDENTITY, aliasOf: ALIAS }) });
    await client.track("active", {});
    await client.flush();
    consent = false;
    await client.clearQueue();
    consent = true;
    await client.track("active", {});
    await client.flush();
    expect(rec.events().filter((e) => e.event === "$create_alias")).toHaveLength(1);
  });

  it("an alias discarded unsent is sent later", async () => {
    let consent = true;
    const rec = recordingFetch();
    const { client } = makeClient({ fetch: rec.fetch, consent: async () => consent, identity: async () => ({ ...IDENTITY, aliasOf: ALIAS }) });
    await client.track("active", {});
    consent = false;
    await client.clearQueue();
    consent = true;
    await client.track("active", {});
    await client.flush();
    expect(rec.events().filter((e) => e.event === "$create_alias")).toHaveLength(1);
  });
});
