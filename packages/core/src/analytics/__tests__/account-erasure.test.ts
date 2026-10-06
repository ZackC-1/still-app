// Account-wide erasure on the device (U5-W3 packet B; owner decisions 60, 61 and 74): the service,
// the extension host's local stop and request, the other device's stop, and the dormancy.
import { describe, expect, it, vi } from "vitest";
import { QUEUE_KEY } from "../client.js";
import { CONSENT_KEY, createStoredConsent, readAnalyticsPermission } from "../consent.js";
import {
  ACCOUNT_ERASURE_KEY,
  createAccountErasureService,
  createErasureService,
  ERASURE_LEDGER_KEY,
  type AccountErasureRequest,
  type ErasureRequest,
} from "../erasure.js";
import {
  ANALYTICS_MESSAGE_KIND,
  createExtensionAnalyticsHost,
  createPageAnalytics,
  STOPPED_ELSEWHERE_KEY,
  SUBJECTS_KEY,
  type ExtensionAnalyticsHostDeps,
} from "../extension-host.js";
import { TEST_PERMISSION, TEST_PRIVACY, TEST_SUBJECTS } from "./privacy-fixture.js";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SUBJECT = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";
const ID = {
  installId: "11111111-1111-4111-8111-111111111111",
  anchorId: "22222222-2222-4222-8222-222222222222",
  created: false,
  returning: false,
};

function memory() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k: string) => structuredClone(data[k]),
    set: async (k: string, v: unknown) => void (data[k] = structuredClone(v)),
  };
}

