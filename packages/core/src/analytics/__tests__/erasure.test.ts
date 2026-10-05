// Per-device identities and device-slice erasure on the client (U5-W2 part 1, owner decision 50).
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsClient,
  MAX_EVENT_AGE_MS,
  QUEUE_KEY,
  STATE_KEY,
  type AnalyticsClientDeps,
} from "../client.js";
import { CONSENT_KEY, createStoredConsent, readAnalyticsPermission, type AnalyticsPermission } from "../consent.js";
import {
  ANON_INDEX_LIMIT,
  deriveAnonymousId,
  deriveAnonymousIds,
  deriveDeviceId,
  originProof,
} from "../derive.js";
import { createErasureService, ERASURE_LEDGER_KEY, type ErasureRequest } from "../erasure.js";
import {
  ANALYTICS_MESSAGE_KIND,
  createExtensionAnalyticsHost,
  SUBJECTS_KEY,
  type SubjectDeps,
} from "../extension-host.js";
import { isAnalyticsId } from "../identity.js";
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

const node = {
  uuid(digest: Buffer) {
    const b = Buffer.from(digest.subarray(0, 16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },
  hmac(origin: string, label: string) {
    return node.uuid(createHmac("sha256", Buffer.from(origin, "utf8")).update(label).digest());
  },
};

describe("derived provider ids (derive.ts)", () => {
  it("matches the fixed reference vectors and an independent implementation", async () => {
    // Fixed vectors: any change to a label, the key encoding or the UUID layout changes them.
    expect(await deriveAnonymousId(ORIGIN, 0)).toBe("2203068f-638e-4300-bb1b-eafb535e893f");
    expect(await deriveAnonymousId(ORIGIN, 1)).toBe("6df45121-48d4-40e7-bf93-2912f19bad16");
    expect(await deriveAnonymousId(ORIGIN, 255)).toBe("a110e5b2-cfc0-44df-a97e-2bfddcc6f13f");
    expect(await deriveDeviceId(ORIGIN)).toBe("04051239-75c6-428e-9dda-af277e430dfe");
    expect(await originProof(ORIGIN)).toBe("3183e11dc4a0bc3fd8e30bccffb90a695b56e5453e9429440d32c88f976b6b7a");
    for (const k of [0, 7, 42]) {
      expect(await deriveAnonymousId(ORIGIN, k)).toBe(node.hmac(ORIGIN, `still:analytics:anon:0:${k}`));
    }
    expect(await originProof(ORIGIN)).toBe(createHash("sha256").update(ORIGIN).digest("hex"));
  });

  it("derives distinct valid ids per index, never equal to the device id or the origin", async () => {
    const ids = await deriveAnonymousIds(ORIGIN, 9);
    expect(new Set(ids).size).toBe(10);
    expect(ids.every(isAnalyticsId)).toBe(true);
    expect(ids).not.toContain(await deriveDeviceId(ORIGIN));
    expect(ids).not.toContain(ORIGIN);
    expect(await originProof(ORIGIN)).not.toContain(ORIGIN.replaceAll("-", ""));
    await expect(deriveAnonymousId(ORIGIN, ANON_INDEX_LIMIT + 1)).rejects.toThrow();
    await expect(deriveAnonymousId(ORIGIN.toUpperCase(), 0)).rejects.toThrow();
  });
});

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
  const permission: AnalyticsPermission = { ...TEST_PERMISSION, origin: ORIGIN };
  function service(reply: (body: ErasureRequest) => unknown) {
    const store = memory();
    const sent: ErasureRequest[] = [];
    const erasure = createErasureService({
      store,
      transport: async (body) => (sent.push(structuredClone(body)), reply(body)),
      now: () => 1_780_000_000_000,
    });
    return { store, sent, erasure };
  }

  it("records a durable obligation and submits only the proof and this device's anonymous ids", async () => {
    const { sent, erasure, store } = service(() => ({ state: "requested" }));
    expect(await erasure.withdrawal()).toBe("none");
    expect(await erasure.record(permission, 2)).toBe(true);
    expect(await erasure.owns(ORIGIN)).toBe(true);
    expect(await erasure.owns(TEST_PERMISSION.origin)).toBe(false);
    await erasure.kick();
    expect(sent).toEqual([
      {
        action: "device",
        originProof: await originProof(ORIGIN),
        anonymousIds: [
          TEST_PERMISSION.provider.anonymousId,
          await deriveAnonymousId(ORIGIN, 1),
          await deriveAnonymousId(ORIGIN, 2),
        ],
      },
    ]);
    // NEGATIVE CONTROL (consent handle): the request never carries the origin.
    expect(JSON.stringify(sent)).not.toContain(ORIGIN);
    expect(await erasure.withdrawal()).toBe("requested");
    expect((store.data[ERASURE_LEDGER_KEY] as unknown[]).length).toBe(1);
  });

  it("a failed send reads as failed with retry; status then follows the server to deleted", async () => {
    let offline = true;
    let stage = "requested";
    const { sent, erasure } = service((body) => {
      if (offline) throw new Error("offline");
      return { state: body.action === "device" ? "requested" : stage };
    });
    await erasure.record(permission, 0);
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
    // Deleted is final: no more requests, and the cleanup stays owned.
    const before = sent.length;
    await erasure.kick();
    expect(sent.length).toBe(before);
    expect(await erasure.owns(ORIGIN)).toBe(true);
    expect(sent.map((b) => b.action)).toEqual(["device", "device", "status", "status"]);
  });

  it("a server with no record gets the request again; an unreadable reply is never success", async () => {
    let reply: unknown = { state: "none" };
    const { sent, erasure } = service(() => reply);
    await erasure.record(permission, 0);
    await erasure.kick(); // submit → "none" keeps it unsent
    await erasure.kick();
    expect(sent.map((b) => b.action)).toEqual(["device", "device"]);
    reply = { state: "done" };
    await erasure.kick();
    expect(await erasure.withdrawal()).toBe("failed");
    const unconfigured = createErasureService({ store: memory() });
    await unconfigured.record(permission, 0);
    await unconfigured.kick();
    expect(await unconfigured.withdrawal()).toBe("failed");
  });

  it("refuses to record what storage does not keep", async () => {
    const erasure = createErasureService({
      store: { get: async () => undefined, set: async () => {} },
    });
    expect(await erasure.record(permission, 0)).toBe(false);
    expect(await erasure.owns(ORIGIN)).toBe(false);
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
