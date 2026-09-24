import { describe, it, expect, vi } from "vitest";
import { AnalyticsClient, QUEUE_KEY, STATE_KEY, type AnalyticsClientDeps } from "../client.js";
import {
  ANALYTICS_MESSAGE_KIND,
  PENDING_INSTALL_KEY,
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

/** Memory storage whose reads of one key can be paused, or made to fail once. */
function pausable() {
  const data: Record<string, unknown> = {};
  let pause: { key: string; gate: ReturnType<typeof gate>; reached: () => void } | null = null;
  let failing: { key: string; skip: number } | null = null;
  const store: AnalyticsKeyValue & {
    data: Record<string, unknown>;
    pauseNextRead(key: string): Promise<() => void>;
    /** Make a later read of `key` fail once: the next one, or the one after `skip` more. Decided
     * when a read begins, so arming this while a read is paused targets the reads after it. */
    failNextRead(key: string, skip?: number): void;
  } = {
    data,
    async get(k) {
      let fail = false;
      if (failing && failing.key === k) {
        if (failing.skip > 0) failing.skip -= 1;
        else { fail = true; failing = null; }
      }
      if (pause && pause.key === k) {
        const p = pause;
        pause = null;
        p.reached();
        await p.gate.opened;
      }
      if (fail) throw new Error("unreadable once");
      return structuredClone(data[k]);
    },
    failNextRead(key, skip = 0) {
      failing = { key, skip };
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

/** A store whose writes or reads can be refused, or whose writes can be "accepted" without being
 * kept: IndexedDB and the extension's local storage each fail on their own, so either one can. */
function refusable(backing: ReturnType<typeof pausable>) {
  let refuse: "none" | "writes" | "reads" | "silently" = "none";
  const store: AnalyticsKeyValue = {
    get: (k) => { if (refuse === "reads") throw new Error("unavailable"); return backing.get(k); },
    set: async (k, v) => {
      if (refuse === "writes") throw new Error("unavailable");
      if (refuse === "silently") return; // acknowledged, not kept
      await backing.set(k, v);
    },
  };
  return { store, refuse: (what: typeof refuse) => void (refuse = what) };
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
    const { store: queueStore, refuse } = refusable(store);
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
      const { store: queueStore, refuse } = refusable(store);
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
    const { store: queueStore, refuse } = refusable(store);
    const { client } = makeClient({ store, queueStore, fetch: rec.fetch });
    await client.identify(U1);
    await client.track("opened", { where: "popup" });
    refuse("reads");
    await client.reset({ forgetAccount: true });
    refuse("none");
    await client.flush();
    expect(JSON.stringify(rec.events())).not.toContain(U1);
  });

  it("a queue store that acknowledges the drop without keeping it still owes it", async () => {
    const rec = recordingFetch();
    const store = pausable();
    const { store: queueStore, refuse } = refusable(store);
    const { client } = makeClient({ store, queueStore, fetch: rec.fetch });
    await client.identify(U1);
    await client.track("opened", { where: "popup" });
    refuse("silently");
    await client.reset({ forgetAccount: true }); // the drop "succeeds", and changes nothing
    await client.flush();
    expect(rec.events()).toEqual([]);
    expect((store.data[STATE_KEY] as { forgotten: string[] }).forgotten).toEqual([U1]); // still owed
    refuse("none");
    await client.flush();
    expect(JSON.stringify(rec.events())).not.toContain(U1);
    expect((store.data[STATE_KEY] as { forgotten: string[] }).forgotten).toEqual([]);
  });

  it("a state store that cannot be read is never taken as empty, and never overwritten", async () => {
    const rec = recordingFetch();
    const backing = pausable();
    const state = refusable(backing);
    const queue = refusable(pausable());
    const { client } = makeClient({ store: state.store, queueStore: queue.store, fetch: rec.fetch });
    await client.identify(U1);
    await client.track("opened", { where: "popup" });
    queue.refuse("writes");
    await client.reset({ forgetAccount: true }); // owed: U1 is recorded as forgotten
    queue.refuse("none");
    state.refuse("reads");
    await client.flush(); // "unreadable" is not "nothing owed"
    expect(rec.events()).toEqual([]);
    await client.trackDaily("active", "active", {}); // writers must not build on an empty state either
    await client.track("opened", { where: "popup" });
    await client.confirm(U2);
    expect((backing.data[STATE_KEY] as { forgotten: string[]; userId: string | null }).forgotten).toEqual([U1]);
    expect((backing.data[STATE_KEY] as { userId: string | null }).userId).toBeNull();
    state.refuse("none");
    await client.confirm(U2); // readable again: the drop is done, then U2's own events go
    await client.track("opened", { where: "popup" });
    await client.flush();
    expect(JSON.stringify(rec.events())).not.toContain(U1);
    expect(rec.events().some((e) => e.properties.distinct_id === U2)).toBe(true);
  });

  it("a forget that cannot be recorded sends nothing, and is completed before the next send", async () => {
    const rec = recordingFetch();
    const backing = pausable();
    const state = refusable(backing);
    const { client } = makeClient({ store: state.store, fetch: rec.fetch });
    await client.identify(U1);
    await client.track("opened", { where: "popup" });
    state.refuse("reads");
    await client.reset({ forgetAccount: true }); // cannot even tell who to forget
    expect(client.accountConfirmed).toBe(false);
    await client.flush(); // nothing while it cannot be completed
    expect(rec.events()).toEqual([]);
    state.refuse("none");
    await client.flush(); // completed here: U1 recorded as forgotten, its events dropped
    expect(rec.events()).toEqual([]);
    expect((backing.data[STATE_KEY] as { userId: string | null }).userId).toBeNull();
    expect(JSON.stringify(backing.data[QUEUE_KEY] ?? [])).not.toContain(U1);
    await client.track("opened", { where: "popup" }); // anonymous from here on
    await client.flush();
    expect(rec.events().map((e) => e.properties.signed_in)).toEqual([false]);
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

  it("an opt-out overtaken by a forget during its own reads names nobody", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch });
    await client.identify(U1);
    const first = store.pauseNextRead(STATE_KEY); // the queue discard's read, before the epoch check
    const optingOut = client.sendOptOut();
    const openFirst = await first;
    const second = store.pauseNextRead(STATE_KEY); // the opt-out's own read, after the epoch check
    openFirst();
    const open = await second;
    const forgetting = client.confirm(null, { forget: true }); // the account is deleted meanwhile
    open();
    await Promise.all([optingOut, forgetting]);
    expect(rec.events()).toEqual([]);
  });

  it("a forget during a flush's queue read stops it before its request", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch });
    await client.identify(U1);
    await client.track("opened", { where: "popup" });
    const reached = store.pauseNextRead(QUEUE_KEY); // the flush passed its first check; now reading
    const flushing = client.flush();
    const open = await reached;
    const forgetting = client.confirm(null, { forget: true });
    open();
    await Promise.all([flushing, forgetting]);
    expect(rec.events()).toEqual([]);
  });
});

