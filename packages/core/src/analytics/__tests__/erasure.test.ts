// Per-device identities and device-slice erasure on the client (U5-W2 part 1, owner decision 50).
import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsClient,
  MAX_EVENT_AGE_MS,
  MAX_QUEUE,
  QUEUE_KEY,
  STATE_KEY,
  type AnalyticsClientDeps,
} from "../client.js";
import { CONSENT_KEY, createStoredConsent, readAnalyticsPermission, type AnalyticsPermission } from "../consent.js";
import {
  ANON_INDEX_LIMIT,
  deriveAnonymousId,
  deriveDeviceId,
  erasureKey,
  originProof,
  toHex,
} from "../derive.js";
import { createErasureService, ERASURE_LEDGER_KEY, ERASURE_LEDGER_LIMIT, type ErasureRequest } from "../erasure.js";
import {
  ANALYTICS_MESSAGE_KIND,
  createExtensionAnalyticsHost,
  SUBJECTS_KEY,
  type SubjectDeps,
} from "../extension-host.js";
import { TEST_PERMISSION, TEST_PRIVACY } from "./privacy-fixture.js";

const ID = {
  installId: "11111111-1111-4111-8111-111111111111",
  anchorId: "22222222-2222-4222-8222-222222222222",
  created: false,
  returning: false,
};
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUBJECT = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";
const ORIGIN = "5f1c2a3e-8b7d-4c6a-9e0f-1a2b3c4d5e6f";

function memory() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k: string) => structuredClone(data[k]),
    set: async (k: string, v: unknown) => void (data[k] = structuredClone(v)),
  };
}

function harness(over: Partial<AnalyticsClientDeps> = {}) {
  const store = memory();
  let clock = 1_780_000_000_000;
  const bodies: { batch: { event: string; timestamp: string; properties: Record<string, unknown> }[] }[] = [];
  const sink = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  });
  const deps: AnalyticsClientDeps = {
    ...TEST_PRIVACY,
    config: { key: "test", host: "https://us.i.posthog.com" },
    surface: "chrome",
    appVersion: "3.0.0",
    store,
    identity: async () => ID,
    consent: async () => true,
    fetch: sink as typeof fetch,
    now: () => clock,
    uuid: () => crypto.randomUUID(),
    schedule: () => {},
    ...over,
  };
  return {
    client: new AnalyticsClient(deps),
    deps,
    store,
    sink,
    bodies,
    advance: (ms: number) => void (clock += ms),
    sent: () => bodies.flatMap((b) => b.batch),
  };
}

describe("consent grant", () => {
  it("derives both provider ids from the new private origin", async () => {
    const consent = createStoredConsent(memory(), false);
    await consent.grant(TEST_PERMISSION.version);
    const permission = (await consent.read())!;
    expect(permission.provider.anonymousId).toBe(await deriveAnonymousId(permission.origin, 0));
    expect(permission.provider.deviceId).toBe(await deriveDeviceId(permission.origin));
  });

  it("a stopped origin refuses a new Share until device erasure durably owns its cleanup", async () => {
    const store = memory();
    let owned = false;
    const cleanupOwned = vi.fn(async () => owned);
    const consent = createStoredConsent(store, false, { cleanupOwned });
    await consent.grant(TEST_PERMISSION.version);
    const first = (await consent.read())!;
    await consent.set(false);
    await expect(consent.grant(TEST_PERMISSION.version)).rejects.toThrow("Previous permission cleanup is pending");
    expect(cleanupOwned).toHaveBeenCalledWith(first.origin);
    owned = true;
    await consent.grant(TEST_PERMISSION.version);
    const next = readAnalyticsPermission(store.data[CONSENT_KEY])!;
    expect(next.state).toBe("granted");
    expect(next.origin).not.toBe(first.origin);
    expect(next.provider.anonymousId).not.toBe(first.provider.anonymousId);
    // A failing ownership check never opens the gate.
    const broken = createStoredConsent(store, false, { cleanupOwned: async () => Promise.reject(Error("x")) });
    await broken.set(false);
    await expect(broken.grant(TEST_PERMISSION.version)).rejects.toThrow("Previous permission cleanup is pending");
  });
});