/** A scripted analytics-erasure server: replies by action, records every request. */
function server(replies: Partial<Record<AccountErasureRequest["action"], unknown>> = {}) {
  const sent: { body: AccountErasureRequest; account: string }[] = [];
  const transport = vi.fn(async (body: AccountErasureRequest, _signal: AbortSignal, account: string) => {
    sent.push({ body, account });
    const reply = replies[body.action];
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { transport, sent, replies };
}

describe("account erasure service", () => {
  it("records the account, sends {action: account} with its session and shows the server's line", async () => {
    const store = memory();
    const s = server({ account: { state: "requested" } });
    const service = createAccountErasureService({ store, transport: s.transport, now: () => 5 });
    expect(await service.request(ACCOUNT.toUpperCase())).toBe("requested");
    expect(s.sent).toEqual([{ body: { action: "account" }, account: ACCOUNT }]);
    // Nothing in the request names an id: the server takes the account from the session.
    expect(JSON.stringify(s.sent.map((r) => r.body))).not.toContain(ACCOUNT);
    expect(store.data[ACCOUNT_ERASURE_KEY]).toEqual({
      account: ACCOUNT,
      state: "requested",
      failed: false,
      shown: false,
      requestedAt: 5,
    });
    expect(await service.withdrawal(ACCOUNT)).toBe("requested");
    expect(await service.withdrawal(OTHER)).toBe("none");
  });

  it("failure → failed, Try again resends; follow-ups move to verifying and deleted, shown once", async () => {
    const store = memory();
    const s = server({ account: new Error("offline") });
    const service = createAccountErasureService({ store, transport: s.transport });
    expect(await service.request(ACCOUNT)).toBe("failed");
    expect(await service.withdrawal(ACCOUNT)).toBe("failed");
    s.replies.account = { state: "requested" };
    await service.retry();
    expect(await service.withdrawal(ACCOUNT)).toBe("requested");
    expect(s.sent.map((r) => r.body.action)).toEqual(["account", "account"]);
    s.replies["account-status"] = { state: "verifying" };
    await service.kick();
    expect(await service.withdrawal(ACCOUNT)).toBe("verifying");
    s.replies["account-status"] = new Error("offline");
    await service.kick();
    expect(await service.withdrawal(ACCOUNT)).toBe("verifying"); // a failed follow-up changes nothing
    s.replies["account-status"] = { state: "deleted" };
    await service.kick();
    expect(await service.withdrawal(ACCOUNT)).toBe("deleted");
    await service.kick();
    expect(s.sent.at(-1)!.body.action).toBe("account-status");
    const calls = s.sent.length;
    await service.kick();
    expect(s.sent).toHaveLength(calls); // deleted: nothing more to follow
    await service.acknowledge(OTHER);
    expect(await service.withdrawal(ACCOUNT)).toBe("deleted");
    await service.acknowledge(ACCOUNT);
    expect(await service.withdrawal(ACCOUNT)).toBe("none");
  });

  it("pending is never success: an unknown reply is a failure, and none from the server shows no line", async () => {
    for (const reply of [null, {}, { state: "done" }, "deleted", [{ state: "deleted" }]]) {
      const service = createAccountErasureService({ store: memory(), transport: server({ account: reply }).transport });
      expect(await service.request(ACCOUNT)).toBe("failed");
    }
    const store = memory();
    const service = createAccountErasureService({ store, transport: server({ account: { state: "none" } }).transport });
    expect(await service.request(ACCOUNT)).toBe("none");
    expect(store.data[ACCOUNT_ERASURE_KEY]).toBeNull();
    // Without a server at all: failed, never sent.
    expect(await createAccountErasureService({ store: memory() }).request(ACCOUNT)).toBe("failed");
    expect(await createAccountErasureService({ store: memory() }).request("not-an-account")).toBe("failed");
  });
});

/** A host with real stored consent (the V3 permission record), the device erasure service, and
 * optionally the account-wide service and per-device subjects. */
async function setup(options: { subjects?: boolean; account?: boolean; replies?: Parameters<typeof server>[0] } = {}) {
  const store = memory();
  const authority = memory();
  const deviceRequests: ErasureRequest[] = [];
  const erasure = createErasureService({
    store,
    transport: async (body) => (deviceRequests.push(body), { state: "requested" }),
  });
  const record = vi.spyOn(erasure, "record");
  const consent = createStoredConsent(authority, false, { cleanupOwned: (origin) => erasure.owns(origin) });
  await consent.grant(TEST_PERMISSION.version);
  const s = server(options.replies ?? { account: { state: "requested" } });
  // The order check: the request must find sharing already off on this device.
  const sharingAtRequest: boolean[] = [];
  const accountErasure = createAccountErasureService({
    store,
    transport: async (body, signal, account) => {
      sharingAtRequest.push(await consent.get());
      return s.transport(body, signal, account);
    },
  });
  const sink = vi.fn(async () => new Response("{}"));
  const onStopped = vi.fn(async () => consent.set(false));
  const deps: ExtensionAnalyticsHostDeps = {
    ...TEST_PRIVACY,
    config: { key: "test", host: "https://us.i.posthog.com" },
    surface: "chrome",
    appVersion: "3.0.0",
    local: store,
    identity: async () => ID,
    consent: () => consent.get(),
    permission: async () => readAnalyticsPermission(await consent.read()),
    commitPermission: async (enabled) => (enabled ? consent.grant(TEST_PERMISSION.version) : consent.set(false)),
    noticeApplies: false,
    isTrustedPage: () => true,
    fetch: sink as unknown as typeof fetch,
    erasure,
    ...(options.subjects === false ? {} : { subjects: { ...TEST_SUBJECTS, onStopped } }),
    ...(options.account === false ? {} : { accountErasure }),
  };
  const host = createExtensionAnalyticsHost(deps);
  const ask = (message: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => {
      if (!host.listener({ kind: ANALYTICS_MESSAGE_KIND, ...message }, {}, resolve)) resolve(undefined);
    });
  const page = createPageAnalytics({ send: ask });
  return { store, authority, consent, erasure, record, deviceRequests, s, sharingAtRequest, host, page, onStopped, sink };
}

describe("the account-wide action through the extension host", () => {
  it("dormancy: without per-device subjects (or the service) it is not offered and sends nothing", async () => {
    for (const options of [{ subjects: false }, { account: false }, { subjects: false, account: false }]) {
      const t = await setup(options);
      expect(await t.page.accountErasure!.state(ACCOUNT)).toBeNull();
      expect(await t.page.accountErasure!.start(ACCOUNT)).toBeNull();
      expect(await t.page.accountErasure!.retry(ACCOUNT)).toBeNull();
      expect(t.s.transport).not.toHaveBeenCalled();
      expect(await t.consent.get()).toBe(true); // nothing stopped either
      t.host.stop();
    }
  });

  it("NEGATIVE CONTROL (dormancy): with both wired the same calls are answered", async () => {
    const t = await setup();
    expect(await t.page.accountErasure!.state(ACCOUNT)).toEqual({ withdrawal: "none", stoppedElsewhere: false });
    t.host.stop();
  });

  it("stops sharing on this device first, then sends the request with the account's session", async () => {
    const t = await setup();
    await t.host.identify(ACCOUNT);
    expect(t.store.data[SUBJECTS_KEY]).toHaveLength(1);
    await t.host.client.track("opened", { where: "popup" });
    expect((t.store.data[QUEUE_KEY] as unknown[]).length).toBeGreaterThan(0);
    const view = await t.page.accountErasure!.start(ACCOUNT);
    expect(view).toEqual({ withdrawal: "requested", stoppedElsewhere: false });
    expect(t.sharingAtRequest).toEqual([false]); // the local stop came first
    expect(t.s.sent).toEqual([{ body: { action: "account" }, account: ACCOUNT }]);
    expect(await t.consent.get()).toBe(false);
    expect(t.store.data[QUEUE_KEY]).toEqual([]);
    // Its cached identity for the account is forgotten (the server retires it).
    expect(t.store.data[SUBJECTS_KEY]).toEqual([]);
    expect(t.sink).not.toHaveBeenCalled(); // no farewell event, nothing sent to PostHog
    t.host.stop();
  });

  it("this device's signed-out data is untouched: no device erasure is recorded or sent (decision 61)", async () => {
    const t = await setup();
    const before = readAnalyticsPermission(t.authority.data[CONSENT_KEY]);
    await t.page.accountErasure!.start(ACCOUNT);
    // Ordinary screens afterwards: every follow-up runs.
    await t.page.track("opened", { where: "popup" });
    await t.page.accountErasure!.state(ACCOUNT);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.record).not.toHaveBeenCalled();
    expect(t.store.data[ERASURE_LEDGER_KEY]).toBeUndefined();
    expect(t.deviceRequests).toEqual([]);
    // The stopped permission keeps the same origin, so its ids stay this device's to erase later.
    const after = readAnalyticsPermission(t.authority.data[CONSENT_KEY]);
    expect(after?.state).toBe("stopped");
    expect(after?.origin).toBe(before?.origin);
    t.host.stop();
  });

  it("NEGATIVE CONTROL: turning sharing off with the switch does record a device erasure", async () => {
    const t = await setup();
    await new Promise((resolve) =>
      t.host.listener({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: false }, {}, resolve),
    );
    expect(t.record).toHaveBeenCalledTimes(1);
    expect(t.store.data[ERASURE_LEDGER_KEY]).toHaveLength(1);
    t.host.stop();
  });

  it("failure: shows failed only after the local stop; Try again resends and reaches requested", async () => {
    const t = await setup({ replies: { account: new Error("offline") } });
    expect(await t.page.accountErasure!.start(ACCOUNT)).toEqual({ withdrawal: "failed", stoppedElsewhere: false });
    expect(await t.consent.get()).toBe(false); // "Sharing stays off on this device" is true
    t.s.replies.account = { state: "requested" };
    expect(await t.page.accountErasure!.retry(ACCOUNT)).toEqual({ withdrawal: "requested", stoppedElsewhere: false });
    expect(t.s.sent.map((r) => r.body.action)).toEqual(["account", "account"]);
    t.host.stop();
  });

  it("nothing is sent when sharing could not be confirmed off here", async () => {
    const t = await setup();
    const host = createExtensionAnalyticsHost({
      ...TEST_PRIVACY,
      config: { key: "test", host: "https://us.i.posthog.com" },
      surface: "chrome",
      appVersion: "3.0.0",
      local: t.store,
      identity: async () => ID,
      consent: async () => true, // the stop does not take
      commitPermission: async () => {
        throw new Error("storage refused");
      },
      noticeApplies: false,
      isTrustedPage: () => true,
      subjects: TEST_SUBJECTS,
      accountErasure: createAccountErasureService({ store: t.store, transport: t.s.transport }),
    });
    const view = await new Promise((resolve) =>
      host.listener({ kind: ANALYTICS_MESSAGE_KIND, action: "accountErasure", op: "start", account: ACCOUNT }, {}, resolve),
    );
    expect(view).toBeNull();
    expect(t.s.transport).not.toHaveBeenCalled();
    host.stop();
    t.host.stop();
  });

  it("the settings page follows the request up when it opens; a background start never does", async () => {
    const t = await setup({ replies: { account: new Error("offline"), "account-status": { state: "verifying" } } });
    expect((await t.page.accountErasure!.start(ACCOUNT))?.withdrawal).toBe("failed");
    t.host.onStart(ACCOUNT); // a background start
    await t.host.flushWhenReady();
    await t.page.track("opened", { where: "popup" });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.s.sent.map((r) => r.body.action)).toEqual(["account"]);
    // The settings page opens: the unsent request is sent again, then followed.
    t.s.replies.account = { state: "requested" };
    expect(await t.page.accountErasure!.state(ACCOUNT)).toEqual({ withdrawal: "requested", stoppedElsewhere: false });
    expect(await t.page.accountErasure!.state(ACCOUNT)).toEqual({ withdrawal: "verifying", stoppedElsewhere: false });
    expect(t.s.sent.map((r) => r.body.action)).toEqual(["account", "account", "account-status"]);
    t.host.stop();
  });

  it("the page refuses a malformed reply and an account that is not an id", async () => {
    const page = createPageAnalytics({ send: async () => ({ withdrawal: "deleted" }) });
    expect(await page.accountErasure!.state(ACCOUNT)).toBeNull();
    const t = await setup();
    expect(await t.page.accountErasure!.state("not-an-id")).toBeNull();
    t.host.stop();
  });

  it("where the page owns consent (Firefox), the confirming tap removes it before anything is sent", async () => {
    const order: string[] = [];
    const page = createPageAnalytics({
      send: async (message) => (order.push(`send:${String(message.op)}`), { withdrawal: "requested", stoppedElsewhere: false }),
      changeConsent: async (enabled) => void order.push(`consent:${enabled}`),
    });
    expect(await page.accountErasure!.start(ACCOUNT)).toEqual({ withdrawal: "requested", stoppedElsewhere: false });
    expect(order).toEqual(["consent:false", "send:start"]);
  });
});