describe("recovering from a storage failure", () => {
  const opened = (rec: ReturnType<typeof recordingFetch>) =>
    rec.events().filter((e) => e.event === "opened").map((e) => e.properties.distinct_id);

  it("a confirmation that cannot be installed withdraws the previous one, and is tried again before the next send", async () => {
    const rec = recordingFetch();
    const backing = pausable();
    const state = refusable(backing);
    const { client } = makeClient({ store: state.store, fetch: rec.fetch });
    await client.confirm(U1);
    await client.track("opened", { where: "popup" });
    await client.flush();
    state.refuse("reads");
    await client.confirm(U2); // the person is now U2, but that could not be recorded
    expect(client.accountConfirmed).toBe(false);
    await client.flush();
    expect(opened(rec)).toEqual([U1]); // nothing more goes out while it stands withdrawn
    state.refuse("none");
    await client.track("opened", { where: "popup" }); // U2's use, before any confirmation: held
    const held = (backing.data[QUEUE_KEY] as { properties: Record<string, unknown> }[]).at(-1)!;
    expect(held.properties.distinct_id).toBeUndefined(); // no person, and never U1
    await client.flush(); // the store recovered: the ask is installed here, without the host's help
    expect(client.accountConfirmed).toBe(true);
    expect(opened(rec)).toEqual([U1, U2]);
  });

  it("the host's latest ask wins over one that failed", async () => {
    const state = refusable(pausable());
    const { client } = makeClient({ store: state.store });
    await client.confirm(U1);
    state.refuse("reads");
    await client.confirm(U2); // failed
    state.refuse("none");
    await client.confirm(null); // then the person signed out
    await client.flush();
    expect(await client.signedInAs()).toBeNull(); // U2 is never installed behind the sign-out
    expect(client.accountConfirmed).toBe(true);
  });

  it("the server attach never runs, or marks, for an account the client could not install", async () => {
    const backing = pausable();
    const state = refusable(backing);
    const { client } = makeClient({ store: state.store });
    const served: string[] = [];
    let authenticatedAs = U1;
    const accounts = createAccountIdentifier({
      client, local: state.store, consent: async () => true,
      identifyOnServer: async () => void served.push(authenticatedAs),
    });
    await accounts.identify(U1);
    expect(served).toEqual([U1]);
    authenticatedAs = U2;
    state.refuse("reads");
    await accounts.identify(U2); // the client still holds U1; the session is U2's
    expect(served).toEqual([U1]); // no request under a mismatch
    expect(backing.data[SERVER_IDENTIFIED_KEY]).toBe(U1); // U1's marker is not rewritten for U2's request
    state.refuse("none");
    await accounts.identify(U2);
    expect(served).toEqual([U1, U2]);
    expect(backing.data[SERVER_IDENTIFIED_KEY]).toBe(U2);
  });

  it("a once-marker is written only once its event is queued, so a lost install is tried again", async () => {
    const { client, store } = makeClient({ startsUnconfirmed: true });
    const reached = store.pauseNextRead(STATE_KEY); // the marker check passes...
    const tracking = client.trackOnce("installed", "installed", { returning: false });
    const open = await reached;
    store.failNextRead(STATE_KEY); // ...then the read that would record the event fails
    open();
    await tracking;
    expect(await client.hasTrackedOnce("installed")).toBe(false); // the marker still stands open
    expect((store.data[QUEUE_KEY] as unknown[] | undefined) ?? []).toEqual([]);
    await client.trackOnce("installed", "installed", { returning: false }); // the host tries again
    expect(await client.hasTrackedOnce("installed")).toBe(true);
    expect((store.data[QUEUE_KEY] as { event: string }[]).map((e) => e.event)).toEqual(["installed"]);
  });

  it("an extension keeps its pending install until the install is really queued", async () => {
    vi.useFakeTimers();
    try {
      const rec = recordingFetch();
      const local = pausable();
      const host = createExtensionAnalyticsHost({
        surface: "chrome", config: { key: "phc_test", host: "https://us.i.posthog.com" }, appVersion: "2.1.0",
        local, identity: async () => IDENTITY, consent: async () => true, storeConsent: async () => {},
        noticeApplies: false, isTrustedPage: () => true, uuid, fetch: rec.fetch,
      });
      local.data[PENDING_INSTALL_KEY] = { returning: false, at: Date.now() };
      const send = (m: unknown) => new Promise<unknown>((r) => { if (!host.listener(m, PAGE, r)) r(undefined); });
      const reached = local.pauseNextRead(STATE_KEY);
      const sharing = send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: true }); // counts the install
      const open = await reached;
      local.failNextRead(STATE_KEY); // the install's event is lost at its second read
      open();
      await sharing;
      expect(local.data[PENDING_INSTALL_KEY]).not.toBeNull(); // the evidence stays
      host.onStart(null); // the next start counts it
      await vi.advanceTimersByTimeAsync(10);
      await host.flushWhenReady();
      expect(rec.events().filter((e) => e.event === "installed")).toHaveLength(1);
      expect(local.data[PENDING_INSTALL_KEY]).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the $identify is marked only once it is queued", async () => {
    const backing = pausable();
    const queue = refusable(pausable());
    const { client } = makeClient({ store: backing, queueStore: queue.store });
    queue.refuse("writes");
    await client.identify(U1); // the $identify could not be queued
    expect((backing.data[STATE_KEY] as { identifiedAs: string | null }).identifiedAs).toBeNull();
    queue.refuse("none");
    await client.track("opened", { where: "popup" }); // the next event queues it first
    expect((backing.data[STATE_KEY] as { identifiedAs: string | null }).identifiedAs).toBe(U1);
    expect(((await queue.store.get(QUEUE_KEY)) as { event: string }[]).map((e) => e.event)).toEqual(["$identify", "opened"]);
  });

  it("a marker whose final read fails is left open rather than written over an unread state", async () => {
    const backing = pausable();
    const queue = refusable(pausable());
    const { client } = makeClient({ store: backing, queueStore: queue.store });
    await client.identify(U1);
    queue.refuse("writes");
    await client.reset({ forgetAccount: true }); // U1 forgotten, its drop owed
    queue.refuse("none");
    const reached = backing.pauseNextRead(STATE_KEY); // the marker check
    const tracking = client.trackDaily("active", "active", {});
    const open = await reached;
    backing.failNextRead(STATE_KEY, 2); // past the two reads that queue the event, the re-read fails
    open();
    await tracking;
    const state = backing.data[STATE_KEY] as { userId: string | null; forgotten: string[]; daily: Record<string, string> };
    expect(state.forgotten).toEqual([U1]); // the owed drop survives
    expect(state.userId).toBeNull();
    expect(state.daily.active).toBeUndefined(); // open, so the day may be counted again, never lost
  });

  it("writing a once-marker keeps what queueing its event marked", async () => {
    const backing = pausable();
    const queue = refusable(pausable());
    const { client } = makeClient({ store: backing, queueStore: queue.store });
    queue.refuse("writes");
    await client.identify(U1); // $identify not queued, so not marked
    queue.refuse("none");
    await client.trackOnce("installed", "installed", { returning: false }); // queues $identify, marks it, then marks itself
    const state = backing.data[STATE_KEY] as { identifiedAs: string | null; daily: Record<string, string> };
    expect(state.identifiedAs).toBe(U1);
    expect(state.daily["once:installed"]).toBe("done");
  });
});