describe("client identity and the late-arrival fence", () => {
  it("each sign-out moves to the next derived anonymous id, never a random one", async () => {
    const h = harness({ uuid: () => "00000000-0000-4000-8000-00000000dead" });
    const origin = TEST_PERMISSION.origin;
    await h.client.identify(ACCOUNT);
    await h.client.reset();
    await h.client.track("opened", { where: "popup" });
    await h.client.flush();
    await h.client.identify(SUBJECT);
    await h.client.reset();
    await h.client.track("opened", { where: "popup" });
    await h.client.flush();
    const ids = h.sent().map((e) => e.properties.distinct_id);
    expect(ids).toEqual([await deriveAnonymousId(origin, 1), await deriveAnonymousId(origin, 2)]);
    expect(ids).not.toContain("00000000-0000-4000-8000-00000000dead");
    expect((h.store.data[STATE_KEY] as { anonIndex: number }).anonIndex).toBe(2);
    expect(await h.client.erasureIndex(origin)).toBe(2);
    expect(await h.client.erasureIndex(ORIGIN)).toBeNull();
  });

  it("stops reporting at the last index rather than reuse or invent an id", async () => {
    const h = harness();
    await h.client.track("opened", { where: "popup" }); // installs the permission
    const state = h.store.data[STATE_KEY] as Record<string, unknown>;
    h.store.data[STATE_KEY] = { ...state, userId: ACCOUNT, anonIndex: ANON_INDEX_LIMIT };
    await h.client.reset();
    await h.client.track("opened", { where: "popup" });
    await h.client.flush();
    expect(h.sent().every((e) => e.properties.distinct_id !== undefined)).toBe(true);
    expect(await h.client.canReport()).toBe(false);
  });

  it("a missing, corrupt or mismatched anonymous index is unknown, never 0", async () => {
    const h = harness();
    const origin = TEST_PERMISSION.origin;
    await h.client.track("opened", { where: "popup" }); // installs the permission at index 0
    const state = () => h.store.data[STATE_KEY] as Record<string, unknown>;
    expect(state().anonIndex).toBe(0);
    // TEST_PERMISSION's first id was not derived from its origin: the cross-check refuses it.
    expect(await h.client.erasureIndex(origin)).toBeNull();
    await h.client.identify(ACCOUNT);
    await h.client.reset(); // index 1, derived
    expect(await h.client.erasureIndex(origin)).toBe(1);
    for (const corrupt of [undefined, -1, 256, 1.5, "1"]) {
      h.store.data[STATE_KEY] = { ...state(), anonIndex: corrupt };
      expect(await h.client.erasureIndex(origin)).toBeNull();
    }
    h.store.data[STATE_KEY] = { ...state(), anonIndex: 2 }; // the id at index 1 is not anon(2)
    expect(await h.client.erasureIndex(origin)).toBeNull();
    // A sign-out with an unknown index records no anonymous id and sends nothing signed out,
    // rather than guess the next id.
    h.store.data[STATE_KEY] = { ...state(), anonIndex: undefined, userId: ACCOUNT };
    await h.client.reset();
    expect([state().userId, state().anonId, state().anonIndex]).toEqual([null, null, null]);
    const sentBefore = h.sent().length;
    await h.client.track("opened", { where: "popup" });
    await h.client.flush();
    expect(h.sent().length).toBe(sentBefore);
  });

  it("drops an event older than 30 days at send time and sends a younger one", async () => {
    const h = harness();
    await h.client.track("opened", { where: "popup" });
    h.advance(MAX_EVENT_AGE_MS + 1_000);
    await h.client.flush();
    expect(h.sink).not.toHaveBeenCalled();
    expect(h.store.data[QUEUE_KEY]).toEqual([]);
    await h.client.track("opened", { where: "popup" });
    h.advance(MAX_EVENT_AGE_MS - 60_000);
    await h.client.flush();
    expect(h.sent().map((e) => e.event)).toEqual(["opened"]);
  });

  it("a per-device subject is confirmed, never the account id it stands for", async () => {
    const h = harness({ startsUnconfirmed: true });
    await h.client.confirm(ACCOUNT, { accountId: ACCOUNT });
    expect(h.client.accountConfirmed).toBe(false);
    await h.client.confirm(SUBJECT, { accountId: ACCOUNT });
    expect(h.client.accountConfirmed).toBe(true);
    await h.client.track("opened", { where: "popup" });
    await h.client.flush();
    expect(h.sent().map((e) => e.properties.distinct_id)).toEqual([SUBJECT]);
    expect(JSON.stringify(h.bodies)).not.toContain(ACCOUNT);
  });

  it("NEGATIVE CONTROL: an event attributed to the account id is refused at send", async () => {
    const h = harness({ startsUnconfirmed: true });
    await h.client.confirm(SUBJECT, { accountId: ACCOUNT });
    await h.client.track("opened", { where: "popup" });
    // Storage claims the confirmed identity is the account itself (tampered, or a host bug).
    const state = h.store.data[STATE_KEY] as Record<string, unknown>;
    h.store.data[STATE_KEY] = { ...state, userId: ACCOUNT, accountRef: ACCOUNT };
    const queue = h.store.data[QUEUE_KEY] as { properties: Record<string, unknown> }[];
    h.store.data[QUEUE_KEY] = queue.map((e) => ({ ...e, properties: { ...e.properties, distinct_id: ACCOUNT } }));
    await h.client.flush();
    expect(h.sink).not.toHaveBeenCalled();
  });
});