describe("another signed-in device receives the stop", () => {
  it("ends sharing there without a device erasure and shows the other-device line once", async () => {
    const t = await setup();
    const host = createExtensionAnalyticsHost({
      ...TEST_PRIVACY,
      config: { key: "test", host: "https://us.i.posthog.com" },
      surface: "chrome",
      appVersion: "3.0.0",
      local: t.store,
      identity: async () => ID,
      consent: () => t.consent.get(),
      permission: async () => readAnalyticsPermission(await t.consent.read()),
      noticeApplies: false,
      isTrustedPage: () => true,
      erasure: t.erasure,
      subjects: { issue: async () => ({ state: "stopped" }), onStopped: t.onStopped },
      accountErasure: createAccountErasureService({ store: t.store, transport: t.s.transport }),
    });
    const page = createPageAnalytics({
      send: (message) =>
        new Promise((resolve) => host.listener({ kind: ANALYTICS_MESSAGE_KIND, ...message }, {}, resolve)),
    });
    await host.identify(ACCOUNT); // the server answers stopped: the account was erased elsewhere
    expect(t.onStopped).toHaveBeenCalledTimes(1);
    expect(await t.consent.get()).toBe(false);
    expect(t.record).not.toHaveBeenCalled();
    expect(t.store.data[ERASURE_LEDGER_KEY]).toBeUndefined();
    expect(t.s.transport).not.toHaveBeenCalled(); // this device asks nothing of its own
    expect(await page.accountErasure!.state(ACCOUNT)).toEqual({ withdrawal: "none", stoppedElsewhere: true });
    expect(await page.accountErasure!.state(OTHER)).toEqual({ withdrawal: "none", stoppedElsewhere: false });
    await page.accountErasure!.acknowledge(ACCOUNT);
    expect(await page.accountErasure!.state(ACCOUNT)).toEqual({ withdrawal: "none", stoppedElsewhere: false });
    host.stop();
    t.host.stop();
  });

  it("NEGATIVE CONTROL: an active reply is no stop and shows no line", async () => {
    const t = await setup();
    await t.host.identify(ACCOUNT);
    expect(t.onStopped).not.toHaveBeenCalled();
    expect(t.store.data[STOPPED_ELSEWHERE_KEY]).toBeUndefined();
    expect(await t.page.accountErasure!.state(ACCOUNT)).toEqual({ withdrawal: "none", stoppedElsewhere: false });
    expect(await t.host.client.signedInAs()).not.toBe(SUBJECT);
    t.host.stop();
  });

  it("the device's own action never shows the other-device line", async () => {
    const t = await setup();
    await t.store.set(STOPPED_ELSEWHERE_KEY, { account: ACCOUNT });
    expect(await t.page.accountErasure!.start(ACCOUNT)).toEqual({ withdrawal: "requested", stoppedElsewhere: false });
    expect(await t.page.accountErasure!.state(ACCOUNT)).toEqual({ withdrawal: "requested", stoppedElsewhere: false });
    t.host.stop();
  });
});