describe("completing recovery before reporting", () => {
  it("a later sign-in cannot replace a forget that failed to read the previous account", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch });
    await client.confirm(U1);
    await client.track("opened", { where: "popup" });
    store.failNextRead(STATE_KEY);
    const reached = store.pauseNextRead(STATE_KEY);
    const forgetting = client.confirm(null, { forget: true });
    const release = await reached;
    const identifying = client.confirm(U2);
    release();
    await Promise.all([forgetting, identifying]);
    await client.track("opened", { where: "popup" });
    await client.flush();
    expect(rec.events().some((e) => e.properties.distinct_id === U1)).toBe(false);
    expect(rec.events().filter((e) => e.event === "opened").map((e) => e.properties.distinct_id)).toEqual([U2]);
  });

  it("a cancelled flush cannot install a future account ahead of the forget", async () => {
    const rec = recordingFetch();
    const { client: previous, store } = makeClient();
    await previous.confirm(U1);
    await previous.track("opened", { where: "popup" });
    const { client } = makeClient({ store, fetch: rec.fetch, startsUnconfirmed: true });
    const reached = store.pauseNextRead(STATE_KEY);
    const reading = client.signedInAs();
    const release = await reached;
    const flushing = client.flush();
    const forgetting = client.confirm(null, { forget: true });
    const identifying = client.confirm(U2);
    release();
    await Promise.all([reading, flushing, forgetting, identifying]);
    await client.flush();
    expect(rec.events().some((e) => e.properties.distinct_id === U1)).toBe(false);
    expect(await client.signedInAs()).toBe(U2);
  });

  it.each([false, true])("failed attribution stays retryable (retrying confirmation: %s)", async (retrying) => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch, startsUnconfirmed: true });
    if (retrying) {
      store.failNextRead(STATE_KEY);
      await client.confirm(U2);
    }
    await client.trackOnce("installed", "installed", { returning: false });
    const reached = store.pauseNextRead(QUEUE_KEY); // attribution reads the waiting queue
    const confirming = retrying ? client.flush() : client.confirm(U2);
    const release = await reached;
    store.failNextRead(STATE_KEY); // the account read inside attribution
    release();
    await confirming;
    expect(client.accountConfirmed).toBe(false);
    expect(rec.events()).toEqual([]);
    await client.flush();
    expect(client.accountConfirmed).toBe(true);
    expect(rec.events().filter((e) => e.event === "installed").map((e) => e.properties.distinct_id)).toEqual([U2]);
    expect(store.data[QUEUE_KEY]).toEqual([]);
  });

  it("an attribution write acknowledged without being kept does not complete confirmation", async () => {
    const rec = recordingFetch();
    const backing = pausable();
    const queue = refusable(backing);
    const { client } = makeClient({ queueStore: queue.store, fetch: rec.fetch, startsUnconfirmed: true });
    await client.trackOnce("installed", "installed", { returning: false });
    queue.refuse("silently");
    await client.confirm(U2);
    expect(client.accountConfirmed).toBe(false);
    queue.refuse("none");
    await client.flush();
    expect(rec.events().filter((e) => e.event === "installed")).toHaveLength(1);
    expect(backing.data[QUEUE_KEY]).toEqual([]);
  });

  it("a failed queue read cannot overwrite an already recorded install", async () => {
    const { client, store } = makeClient({ startsUnconfirmed: true });
    await client.trackOnce("installed", "installed", { returning: false });
    store.failNextRead(QUEUE_KEY);
    await client.track("opened", { where: "popup" });
    expect((store.data[QUEUE_KEY] as { event: string }[]).map((e) => e.event)).toEqual(["installed"]);
    expect(await client.hasTrackedOnce("installed")).toBe(true);
  });

  it("one unreadable marker check never repeats a recorded active day", async () => {
    const { client, store } = makeClient({ startsUnconfirmed: true });
    await client.trackDaily("active", "active", {});
    const reached = store.pauseNextRead(STATE_KEY);
    store.failNextRead(STATE_KEY);
    const tracking = client.trackDaily("active", "active", {});
    const release = await reached;
    release();
    await tracking;
    expect((store.data[QUEUE_KEY] as { event: string }[]).map((e) => e.event)).toEqual(["active"]);
  });

  it.each(["consent", "request"] as const)("withdrawn confirmation invalidates an attach paused at %s", async (boundary) => {
    const { client, store } = makeClient();
    await client.confirm(U1);
    const reached = gate();
    const release = gate();
    const served: string[] = [];
    let authenticatedAs = U1;
    let reads = 0;
    const accounts = createAccountIdentifier({
      client, local: store,
      consent: async () => {
        if (++reads === 2 && boundary === "consent") { reached.open(); await release.opened; }
        return true;
      },
      identifyOnServer: async () => {
        served.push(authenticatedAs);
        if (boundary === "request") { reached.open(); await release.opened; }
      },
    });
    const attaching = accounts.attach();
    await reached.opened;
    authenticatedAs = U2;
    store.failNextRead(STATE_KEY);
    await client.confirm(U2);
    expect(client.accountConfirmed).toBe(false);
    release.open();
    await attaching;
    expect(served).toEqual(boundary === "request" ? [U1] : []);
    expect(store.data[SERVER_IDENTIFIED_KEY]).toBeUndefined();
    await client.flush();
    await accounts.attach();
    expect(served.at(-1)).toBe(U2);
    expect(store.data[SERVER_IDENTIFIED_KEY]).toBe(U2);
  });

  it.each(["chrome", "firefox"] as const)("%s retains pending evidence until both install milestones are queued", async (surface) => {
    vi.useFakeTimers();
    try {
      const rec = recordingFetch();
      const local = pausable();
      let failSetup = true;
      const queue: AnalyticsKeyValue = {
        get: (key) => local.get(key),
        async set(key, value) {
          if (failSetup && (value as { event: string }[]).some((e) => e.event === "setup_completed")) {
            failSetup = false;
            throw new Error("setup queue write refused once");
          }
          await local.set(key, value);
        },
      };
      const deps = {
        surface, config: { key: "phc_test", host: "https://us.i.posthog.com" }, appVersion: "2.1.0",
        local, queueStore: queue, identity: async () => IDENTITY, consent: async () => true,
        noticeApplies: false, isTrustedPage: () => true, uuid, fetch: rec.fetch,
      };
      const host = createExtensionAnalyticsHost(deps);
      local.data[PENDING_INSTALL_KEY] = { returning: false, at: Date.now() };
      const send = (m: unknown) => new Promise<unknown>((r) => { if (!host.listener(m, PAGE, r)) r(undefined); });
      await send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: true });
      expect(local.data[PENDING_INSTALL_KEY]).not.toBeNull();
      expect(await host.client.hasTrackedOnce("installed")).toBe(true);
      expect(await host.client.hasTrackedOnce("setup_completed")).toBe(false);
      const restarted = createExtensionAnalyticsHost(deps);
      restarted.onStart(null);
      await restarted.flushWhenReady();
      expect(rec.events().filter((e) => e.event === "installed")).toHaveLength(1);
      expect(rec.events().filter((e) => e.event === "setup_completed")).toHaveLength(1);
      expect(local.data[PENDING_INSTALL_KEY]).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recovery respects operation order", () => {
  it("a flush cannot run a quiet confirmation that has not reached its turn", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch, startsUnconfirmed: true });
    await client.track("active", {}, { quiet: true });
    const reached = store.pauseNextRead(STATE_KEY);
    const reading = client.signedInAs();
    const release = await reached;
    const flushing = client.flush();
    const confirming = client.confirm(U2, { quiet: true });
    release();
    await Promise.all([reading, flushing, confirming]);
    expect(rec.events()).toEqual([]);
    await client.flush();
    expect(rec.events().filter((e) => e.event === "active")).toHaveLength(1);
  });

  it("a failed read after sending keeps the remaining queue for retry", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: (async (...args: Parameters<typeof fetch>) => {
      const response = await rec.fetch(...args);
      store.failNextRead(QUEUE_KEY); // queue removal must not substitute an empty queue
      return response;
    }) as typeof fetch });
    for (let i = 0; i < 60; i++) await client.track("opened", { where: "popup" });
    const before = structuredClone(store.data[QUEUE_KEY]);
    await client.flush();
    expect(rec.events()).toHaveLength(50);
    expect(store.data[QUEUE_KEY]).toEqual(before);
  });
});