describe("per-device subjects through the host", () => {
  function host(reply: (body: unknown) => unknown, over: Record<string, unknown> = {}) {
    const h = harness();
    const requests: unknown[] = [];
    const onStopped = vi.fn(async () => {});
    const subjects: SubjectDeps = {
      issue: async (body) => (requests.push(structuredClone(body)), reply(body)),
      onStopped,
    };
    const extension = createExtensionAnalyticsHost({
      ...h.deps,
      permission: async () => readAnalyticsPermission(await h.deps.permission?.()),
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
      subjects,
      ...over,
    });
    return { h, host: extension, requests, onStopped };
  }

  it("sends only the origin proof, confirms the issued subject and reuses it", async () => {
    const { h, host: extension, requests } = host(() => ({ state: "active", subject: SUBJECT }));
    await extension.identify(ACCOUNT);
    await extension.client.track("opened", { where: "popup" });
    await extension.client.flush();
    expect(requests).toEqual([{ originProof: await originProof(TEST_PERMISSION.origin) }]);
    // NEGATIVE CONTROL (consent handle): nothing sent to Still's server carries the origin.
    expect(JSON.stringify(requests)).not.toContain(TEST_PERMISSION.origin);
    expect(JSON.stringify(requests)).not.toContain(ACCOUNT);
    expect(h.sent().map((e) => e.properties.distinct_id)).toEqual([SUBJECT]);
    expect(JSON.stringify(h.bodies)).not.toContain(TEST_PERMISSION.origin);
    expect(h.store.data[SUBJECTS_KEY]).toEqual([{ account: ACCOUNT, origin: TEST_PERMISSION.origin, subject: SUBJECT }]);
    await extension.client.reset();
    await extension.identify(ACCOUNT);
    expect(requests).toHaveLength(1);
    expect(await extension.client.signedInAs()).toBe(SUBJECT);
    extension.stop();
  });

  it("without per-device subjects the host never confirms the account id", async () => {
    const h = harness();
    const extension = createExtensionAnalyticsHost({
      ...h.deps,
      permission: async () => readAnalyticsPermission(await h.deps.permission?.()),
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
    });
    await extension.identify(ACCOUNT);
    await extension.client.track("opened", { where: "popup" });
    await extension.client.flush();
    expect(JSON.stringify(h.bodies)).not.toContain(ACCOUNT);
    expect(JSON.stringify(h.store.data[STATE_KEY] ?? {})).not.toContain(ACCOUNT);
    extension.stop();
  });

  describe("signed-in use with no identity is never given to nobody", () => {
    const plainHost = (h: ReturnType<typeof harness>) =>
      createExtensionAnalyticsHost({
        ...h.deps,
        permission: async () => readAnalyticsPermission(await h.deps.permission?.()),
        local: h.store,
        noticeApplies: false,
        isTrustedPage: () => true,
      });
    const queued = (h: ReturnType<typeof harness>) =>
      ((h.store.data[QUEUE_KEY] as { event: string; attributeLater?: boolean }[] | undefined) ?? []);

    it("without per-device subjects, a sign-in from confirmed-nobody stops reporting as nobody", async () => {
      const h = harness();
      const extension = plainHost(h);
      extension.onStart(null);
      await extension.flushWhenReady();
      expect(extension.client.accountConfirmed).toBe(true); // nobody is signed in
      await extension.identify(ACCOUNT);
      expect(extension.client.accountConfirmed).toBe(false);
      await extension.client.track("opened", { where: "popup" });
      await extension.client.flush();
      expect(h.sink).not.toHaveBeenCalled();
      expect(queued(h).map((e) => [e.event, e.attributeLater])).toEqual([["opened", true]]);
      extension.stop();
    });

    it.each([
      ["a deletion", { forgetAccount: true }],
      ["a sign-out", {}],
    ] as const)("%s drops what waited for the account; nothing recorded later is lost", async (_, options) => {
      const h = harness();
      const extension = plainHost(h);
      extension.onStart(null);
      await extension.flushWhenReady();
      await extension.client.track("opened", { where: "options" }); // signed out: anonymous
      await extension.identify(ACCOUNT);
      await extension.client.track("opened", { where: "popup" }); // signed in: waits
      await extension.client.reset(options);
      await extension.client.track("active", {});
      await extension.client.flush();
      expect(h.sent().map((e) => [e.event, e.properties.where, e.properties.signed_in])).toEqual([
        ["opened", "options", false],
        ["active", undefined, false],
      ]);
      expect(JSON.stringify(h.bodies)).not.toContain(ACCOUNT);
      extension.stop();
    });

    it("the hold survives a restart: a new client lets go without giving the waiting use to nobody", async () => {
      const h = harness();
      const first = plainHost(h);
      first.onStart(null);
      await first.flushWhenReady();
      await first.identify(ACCOUNT);
      await first.client.track("opened", { where: "popup" });
      expect(queued(h)).toHaveLength(1);
      // The worker ends without a teardown; the next background start finds no session (signed
      // out, or the account deleted, while it slept).
      const later = plainHost(h);
      later.onStart(null);
      await later.flushWhenReady();
      await later.client.flush();
      expect(h.sink).not.toHaveBeenCalled();
      expect(queued(h)).toEqual([]);
      later.stop();
      first.stop();
    });

    it("NEGATIVE CONTROL: a confirmation asked before the hold never releases it, even unrecorded", async () => {
      const h = harness();
      const set = h.store.set;
      // Storage refuses to record the hold: only the in-memory flag remains.
      h.store.set = async (key: string, value: unknown) => {
        if (key === STATE_KEY && (value as { held?: boolean }).held === true) throw new Error("refused");
        return set(key, value);
      };
      const extension = plainHost(h);
      extension.onStart(null); // asked now, run after the sign-in's hold below
      await extension.identify(ACCOUNT);
      await extension.client.track("opened", { where: "popup" });
      await extension.client.reset({ forgetAccount: true });
      await extension.client.track("active", {});
      await extension.client.flush();
      expect(h.sent().map((e) => e.event)).toEqual(["active"]);
      extension.stop();
    });

    it("a subject issued later takes what waited; only letting go drops it", async () => {
      let reply: unknown = null;
      const { h, host: extension } = host(() => reply);
      extension.onStart(null);
      await extension.flushWhenReady();
      await extension.identify(ACCOUNT); // no subject yet
      await extension.client.track("opened", { where: "popup" });
      reply = { state: "active", subject: SUBJECT };
      await extension.identify(ACCOUNT);
      await extension.client.flush();
      expect(h.sent().map((e) => [e.event, e.properties.distinct_id])).toEqual([["opened", SUBJECT]]);
      expect((h.store.data[STATE_KEY] as { heldFor?: string | null }).heldFor).toBeNull();
      extension.stop();
    });

    const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const OTHER_SUBJECT = "6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c";

    it("NEGATIVE CONTROL: what waited for one account is never sent under another account's subject", async () => {
      const replies: Record<string, unknown> = { [OTHER]: { state: "active", subject: OTHER_SUBJECT } };
      const h = harness();
      const extension = createExtensionAnalyticsHost({
        ...h.deps,
        permission: async () => readAnalyticsPermission(await h.deps.permission?.()),
        local: h.store,
        noticeApplies: false,
        isTrustedPage: () => true,
        subjects: { issue: async (_b, _s, account) => replies[account] ?? null, onStopped: async () => {} },
      });
      extension.onStart(null);
      await extension.flushWhenReady();
      await extension.identify(ACCOUNT); // A: no subject yet
      await extension.client.track("opened", { where: "popup" }); // A's use, waiting
      await extension.identify(OTHER); // B signs in and B's subject is confirmed
      await extension.client.track("active", {});
      await extension.client.flush();
      expect(h.sent().map((e) => [e.event, e.properties.distinct_id])).toEqual([["active", OTHER_SUBJECT]]);
      extension.stop();
    });

    it("NEGATIVE CONTROL: a confirmation under another account's subject drops the held account's use", async () => {
      // Directly at the client: held for A, then confirmed as B's subject with no hold for B first.
      const h = harness();
      await h.client.confirm(null);
      await h.client.holdForAccount(ACCOUNT);
      await h.client.track("opened", { where: "popup" });
      expect((h.store.data[STATE_KEY] as { heldFor?: string }).heldFor).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(h.store.data)).not.toContain(ACCOUNT); // only a one-way tag is stored
      await h.client.confirm(OTHER_SUBJECT, { accountId: OTHER });
      await h.client.track("active", {});
      await h.client.flush();
      expect(h.sent().map((e) => [e.event, e.properties.distinct_id])).toEqual([["active", OTHER_SUBJECT]]);
    });

    it("a hold moved to another account across a restart drops the earlier account's use", async () => {
      const h = harness();
      const first = plainHost(h);
      first.onStart(null);
      await first.flushWhenReady();
      await first.identify(ACCOUNT);
      await first.client.track("opened", { where: "popup" });
      expect(queued(h)).toHaveLength(1);
      const later = plainHost(h); // the worker restarted; B is now signed in
      await later.identify(OTHER);
      expect(queued(h)).toEqual([]);
      later.stop();
      first.stop();
    });

    it("NEGATIVE CONTROL: a quiet start signed in holds, so a sign-out sends none of that use", async () => {
      const { h, host: extension, requests } = host(() => ({ state: "active", subject: SUBJECT }));
      extension.onStart(ACCOUNT); // a background start: never asks the server
      await extension.flushWhenReady();
      expect(requests).toEqual([]);
      await extension.client.track("opened", { where: "popup" });
      await extension.client.reset();
      await extension.client.track("active", {});
      await extension.client.flush();
      expect(h.sent().map((e) => [e.event, e.properties.signed_in])).toEqual([["active", false]]);
      extension.stop();
    });

    it("a long hold drops waiting use past the age limit as new use arrives", async () => {
      const h = harness();
      await h.client.confirm(null);
      await h.client.holdForAccount(ACCOUNT);
      await h.client.track("opened", { where: "popup" });
      h.advance(MAX_EVENT_AGE_MS + 1);
      await h.client.track("opened", { where: "options" });
      const waiting = queued(h) as { event: string; attributeLater?: boolean; properties?: { where?: string } }[];
      expect(waiting.map((e) => [e.properties?.where, e.attributeLater])).toEqual([["options", true]]);
    });

    it("NEGATIVE CONTROL: held use never pushes signed-out use out of a full queue", async () => {
      const h = harness();
      await h.client.confirm(null);
      await h.client.track("opened", { where: "options" }); // signed out: attributed
      await h.client.holdForAccount(ACCOUNT);
      for (let n = 0; n < MAX_QUEUE + 5; n++) await h.client.track("opened", { where: "popup" });
      const all = queued(h) as { attributeLater?: boolean; properties?: { where?: string } }[];
      expect(all).toHaveLength(MAX_QUEUE);
      expect(all.filter((e) => !e.attributeLater).map((e) => e.properties?.where)).toEqual(["options"]);
    }, 30_000);

    it("a hold waiting for its identity has nothing to flush", async () => {
      const h = harness();
      await h.client.confirm(null);
      await h.client.track("opened", { where: "options" });
      expect(await h.client.flushWorthwhile()).toBe(true);
      await h.client.flush();
      await h.client.holdForAccount(ACCOUNT);
      await h.client.track("opened", { where: "popup" });
      expect(await h.client.flushWorthwhile()).toBe(false);
    });

    /** A subjects host whose replies are decided per account by `reply`. */
    const perAccountHost = (reply: (account: string) => unknown) => {
      const h = harness();
      const asked: string[] = [];
      const extension = createExtensionAnalyticsHost({
        ...h.deps,
        permission: async () => readAnalyticsPermission(await h.deps.permission?.()),
        local: h.store,
        noticeApplies: false,
        isTrustedPage: () => true,
        subjects: {
          issue: async (_body, _signal, account) => (asked.push(account), reply(account)),
          onStopped: async () => {},
        },
      });
      return { h, extension, asked };
    };

    it("NEGATIVE CONTROL: an earlier account's subject arriving after a switch never takes the new account's use", async () => {
      let resolveA!: (value: unknown) => void;
      let resolveB!: (value: unknown) => void;
      const lateA = new Promise((resolve) => (resolveA = resolve));
      const lateB = new Promise((resolve) => (resolveB = resolve));
      const { h, extension, asked } = perAccountHost((account) => (account === ACCOUNT ? lateA : lateB));
      extension.onStart(null);
      await extension.flushWhenReady();
      const identifyingA = extension.identify(ACCOUNT); // A's subject request is in flight
      await vi.waitFor(() => expect(asked).toEqual([ACCOUNT]));
      const identifyingB = extension.identify(OTHER); // B signs in before A's reply, no sign-out
      await vi.waitFor(() => expect(asked).toEqual([ACCOUNT, OTHER]));
      await extension.client.track("opened", { where: "popup" }); // B's use, waiting
      resolveA({ state: "active", subject: SUBJECT }); // A's reply lands first, late
      await identifyingA;
      resolveB({ state: "active", subject: OTHER_SUBJECT }); // then B's
      await identifyingB;
      await extension.client.track("active", {});
      await extension.client.flush();
      expect(extension.client.accountConfirmed).toBe(true);
      expect(await extension.client.signedInAs()).toBe(OTHER_SUBJECT);
      expect(JSON.stringify(h.bodies)).not.toContain(SUBJECT);
      expect(h.sent().map((e) => [e.event, e.properties.distinct_id])).toEqual([
        ["opened", OTHER_SUBJECT],
        ["active", OTHER_SUBJECT],
      ]);
      extension.stop();
    });

    it("NEGATIVE CONTROL: a page event observed under one account's hold is dropped when the hold moves", async () => {
      const { h, extension } = perAccountHost(() => null); // no subject is ever issued
      await extension.identify(ACCOUNT); // held for A; the start has not settled yet
      const answered = new Promise<unknown>((resolve) => {
        extension.listener(
          { kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } },
          { id: "ext", url: "chrome-extension://ext/popup.html" },
          resolve,
        );
      });
      await new Promise((r) => setTimeout(r, 5)); // the page event is waiting for the start
      await extension.identify(OTHER); // the hold moves to B
      extension.onStart(OTHER);
      expect(await answered).toBe(false);
      expect(queued(h).filter((e) => e.event === "opened")).toEqual([]);
      extension.stop();
    });

    it("NEGATIVE CONTROL: a hold storage will not keep queues nothing that could later go out as nobody", async () => {
      const h = harness();
      const set = h.store.set;
      h.store.set = async (key: string, value: unknown) => {
        if (key === STATE_KEY && typeof (value as { heldFor?: unknown }).heldFor === "string")
          throw new Error("refused");
        return set(key, value);
      };
      await h.client.confirm(null);
      await h.client.track("opened", { where: "options" }); // signed out
      await h.client.flush();
      await h.client.holdForAccount(ACCOUNT); // the hold is only in memory
      await h.client.track("opened", { where: "popup" }); // refused: it could not wait under a hold
      expect(queued(h).map((e) => e.event)).toEqual([]);
      const restarted = new AnalyticsClient(h.deps); // a restart, then a sign-out
      await restarted.confirm(null);
      await restarted.flush();
      expect(h.sent().map((e) => e.properties.where)).toEqual(["options"]);
    });

    it("NEGATIVE CONTROL: after a restart, waiting use is dropped when the earlier signed-in person is let go", async () => {
      const h = harness();
      await h.client.confirm(SUBJECT, { accountId: ACCOUNT });
      await h.client.track("opened", { where: "popup" });
      await h.client.flush();
      // A restart whose session cannot be read yet: what it records waits, with no hold.
      const restarted = new AnalyticsClient({ ...h.deps, startsUnconfirmed: true });
      await restarted.track("opened", { where: "options" });
      await restarted.confirm(null); // the session turns out signed out (or the account deleted)
      await restarted.track("active", {});
      await restarted.flush();
      expect(h.sent().map((e) => [e.event, e.properties.where, e.properties.distinct_id === SUBJECT])).toEqual([
        ["opened", "popup", true],
        ["active", undefined, false],
      ]);
    });
  });

  it("NEGATIVE CONTROL: from confirmed-nobody, an account whose subject request fails sends nothing as nobody", async () => {
    const { h, host: extension, requests } = host(() => {
      throw new Error("offline");
    });
    extension.onStart(null);
    await extension.flushWhenReady();
    expect(extension.client.accountConfirmed).toBe(true); // nobody is signed in
    await extension.identify(ACCOUNT);
    expect(requests).toHaveLength(1);
    expect(extension.client.accountConfirmed).toBe(false);
    await extension.client.track("opened", { where: "popup" });
    await extension.client.flush();
    expect(h.sink).not.toHaveBeenCalled(); // signed-in use is never reported under the anonymous id
    extension.stop();
  });

  it("NEGATIVE CONTROL: retrying the same account while unconfirmed never drops its work in progress", async () => {
    let fail = true;
    const { h, host: extension } = host(() => {
      if (fail) {
        fail = false;
        throw new Error("offline");
      }
      return { state: "active", subject: SUBJECT };
    });
    await extension.identify(ACCOUNT); // fails: unconfirmed, still this account
    const identifying = extension.identify(ACCOUNT);
    const tracking = extension.client.track("opened", { where: "popup" }); // concurrent with the retry
    await Promise.all([identifying, tracking]);
    await extension.client.flush();
    expect(h.sent().map((e) => [e.event, e.properties.distinct_id])).toEqual([["opened", SUBJECT]]);
    extension.stop();
  });

  it("a confirmation pending for one account is withdrawn when another account is asked for", async () => {
    const replies: Record<string, unknown> = {};
    const { h, host: extension } = host(() => replies.next);
    replies.next = { state: "active", subject: SUBJECT };
    await extension.identify(ACCOUNT);
    expect(extension.client.accountConfirmed).toBe(true);
    replies.next = null; // the next account's subject cannot be issued
    await extension.identify("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(extension.client.accountConfirmed).toBe(false);
    await extension.client.track("opened", { where: "popup" });
    await extension.client.flush();
    expect(JSON.stringify(h.bodies)).not.toContain(SUBJECT);
    extension.stop();
  });

  it("NEGATIVE CONTROL: a confirmation still pending for one account never lands after another is asked for", async () => {
    let next: unknown = { state: "active", subject: SUBJECT };
    let failStateReads = 0;
    const h = harness();
    const get = h.store.get;
    h.store.get = async (key: string) => {
      if (key === STATE_KEY && failStateReads > 0) {
        failStateReads -= 1;
        throw new Error("state unreadable once");
      }
      return get(key);
    };
    const extension = createExtensionAnalyticsHost({
      ...h.deps,
      permission: async () => readAnalyticsPermission(await h.deps.permission?.()),
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
      // The subject arrives, then the next state read (the confirmation's own) fails once.
      subjects: { issue: async () => ((failStateReads = next ? 1 : 0), next), onStopped: async () => {} },
    });
    await extension.identify(ACCOUNT); // the subject arrives, but its confirmation stays pending
    expect(extension.client.accountConfirmed).toBe(false);
    next = null;
    await extension.identify("cccccccc-cccc-4ccc-8ccc-cccccccccccc"); // B: no subject yet
    await extension.client.flush(); // would retry a pending confirmation
    await extension.client.track("opened", { where: "popup" });
    await extension.client.flush();
    expect(extension.client.accountConfirmed).toBe(false);
    expect(JSON.stringify(h.bodies)).not.toContain(SUBJECT);
    extension.stop();
  });

  it("a background start never asks the server; events wait unattributed", async () => {
    const { host: extension, requests } = host(() => ({ state: "active", subject: SUBJECT }));
    await extension.identify(ACCOUNT, { quiet: true });
    expect(requests).toEqual([]);
    expect(extension.client.accountConfirmed).toBe(false);
    extension.stop();
  });

  it("a stopped device turns sharing off, and a reply naming the account id is refused", async () => {
    const stopped = host(() => ({ state: "stopped" }));
    await stopped.host.identify(ACCOUNT);
    expect(stopped.onStopped).toHaveBeenCalledTimes(1);
    expect(stopped.host.client.accountConfirmed).toBe(false);
    stopped.host.stop();
    for (const bad of [{ state: "active", subject: ACCOUNT }, { state: "active", subject: "nope" }, null, "x"]) {
      const odd = host(() => bad);
      await odd.host.identify(ACCOUNT);
      expect(odd.host.client.accountConfirmed).toBe(false);
      expect(odd.h.store.data[SUBJECTS_KEY]).toBeUndefined();
      expect(odd.onStopped).not.toHaveBeenCalled();
      odd.host.stop();
    }
  });
});

