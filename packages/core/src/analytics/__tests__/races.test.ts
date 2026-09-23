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
import { codeAuth, makeController } from "../../ui/__tests__/support/controller-fixtures.js";

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

/** The queue store's writes (or reads) can be refused, the way IndexedDB can refuse on its own
 * while the extension's local storage keeps working. */
function refusable(store: ReturnType<typeof pausable>) {
  let refuse: "none" | "writes" | "reads" = "none";
  const queueStore: AnalyticsKeyValue = {
    get: (k) => { if (refuse === "reads") throw new Error("IDB unavailable"); return store.get(k); },
    set: (k, v) => { if (refuse === "writes") throw new Error("IDB unavailable"); return store.set(k, v); },
  };
  return { queueStore, refuse: (what: typeof refuse) => void (refuse = what) };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

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
    await client.identify(U1); // confirms
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
    await client.identify(U1); // confirms
    const reached = store.pauseNextRead(SERVER_IDENTIFIED_KEY);
    const attaching = accounts.attach();
    const open = await reached;
    setConsent(false);
    open();
    await attaching;
    expect(calls).toEqual([]);
  });

  it("never runs for an unconfirmed account", async () => {
    const { store, accounts, calls } = setup({ startsUnconfirmed: true });
    store.data[STATE_KEY] = { userId: U1, identifiedAs: U1, daily: {}, anonId: null }; // stored from before
    await accounts.attach();
    expect(calls).toEqual([]);
  });

  it("concurrent screens for one account make one request", async () => {
    const { client, accounts, calls, setHang } = setup();
    await client.identify(U1); // confirms
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
    await client.identify(U1); // confirms
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
    await client.reset(); // the start finds nobody signed in: confirms
    await client.flush();
    const opened = rec.events().find((e) => e.event === "opened")!;
    expect(opened.properties.distinct_id).not.toBe(U1);
    expect(opened.properties.signed_in).toBe(false);
  });

  it("an unconfirmed restart holds events attributed in an earlier process", async () => {
    const store = pausable();
    await makeClient({ store }).client.identify(U1); // the earlier process attributed its $identify
    const rec = recordingFetch();
    const { client } = makeClient({ store, fetch: rec.fetch, startsUnconfirmed: true });
    await client.flush();
    expect(rec.events()).toEqual([]);
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

describe("the attribution rules (client.ts rules 1-4)", () => {
  it("an event keeps the person it was given across failed sends, and leaves with that account", async () => {
    const { client, store } = makeClient({ startsUnconfirmed: true }); // offline fetch
    await client.track("opened", { where: "popup" }); // no person yet
    await client.confirm(U1); // attributed to U1, in storage
    await client.flush(); // fails: offline
    const queued = () => (store.data[QUEUE_KEY] as { event: string; properties: Record<string, unknown> }[]) ?? [];
    expect(queued().find((e) => e.event === "opened")!.properties.distinct_id).toBe(U1);
    await client.confirm(null, { forget: true }); // U1 deleted
    expect(JSON.stringify(queued())).not.toContain(U1);
    await client.confirm(U2); // someone else signs in
    expect(queued().some((e) => e.event === "opened")).toBe(false); // never re-sent under U2
  });

  it("a flush can never see the confirmation before the confirmed account is installed", async () => {
    const OLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch, startsUnconfirmed: true });
    store.data[STATE_KEY] = { userId: OLD, identifiedAs: OLD, daily: {}, anonId: null };
    await client.track("opened", { where: "popup" });
    const reached = store.pauseNextRead(STATE_KEY); // pause inside the confirmation
    const confirming = client.confirm(U1);
    const open = await reached;
    const flushing = client.flush(); // tries to run meanwhile
    open();
    await confirming;
    await flushing;
    await client.flush();
    expect(JSON.stringify(rec.events())).not.toContain(OLD);
    expect(rec.events().find((e) => e.event === "opened")!.properties.distinct_id).toBe(U1);
  });

  it("a late confirmation resumes delivery of what was waiting", async () => {
    const scheduled: (() => void)[] = [];
    const rec = recordingFetch();
    const { client } = makeClient({ fetch: rec.fetch, startsUnconfirmed: true, schedule: (run) => void scheduled.push(run) });
    await client.track("opened", { where: "popup" });
    for (const run of scheduled.splice(0)) run(); // the timed flush runs, and sends nothing: unconfirmed
    await new Promise((r) => setTimeout(r, 10));
    expect(rec.events()).toEqual([]);
    await client.confirm(null); // confirmed, much later
    expect(scheduled.length).toBeGreaterThan(0);
    for (const run of scheduled) run();
    await new Promise((r) => setTimeout(r, 10));
    expect(rec.events().map((e) => e.event)).toContain("opened");
  });

  it("an opt-out during a deletion waits for it, and never names the deleted account", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch });
    await client.identify(U1);
    const reached = store.pauseNextRead(STATE_KEY); // pause inside the deletion's reset
    const deleting = client.reset({ forgetAccount: true });
    const open = await reached;
    const optingOut = client.sendOptOut(); // switched off at that moment
    await new Promise((r) => setTimeout(r, 10));
    open();
    await Promise.all([deleting, optingOut]);
    const optOut = rec.events().find((e) => e.event === "sharing_turned_off")!;
    expect(optOut.properties.distinct_id).not.toBe(U1);
    expect(JSON.stringify(rec.events())).not.toContain(U1);
  });

  it("a deletion abandons a send under the account that is still on its way", async () => {
    let started!: () => void;
    const reachedFetch = new Promise<void>((r) => (started = r));
    let aborted = false;
    const fetch = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => {
        started();
        init.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
      })) as unknown as typeof globalThis.fetch;
    const { client, store } = makeClient({ fetch });
    await client.identify(U1);
    await client.track("opened", { where: "popup" });
    void client.flush();
    await reachedFetch; // U1's events are on the network, and the network never answers
    await client.reset({ forgetAccount: true }); // resolves without waiting out the request
    expect(aborted).toBe(true);
    expect(JSON.stringify(store.data[QUEUE_KEY] ?? [])).not.toContain(U1);
  });

  it("nothing leaves before confirmation, however long it takes", async () => {
    const rec = recordingFetch();
    const { client } = makeClient({ fetch: rec.fetch, startsUnconfirmed: true });
    await client.track("opened", { where: "popup" });
    await client.flush();
    await client.sendOptOut();
    expect(rec.events()).toEqual([]);
  });
});