describe("cancelled or unreadable recovery", () => {
  it("a cancelled flush cannot retry an earlier failed account change", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch });
    await client.confirm(U1);
    await client.track("opened", { where: "popup" });
    store.failNextRead(STATE_KEY);
    await client.confirm(U2);
    const reached = store.pauseNextRead(STATE_KEY);
    const reading = client.signedInAs();
    const release = await reached;
    const flushing = client.flush();
    const forgetting = client.confirm(null, { forget: true });
    release();
    await Promise.all([reading, flushing, forgetting]);
    await client.flush();
    expect(rec.events()).toEqual([]);
  });

  it("an unreadable attribution queue leaves confirmation pending", async () => {
    const rec = recordingFetch();
    const { client, store } = makeClient({ fetch: rec.fetch, startsUnconfirmed: true });
    await client.trackOnce("installed", "installed", { returning: false });
    store.failNextRead(QUEUE_KEY);
    await client.confirm(U2);
    expect(client.accountConfirmed).toBe(false);
    await client.flush();
    expect(rec.events().filter((e) => e.event === "installed")).toHaveLength(1);
  });
});

describe("the server attach and a repeated confirmation of the same account", () => {
  it("keeps its completion marker, so the server is not asked again", async () => {
    const { client, store } = makeClient();
    await client.confirm(U1);
    const entered = gate();
    const release = gate();
    const served: string[] = [];
    const accounts = createAccountIdentifier({
      client, local: store, consent: async () => true,
      identifyOnServer: async () => { served.push(U1); if (served.length === 1) { entered.open(); await release.opened; } },
    });
    const attaching = accounts.attach();
    await entered.opened;
    await client.confirm(U1); // a worker start or a session event re-establishes the same account meanwhile
    release.open();
    await attaching;
    expect(store.data[SERVER_IDENTIFIED_KEY]).toBe(U1);
    await accounts.attach();
    expect(served).toEqual([U1]);
  });

  it("still discards the marker when the account asked for is a different one", async () => {
    const { client, store } = makeClient();
    await client.confirm(U1);
    const entered = gate();
    const release = gate();
    const accounts = createAccountIdentifier({
      client, local: store, consent: async () => true,
      identifyOnServer: async () => { entered.open(); await release.opened; },
    });
    const attaching = accounts.attach();
    await entered.opened;
    store.failNextRead(STATE_KEY);
    await client.confirm(U2); // asked for, even though it could not be installed
    release.open();
    await attaching;
    expect(store.data[SERVER_IDENTIFIED_KEY]).toBeUndefined();
  });
});

it("an unreadable forget survives until storage recovers and another account signs in", async () => {
  const rec = recordingFetch();
  const state = refusable(pausable());
  const { client } = makeClient({ store: state.store, fetch: rec.fetch });
  await client.confirm(U1);
  await client.track("opened", { where: "popup" });
  state.refuse("reads");
  await client.confirm(null, { forget: true });
  expect(client.accountConfirmed).toBe(false);
  state.refuse("none");
  await client.confirm(U2);
  await client.flush();
  expect(rec.events().some((e) => e.properties.distinct_id === U1)).toBe(false);
});