describe("device erasure (erasure.ts)", () => {
  const derivedPermission = async (origin: string): Promise<AnalyticsPermission> => ({
    ...TEST_PERMISSION,
    origin,
    provider: { anonymousId: await deriveAnonymousId(origin, 0), deviceId: await deriveDeviceId(origin) },
  });
  function service(reply: (body: ErasureRequest) => unknown, store = memory()) {
    const sent: ErasureRequest[] = [];
    const erasure = createErasureService({
      store,
      transport: async (body) => (sent.push(structuredClone(body)), reply(body)),
      now: () => 1_780_000_000_000,
    });
    return { store, sent, erasure };
  }

  it("records a durable obligation and sends only the erasure key and the last index: no ids", async () => {
    const permission = await derivedPermission(ORIGIN);
    const { sent, erasure, store } = service(() => ({ state: "requested" }));
    expect(await erasure.withdrawal()).toBe("none");
    expect(await erasure.record(permission, 2)).toBe(true);
    expect(await erasure.owns(ORIGIN)).toBe(true);
    expect(await erasure.owns(TEST_PERMISSION.origin)).toBe(false);
    await erasure.kick();
    expect(sent).toEqual([{ action: "device", erasureKey: toHex(await erasureKey(ORIGIN)), anonIndex: 2 }]);
    // NEGATIVE CONTROL (consent handle): the request never carries the origin, nor any id.
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(ORIGIN);
    for (const k of [0, 1, 2]) expect(wire).not.toContain(await deriveAnonymousId(ORIGIN, k));
    expect(await erasure.withdrawal()).toBe("requested");
    expect((store.data[ERASURE_LEDGER_KEY] as unknown[]).length).toBe(1);
    // The erasure key is not the identify proof: the proof alone gives no erase power.
    expect(toHex(await erasureKey(ORIGIN))).not.toBe(await originProof(ORIGIN));
  });

  it("refuses a permission whose ids were not derived from its origin (nothing could erase them)", async () => {
    const { erasure } = service(() => ({ state: "requested" }));
    expect(await erasure.record({ ...TEST_PERMISSION, origin: ORIGIN }, 0)).toBe(false);
    expect(await erasure.owns(ORIGIN)).toBe(false);
  });

  it("a failed send reads as failed with retry; status then follows the server to deleted", async () => {
    let offline = true;
    let stage = "requested";
    const { sent, erasure } = service((body) => {
      if (offline) throw new Error("offline");
      return { state: body.action === "device" ? "requested" : stage };
    });
    await erasure.record(await derivedPermission(ORIGIN), 0);
    await erasure.kick();
    expect(await erasure.withdrawal()).toBe("failed");
    offline = false;
    await erasure.retry();
    expect(await erasure.withdrawal()).toBe("requested");
    stage = "verifying";
    await erasure.kick();
    expect(await erasure.withdrawal()).toBe("verifying");
    stage = "deleted";
    await erasure.kick();
    expect(await erasure.withdrawal()).toBe("deleted");
    await erasure.acknowledge();
    expect(await erasure.withdrawal()).toBe("none");
    const before = sent.length;
    await erasure.kick();
    expect(sent.length).toBe(before);
    expect(await erasure.owns(ORIGIN)).toBe(true);
    expect(sent.map((b) => b.action)).toEqual(["device", "device", "status", "status"]);
  });

  it("a server with no record gets the request again; an unreadable reply is never success", async () => {
    let reply: unknown = { state: "none" };
    const { sent, erasure } = service(() => reply);
    await erasure.record(await derivedPermission(ORIGIN), 0);
    await erasure.kick();
    await erasure.kick();
    expect(sent.map((b) => b.action)).toEqual(["device", "device"]);
    reply = { state: "done" };
    await erasure.kick();
    expect(await erasure.withdrawal()).toBe("failed");
    const unconfigured = createErasureService({ store: memory() });
    await unconfigured.record(await derivedPermission(ORIGIN), 0);
    await unconfigured.kick();
    expect(await unconfigured.withdrawal()).toBe("failed");
  });

  it("NEGATIVE CONTROL: an unparseable ledger is never saved over, and the tombstone keeps refusing", async () => {
    for (const corrupt of ["garbage", { 0: 1 }, [{ origin: "nope" }], [{ origin: ORIGIN, anonIndex: 0, state: "unsent" }]]) {
      const ledger = memory();
      const authority = memory();
      ledger.data[ERASURE_LEDGER_KEY] = structuredClone(corrupt);
      const { erasure } = service(() => ({ state: "requested" }), ledger);
      const consent = createStoredConsent(authority, false, { cleanupOwned: (origin) => erasure.owns(origin) });
      await consent.grant(TEST_PERMISSION.version);
      const granted = (await consent.read())!;
      await consent.set(false);
      expect(await erasure.record(granted, 0)).toBe(false);
      expect(ledger.data[ERASURE_LEDGER_KEY]).toEqual(corrupt);
      expect(await erasure.owns(granted.origin)).toBe(false);
      await expect(consent.grant(TEST_PERMISSION.version)).rejects.toThrow("Previous permission cleanup is pending");
    }
  });

  it("refuses to record what storage does not keep", async () => {
    const erasure = createErasureService({ store: { get: async () => undefined, set: async () => {} } });
    expect(await erasure.record(await derivedPermission(ORIGIN), 0)).toBe(false);
    expect(await erasure.owns(ORIGIN)).toBe(false);
  });

  it("NEGATIVE CONTROL: nine stops while the server is down never evict a pending obligation", async () => {
    const ledger = memory();
    const authority = memory();
    const { erasure } = service(() => {
      throw new Error("server down");
    }, ledger);
    const consent = createStoredConsent(authority, false, { cleanupOwned: (origin) => erasure.owns(origin) });
    const origins: string[] = [];
    for (let cycle = 1; cycle <= 9; cycle++) {
      await consent.grant(TEST_PERMISSION.version);
      const granted = (await consent.read())!;
      origins.push(granted.origin);
      await consent.set(false);
      expect(await erasure.record(granted, 0)).toBe(cycle <= ERASURE_LEDGER_LIMIT);
      await erasure.kick();
    }
    // Every pending obligation is still there; the ninth was refused, so its tombstone holds.
    for (const origin of origins.slice(0, ERASURE_LEDGER_LIMIT)) expect(await erasure.owns(origin)).toBe(true);
    expect(await erasure.owns(origins[8]!)).toBe(false);
    await expect(consent.grant(TEST_PERMISSION.version)).rejects.toThrow("Previous permission cleanup is pending");
    expect((ledger.data[ERASURE_LEDGER_KEY] as unknown[]).length).toBe(ERASURE_LEDGER_LIMIT);
  });

  it("a deleted entry makes room for a new obligation; a pending one never does", async () => {
    let state = "requested";
    const ledger = memory();
    const { erasure } = service(() => ({ state }), ledger);
    const origins = Array.from({ length: 9 }, (_, i) => `5f1c2a3e-8b7d-4c6a-9e0f-${String(i).padStart(12, "0")}`);
    for (const origin of origins.slice(0, 8)) expect(await erasure.record(await derivedPermission(origin), 0)).toBe(true);
    expect(await erasure.record(await derivedPermission(origins[8]!), 0)).toBe(false);
    state = "deleted";
    await erasure.kick(); // every entry is sent, then reported deleted by the server
    expect(await erasure.record(await derivedPermission(origins[8]!), 0)).toBe(true);
    expect(await erasure.owns(origins[8]!)).toBe(true);
  });
});