describe("forgetting an account (it was deleted)", () => {
  it("a flush asked for before the forget sends nothing at its turn, even once the deletion's deadline has passed", async () => {
    vi.useFakeTimers();
    try {
      const sent: { batch: unknown[]; serverDeleted: boolean }[] = [];
      let serverDeleted = false;
      let firstRequest!: () => void;
      const reachedFetch = new Promise<void>((r) => (firstRequest = r));
      const fetch = (async (_u: string, init: RequestInit) => {
        sent.push({ batch: JSON.parse(String(init.body)).batch, serverDeleted });
        firstRequest();
        return sent.length === 1 ? new Promise<Response>(() => {}) : new Response("{}"); // the first hangs
      }) as unknown as typeof globalThis.fetch;
      const { client, store } = makeClient({ fetch });
      await client.identify(U1);
      await client.track("opened", { where: "popup" });
      const first = client.flush();
      const second = client.flush(); // waiting its turn behind the first
      await reachedFetch;
      const reached = store.pauseNextRead(QUEUE_KEY); // the second's turn: it pauses inside its queue read
      const deleteAccount = vi.fn(async () => { serverDeleted = true; });
      const { c } = makeController({
        auth: codeAuth({ deleteAccount }),
        analytics: { track: () => {}, identify: () => {}, reset: (o) => client.reset(o) },
      });
      c.userId = U1;
      const deleting = c.confirmDeleteAccount(); // forgets: abandons the first, fences the second
      const open = await reached;
      await vi.advanceTimersByTimeAsync(5_001); // the controller stops waiting for analytics
      await deleting;
      expect(serverDeleted).toBe(true);
      open();
      await Promise.all([first, second]);
      expect(sent.length).toBe(1); // the second never sent under the deleted account
    } finally {
      vi.useRealTimers();
    }
  });

  it("a host's own confirm(null, forget) stops a running flush before its next batch", async () => {
    const batches: unknown[][] = [];
    let firstRequest!: () => void;
    const reachedFetch = new Promise<void>((r) => (firstRequest = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const fetch = (async (_u: string, init: RequestInit) => {
      batches.push(JSON.parse(String(init.body)).batch);
      if (batches.length === 1) { firstRequest(); await released; }
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    const { client, store } = makeClient({ fetch });
    await client.identify(U1);
    for (let i = 0; i < 60; i++) await client.track("opened", { where: "popup" }); // two batches
    const flushing = client.flush();
    await reachedFetch;
    const forgetting = client.confirm(null, { forget: true }); // as the extension and Apple hosts call it
    await settle();
    release();
    await Promise.all([flushing, forgetting]);
    expect(batches.length).toBe(1);
    expect(JSON.stringify(store.data[QUEUE_KEY])).not.toContain(U1);
  });

  it("a drop the queue store refuses is owed: nothing leaves until it is done, in this process or the next", async () => {
    const rec = recordingFetch();
    const store = pausable();
    const { queueStore, refuse } = refusable(store);
    const { client } = makeClient({ store, queueStore, fetch: rec.fetch });
    await client.identify(U1);
    await client.track("opened", { where: "popup" });
    refuse("writes");
    await client.reset({ forgetAccount: true });
    expect(await client.signedInAs()).toBeNull(); // the account is let go regardless
    await client.flush();
    expect(rec.events()).toEqual([]); // the account's events are still there: nothing leaves
    refuse("none");
    await client.track("opened", { where: "popup" }); // an anonymous event, queued behind the owed drop
    await client.flush(); // the store recovered: the drop is done, then the rest goes
    expect(JSON.stringify(rec.events())).not.toContain(U1);
    expect(rec.events().map((e) => e.event)).toEqual(["opened"]);
  });

  it("the owed drop survives a restart, whoever confirms next", async () => {
    for (const next of [null, U2]) {
      const rec = recordingFetch();
      const store = pausable();
      const { queueStore, refuse } = refusable(store);
      const { client } = makeClient({ store, queueStore, fetch: rec.fetch });
      await client.identify(U1);
      await client.track("opened", { where: "popup" });
      refuse("writes");
      await client.reset({ forgetAccount: true });
      refuse("none");
      const restarted = makeClient({ store, queueStore, fetch: rec.fetch, startsUnconfirmed: true }).client;
      await restarted.confirm(next, { forget: next === null });
      await restarted.flush();
      expect(JSON.stringify(rec.events())).not.toContain(U1);
      if (next) expect(rec.events().some((e) => e.properties.distinct_id === U2)).toBe(true); // theirs go
    }
  });

  it("a queue store that refuses to be read is never taken as empty", async () => {
    const rec = recordingFetch();
    const store = pausable();
    const { queueStore, refuse } = refusable(store);
    const { client } = makeClient({ store, queueStore, fetch: rec.fetch });
    await client.identify(U1);
    await client.track("opened", { where: "popup" });
    refuse("reads");
    await client.reset({ forgetAccount: true });
    refuse("none");
    await client.flush();
    expect(JSON.stringify(rec.events())).not.toContain(U1);
  });

  it("an opt-out asked for before the forget never names the account", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch });
    await client.identify(U1);
    const reached = store.pauseNextRead(QUEUE_KEY); // inside the opt-out, before its request
    const optingOut = client.sendOptOut();
    const open = await reached;
    const forgetting = client.confirm(null, { forget: true });
    open();
    await Promise.all([optingOut, forgetting]);
    expect(JSON.stringify(rec.events())).not.toContain(U1);
  });
});