describe("Off on one device through the extension host", () => {
  it("stops locally before any network, records the obligation, then sends it; Share works again", async () => {
    const order: string[] = [];
    const authority = memory();
    const ledger = memory();
    const erasure = createErasureService({
      store: ledger,
      transport: async (body) => {
        order.push(`network:${body.action}`);
        return { state: "requested" };
      },
    });
    const consent = createStoredConsent(authority, false, { cleanupOwned: (origin) => erasure.owns(origin) });
    await consent.grant(TEST_PERMISSION.version);
    const granted = (await consent.read())!;
    const h = harness({ permission: () => consent.read(), consent: () => consent.get() });
    const extension = createExtensionAnalyticsHost({
      ...h.deps,
      permission: async () => readAnalyticsPermission(await consent.read()),
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
      erasure,
      commitPermission: async (enabled) => {
        if (enabled) return consent.grant(TEST_PERMISSION.version);
        await consent.set(false);
        order.push("stopped");
      },
    });
    extension.onStart(null);
    await extension.flushWhenReady();
    await extension.client.track("opened", { where: "popup" });
    const response = new Promise((resolve) =>
      extension.listener({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: false }, {}, resolve),
    );
    expect(await response).toBe(false);
    await erasure.kick();
    expect(order[0]).toBe("stopped");
    expect(order).toContain("network:device");
    expect(h.store.data[QUEUE_KEY]).toEqual([]);
    expect(h.sink).not.toHaveBeenCalled(); // no farewell event
    expect(readAnalyticsPermission(authority.data[CONSENT_KEY])!.state).toBe("stopped");
    expect(await erasure.owns(granted.origin)).toBe(true);
    expect(await erasure.withdrawal()).toBe("requested");
    // The stopped origin no longer blocks a fresh Share; the new origin derives new ids.
    await consent.grant(TEST_PERMISSION.version);
    expect((await consent.read())!.origin).not.toBe(granted.origin);
    extension.stop();
  });
});

describe("per-device subjects through the Apple app", () => {
  it("a signed-in Apple session reports under the issued subject, never the account id", async () => {
    const { createAppAnalytics } = await import("../apple-app.js");
    const store = memory();
    const bodies: { batch: { properties: Record<string, unknown> }[] }[] = [];
    const requests: unknown[] = [];
    const app = createAppAnalytics({
      ...TEST_PRIVACY,
      config: { key: "test", host: "https://us.i.posthog.com" },
      store,
      subjects: {
        issue: async (body) => (requests.push(structuredClone(body)), { state: "active", subject: SUBJECT }),
        onStopped: async () => {},
      },
      fetch: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      }) as typeof fetch,
      bridge: {
        analyticsContext: async () => ({
          ...ID,
          platform: "macos",
          device: "desktop",
          appVersion: "3.0.0",
          previousVersion: null,
          consent: true,
          noticeSeen: true,
          extensionEnabled: true,
        }),
        setAnalyticsConsent: async () => false,
        acknowledgeAnalyticsNotice: async () => {},
      },
    });
    await app.identifyAccount(ACCOUNT);
    expect(requests).toEqual([{ originProof: await originProof(TEST_PERMISSION.origin) }]);
    app.ui.track("opened", { where: "app" });
    await new Promise((r) => setTimeout(r, 0));
    const queued = store.data[QUEUE_KEY] as { properties: Record<string, unknown> }[];
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((e) => e.properties.distinct_id === SUBJECT)).toBe(true);
    expect(JSON.stringify([queued, requests, bodies])).not.toContain(ACCOUNT);
  });
});

describe("an unreadable anonymous index", () => {
  it("is never taken as 0: the erasure covers every index the origin could have used", async () => {
    const authority = memory();
    const erasure = createErasureService({ store: memory(), transport: async () => ({ state: "requested" }) });
    const record = vi.spyOn(erasure, "record");
    const consent = createStoredConsent(authority, false, { cleanupOwned: (origin) => erasure.owns(origin) });
    await consent.grant(TEST_PERMISSION.version);
    const h = harness({ permission: () => consent.read(), consent: () => consent.get() });
    const extension = createExtensionAnalyticsHost({
      ...h.deps,
      permission: async () => readAnalyticsPermission(await consent.read()),
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
      erasure,
      commitPermission: async (enabled) => (enabled ? consent.grant(TEST_PERMISSION.version) : consent.set(false)),
    });
    // This client never recorded anything under the origin, so it cannot say which index it used.
    const response = new Promise((resolve) =>
      extension.listener({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: false }, {}, resolve),
    );
    await response;
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![1]).toBe(ANON_INDEX_LIMIT);
    extension.stop();
  });
});
