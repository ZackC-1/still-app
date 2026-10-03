import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsClient,
  QUEUE_KEY,
  STATE_KEY,
  type AnalyticsClientDeps,
} from "../client.js";
import {
  CONSENT_KEY,
  createStoredConsent,
  PRIVACY_CAPABILITIES,
  readAnalyticsPermission,
  type AnalyticsPermission,
} from "../consent.js";
import {
  canonicalEvent,
  EVENT_SCHEMA,
  isAppClientEvent,
  validateEvent,
} from "../events.js";
import {
  createExtensionAnalyticsHost,
  ANALYTICS_MESSAGE_KIND,
} from "../extension-host.js";
import {
  TEST_PERMISSION,
  TEST_PRIVACY,
  TEST_PRIVACY_POLICY,
} from "./privacy-fixture.js";

const ID = {
  installId: "11111111-1111-4111-8111-111111111111",
  anchorId: "22222222-2222-4222-8222-222222222222",
  created: false,
  returning: false,
};
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function gate() {
  let open!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>((r) => (entered = r));
  const waiting = new Promise<void>((r) => (open = r));
  return {
    reached,
    open,
    wait: async () => {
      entered();
      await waiting;
    },
  };
}
function memory(missing: null | undefined = undefined) {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k: string) =>
      structuredClone(data[k] === undefined ? missing : data[k]),
    set: async (k: string, v: unknown) => {
      data[k] = structuredClone(v);
    },
  };
}
function harness(over: Partial<AnalyticsClientDeps> = {}) {
  const store = memory();
  const bodies: {
    batch: { event: string; properties: Record<string, unknown> }[];
  }[] = [];
  const sink = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  });
  const identity = vi.fn(async () => ID);
  const deps: AnalyticsClientDeps = {
    ...TEST_PRIVACY,
    config: { key: "test", host: "https://us.i.posthog.com" },
    surface: "chrome",
    appVersion: "3.0.0",
    store,
    identity,
    consent: async () => true,
    fetch: sink as typeof fetch,
    now: () => 1_780_000_000_000,
    uuid: () => crypto.randomUUID(),
    schedule: () => {},
    ...over,
  };
  return {
    client: new AnalyticsClient(deps),
    deps,
    store,
    identity,
    sink,
    bodies,
  };
}

describe("reviewed recovery", () => {
  it("cancels the primary and derived host actions under the original account", async () => {
    const paused = gate();
    let hold = false;
    const h = harness({
      identity: async () => {
        if (hold) {
          hold = false;
          await paused.wait();
        }
        return ID;
      },
    });
    const attach = vi.fn(async () => {});
    const host = createExtensionAnalyticsHost({
      ...h.deps,
      permission: async () =>
        readAnalyticsPermission(await h.deps.permission?.()),
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
      identifyOnServer: attach,
    });
    host.onStart(A);
    await host.flushWhenReady();
    hold = true;
    const response = new Promise((resolve) =>
      host.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        {},
        resolve,
      ),
    );
    await paused.reached;
    const changing = host.identify(B, { quiet: true });
    paused.open();
    await changing;
    await response;
    await host.flushWhenReady();
    expect(h.bodies.flatMap((b) => b.batch)).toEqual([]);
    expect(attach).not.toHaveBeenCalled();
    host.stop();
  });
  it("captures ordinary install permission before a same-turn grant", async () => {
    let permission: AnalyticsPermission | null = null;
    const h = harness({ permission: async () => permission });
    const host = createExtensionAnalyticsHost({
      ...h.deps,
      permission: async () =>
        readAnalyticsPermission(await h.deps.permission?.()),
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
    });
    host.onInstalled({ reason: "install" });
    permission = TEST_PERMISSION;
    await new Promise((r) => setTimeout(r, 0));
    expect(await host.client.queuedCount()).toBe(0);
    expect(h.identity).not.toHaveBeenCalled();
    host.stop();
  });
  it.each(["activity", "install"] as const)(
    "cancels every derived %s milestone under the original account",
    async (action) => {
      const paused = gate();
      let calls = 0;
      let holdAt = 0;
      const h = harness({
        surface: action === "activity" ? "safari-ios" : "chrome",
        identity: async () => {
          calls += 1;
          if (calls === holdAt) await paused.wait();
          return ID;
        },
      });
      const host = createExtensionAnalyticsHost({
        ...h.deps,
        permission: async () =>
          readAnalyticsPermission(await h.deps.permission?.()),
        local: h.store,
        noticeApplies: false,
        isTrustedPage: () => true,
      });
      host.onStart(A);
      await host.flushWhenReady();
      holdAt = calls + (action === "install" ? 2 : 1);
      if (action === "install") host.onInstalled({ reason: "install" });
      else host.onActivity();
      await paused.reached;
      const changed = host.identify(B, { quiet: true });
      paused.open();
      await changed;
      await new Promise((r) => setTimeout(r, 0));
      await host.flushWhenReady();
      expect(h.bodies.flatMap((b) => b.batch)).toEqual([]);
      expect(await host.client.queuedCount()).toBe(0);
      expect(await host.client.hasTrackedOnce("setup_completed")).toBe(false);
      host.stop();
    },
  );
  it.each(["track", "start"] as const)(
    "keeps the Apple %s chain under its original account",
    async (action) => {
      const { createAppAnalytics } = await import("../apple-app.js");
      const paused = gate();
      const store = memory();
      let hold = false;
      const attach = vi.fn(async () => {});
      const app = createAppAnalytics({
        ...TEST_PRIVACY,
        config: { key: "test", host: "https://us.i.posthog.com" },
        store: {
          set: store.set,
          get: async (k) => {
            if (hold && k === STATE_KEY) {
              hold = false;
              await paused.wait();
            }
            return store.get(k);
          },
        },
        fetch: (async () => {
          throw Error("offline");
        }) as typeof fetch,
        identifyOnServer: attach,
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
      await app.identifyAccount(A);
      // Settle the initial attach, then clear its positive-control call.
      await new Promise((r) => setTimeout(r, 0));
      expect(attach).toHaveBeenCalledTimes(1);
      attach.mockClear();
      hold = true;
      const started =
        action === "start"
          ? app.start()
          : (app.ui.track("opened", { where: "app" }), Promise.resolve());
      await paused.reached;
      const changed = app.identifyAccount(B);
      // The real host's ready() continuation asks the client to cancel before releasing storage.
      await new Promise((r) => setTimeout(r, 0));
      paused.open();
      await changed;
      await started;
      await new Promise((r) => setTimeout(r, 0));
      const events = (store.data[QUEUE_KEY] ?? []) as { event: string }[];
      expect(events).toEqual([]);
      // B's actual account confirmation may attach once; the superseded action cannot add work.
      expect(attach).toHaveBeenCalledTimes(1);
    },
  );
  it("repeated Apple Share retains the actual granted origin", async () => {
    const { createAppAnalytics } = await import("../apple-app.js");
    const authority = memory();
    const consent = createStoredConsent(authority, false);
    await consent.grant(TEST_PERMISSION.version);
    const original = await consent.read();
    const store = memory();
    const app = createAppAnalytics({
      ...TEST_PRIVACY,
      config: { key: "test", host: "https://us.i.posthog.com" },
      store,
      permission: () => consent.read(),
      commitPermission: async (enabled) =>
        enabled ? consent.grant(TEST_PERMISSION.version) : consent.set(false),
      fetch: (async () => {
        throw Error("offline");
      }) as typeof fetch,
      bridge: {
        analyticsContext: async () => ({
          ...ID,
          platform: "macos",
          device: "desktop",
          appVersion: "3.0.0",
          previousVersion: null,
          consent: await consent.get(),
          noticeSeen: true,
          extensionEnabled: true,
        }),
        setAnalyticsConsent: async () => false,
        acknowledgeAnalyticsNotice: async () => {},
      },
    });
    await app.identifyAccount(A);
    expect((await app.ui.sharing!())?.enabled).toBe(true);
    expect(await app.ui.setSharing!(true)).toBe(true);
    expect(await app.ui.setSharing!(true)).toBe(true);
    expect(await consent.read()).toEqual(original);
    app.ui.track("opened", { where: "app" });
    await new Promise((r) => setTimeout(r, 0));
    const queued = store.data[QUEUE_KEY] as {
      event: string;
      attributeLater?: boolean;
      properties: Record<string, unknown>;
    }[];
    expect(queued.find((e) => e.event === "opened")).toMatchObject({
      properties: { distinct_id: A },
    });
    expect(queued.some((e) => e.attributeLater)).toBe(false);
  });
  it("a failed Apple Off preserves durable stopped-origin authority across reopening", async () => {
    const { createAppAnalytics } = await import("../apple-app.js");
    const store = memory();
    const deps = {
      ...TEST_PRIVACY,
      config: { key: "test", host: "https://us.i.posthog.com" },
      store,
      commitPermission: async () => {
        throw Error("permission store unavailable");
      },
      fetch: (async () => {
        throw Error("offline");
      }) as typeof fetch,
      bridge: {
        analyticsContext: async () => ({
          ...ID,
          platform: "macos" as const,
          device: "desktop" as const,
          appVersion: "3.0.0",
          previousVersion: null,
          consent: true,
          noticeSeen: true,
          extensionEnabled: true,
        }),
        setAnalyticsConsent: async () => false,
        acknowledgeAnalyticsNotice: async () => {},
      },
    };
    const first = createAppAnalytics(deps);
    await first.identifyAccount(A);
    first.ui.track("opened", { where: "app" });
    await new Promise((r) => setTimeout(r, 0));
    expect((store.data[QUEUE_KEY] as unknown[]).length).toBeGreaterThan(0);
    expect(await first.ui.setSharing!(false)).toBe(false);
    expect(store.data[QUEUE_KEY]).toEqual([]);
    const reopened = createAppAnalytics(deps);
    expect((await reopened.ui.sharing!())?.enabled).toBe(false);
  });
  it.each([false, true])(
    "raw malformed forgotten events retain debt if purge is lost: %s",
    async (refuse) => {
      const queue = memory();
      let lose = false;
      const h = harness({
        queueStore: {
          get: queue.get,
          set: async (k, v) => {
            if (!lose) await queue.set(k, v);
          },
        },
      });
      await h.client.identify(A);
      await h.client.track("active", {});
      const valid = (queue.data[QUEUE_KEY] as Record<string, unknown>[])[0]!;
      queue.data[QUEUE_KEY] = [
        { ...valid, event: null },
        { unclassifiable: true },
      ];
      lose = refuse;
      await h.client.confirm(null, { forget: true, quiet: true });
      if (refuse) {
        expect(h.store.data[STATE_KEY]).toMatchObject({ forgotten: [A] });
        expect(queue.data[QUEUE_KEY]).toHaveLength(2);
        lose = false;
        await h.client.flush();
      }
      expect(queue.data[QUEUE_KEY]).toEqual([]);
      expect(h.store.data[STATE_KEY]).toMatchObject({ forgotten: [] });
      expect(h.sink).not.toHaveBeenCalled();
    },
  );
  it("recovers the real still-granted origin after an unavailable read and restart", async () => {
    const authority = memory();
    const consent = createStoredConsent(authority, false);
    await consent.grant(TEST_PERMISSION.version);
    const permission = await consent.read();
    let unavailable = false;
    const h = harness({
      permission: async () => (unavailable ? null : consent.read()),
      consent: () => consent.get(),
    });
    await h.client.track("opened", { where: "popup" });
    expect(await h.client.queuedCount()).toBe(1);
    unavailable = true;
    expect(await h.client.canReport()).toBe(false);
    expect(await h.client.queuedCount()).toBe(0);
    unavailable = false;
    const reopened = new AnalyticsClient(h.deps);
    expect(await reopened.canReport()).toBe(true);
    await reopened.track("active", {});
    await reopened.flush();
    expect(h.bodies.flatMap((b) => b.batch).map((e) => e.event)).toEqual([
      "active",
    ]);
    expect(await consent.read()).toEqual(permission);
  });
  it("raw account erasure retains records positively owned by another account", async () => {
    const h = harness();
    await h.client.identify(A);
    await h.client.track("active", {}, { quiet: true });
    const source = (h.store.data[QUEUE_KEY] as { properties: Record<string, unknown> }[])[0]!;
    const other = { ...source, event: null, properties: { ...source.properties, distinct_id: B } };
    h.store.data[QUEUE_KEY] = [{ ...source, event: null }, other, { unclassifiable: true }];
    await h.client.confirm(null, { forget: true, quiet: true });
    expect(h.store.data[QUEUE_KEY]).toEqual([other]);
    expect(h.store.data[STATE_KEY]).toMatchObject({ forgotten: [] });
    expect(h.sink).not.toHaveBeenCalled();
  });
  it("normal host stop does not revoke an installed granted origin", async () => {
    const h = harness();
    const deps = {
      ...h.deps,
      permission: async () =>
        readAnalyticsPermission(await h.deps.permission?.()),
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
    };
    const first = createExtensionAnalyticsHost(deps);
    first.onStart(null);
    await first.flushWhenReady();
    expect(await first.client.canReport()).toBe(true);
    first.stop();
    await first.client.queuedCount();
    const next = createExtensionAnalyticsHost(deps);
    next.onStart(null);
    await next.flushWhenReady();
    expect(await next.client.canReport()).toBe(true);
    next.stop();
  });
  it.each(["consent", "capability", "read"] as const)(
    "temporary %s absence keeps durable purge debt and the live authority",
    async (absence) => {
      const authority = memory();
      const consent = createStoredConsent(authority, false);
      await consent.grant(TEST_PERMISSION.version);
      const permission = await consent.read();
      const queue = memory();
      let unavailable = false;
      let refuse = false;
      const capabilities = { ...TEST_PRIVACY_POLICY.capabilities };
      const h = harness({
        privacyPolicy: { ...TEST_PRIVACY_POLICY, capabilities },
        permission: async () => {
          if (unavailable && absence === "read") throw Error("temporary");
          return consent.read();
        },
        consent: async () =>
          unavailable && absence === "consent" ? false : consent.get(),
        queueStore: {
          get: queue.get,
          set: async (k, v) => {
            if (!refuse) await queue.set(k, v);
          },
        },
      });
      await h.client.track("opened", { where: "popup" });
      expect(queue.data[QUEUE_KEY]).toHaveLength(1);
      unavailable = true;
      refuse = true;
      if (absence === "capability") delete capabilities.device_slice_erasure;
      expect(await h.client.canReport()).toBe(false);
      expect(h.store.data[STATE_KEY]).toMatchObject({
        permission,
        stopPending: true,
        stoppedOrigin: null,
      });
      unavailable = false;
      capabilities.device_slice_erasure =
        TEST_PRIVACY_POLICY.capabilities.device_slice_erasure;
      const reopened = new AnalyticsClient(h.deps);
      expect(await reopened.canReport()).toBe(false);
      expect(h.sink).not.toHaveBeenCalled();
      refuse = false;
      expect(await reopened.canReport()).toBe(true);
      expect(queue.data[QUEUE_KEY]).toEqual([]);
      await reopened.track("active", {});
      await reopened.flush();
      expect(h.bodies.flatMap((b) => b.batch).map((e) => e.event)).toEqual([
        "active",
      ]);
      expect(await consent.read()).toEqual(permission);
    },
  );
  it("repeated Share preserves real combined consent and can report a new choice", async () => {
    const authority = memory();
    const consent = createStoredConsent(authority, false);
    await consent.grant(TEST_PERMISSION.version);
    const original = await consent.read();
    const h = harness({
      permission: () => consent.read(),
      consent: () => consent.get(),
    });
    const host = createExtensionAnalyticsHost({
      ...h.deps,
      permission: async () =>
        readAnalyticsPermission(await h.deps.permission?.()),
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
      commitPermission: async (enabled) =>
        enabled ? consent.grant(TEST_PERMISSION.version) : consent.set(false),
    });
    host.onStart(null);
    await host.flushWhenReady();
    for (let i = 0; i < 2; i++) {
      const response = new Promise((resolve) =>
        host.listener(
          { kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: true },
          {},
          resolve,
        ),
      );
      expect(await response).toBe(true);
      expect(await consent.read()).toEqual(original);
    }
    expect(await host.client.canReport()).toBe(true);
    host.stop();
  });
  it.each([false, true])(
    "retires attributed obsolete account generations without sending them: %s",
    async (refuse) => {
      const queue = memory();
      let lose = false;
      const h = harness({
        queueStore: {
          get: queue.get,
          set: async (k, v) => {
            if (!lose) await queue.set(k, v);
          },
        },
      });
      await h.client.identify(A);
      await h.client.track("opened", { where: "popup" });
      expect(await h.client.queuedCount()).toBe(1);
      await h.client.identify(B);
      lose = refuse;
      await h.client.flush();
      expect(h.sink).not.toHaveBeenCalled();
      if (refuse) {
        expect(queue.data[QUEUE_KEY]).toHaveLength(1);
        lose = false;
        await h.client.flush();
      }
      expect(await h.client.queuedCount()).toBe(0);
      await h.client.track("signed_in", {});
      await h.client.flush();
      expect(h.bodies.flatMap((b) => b.batch).map((e) => e.event)).toEqual([
        "signed_in",
      ]);
    },
  );
});

describe("fresh combined permission", () => {
  it.each([undefined, null])(
    "an undecided install allocates nothing with a missing-key value of %s",
    async (missing) => {
      const store = memory(missing);
      const writes = vi.spyOn(store, "set");
      const h = harness({ store, permission: undefined });
      expect(await h.client.canReport()).toBe(false);
      await h.client.identify(A);
      await h.client.track("active", {});
      await h.client.flush();
      expect(writes).not.toHaveBeenCalled();
      expect(store.data).toEqual({});
      expect(h.identity).not.toHaveBeenCalled();
      expect(h.sink).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    true,
    false,
    {},
    { ...TEST_PERMISSION, purposes: { usage: true, email: false, ai: true } },
    { ...TEST_PERMISSION, version: "b".repeat(64) },
    { ...TEST_PERMISSION, state: "stopped" },
  ])(
    "holds %j without optional identity, backlog or network",
    async (permission) => {
      const h = harness({ permission: async () => permission });
      await h.client.track("active", {});
      await h.client.identify(A);
      await h.client.flush();
      expect(h.identity).not.toHaveBeenCalled();
      expect(h.sink).not.toHaveBeenCalled();
      expect(h.store.data).toEqual({});
    },
  );
  it.each(PRIVACY_CAPABILITIES)(
    "holds a missing %s capability",
    async (name) => {
      const capabilities = { ...TEST_PRIVACY_POLICY.capabilities };
      delete capabilities[name];
      const h = harness({
        privacyPolicy: { ...TEST_PRIVACY_POLICY, capabilities },
      });
      await h.client.track("active", {});
      await h.client.flush();
      expect(h.identity).not.toHaveBeenCalled();
      expect(h.sink).not.toHaveBeenCalled();
      expect(h.store.data).toEqual({});
    },
  );
  it.each(["private", "unknown"] as const)(
    "holds %s contexts",
    async (context) => {
      const h = harness({ privacyPolicy: { ...TEST_PRIVACY_POLICY, context } });
      await h.client.track("active", {});
      await h.client.flush();
      expect(h.identity).not.toHaveBeenCalled();
      expect(h.store.data).toEqual({});
      expect(h.sink).not.toHaveBeenCalled();
    },
  );
  it("uses one authority, rejects old On, records a fresh origin and keeps the stop tombstone", async () => {
    const store = memory();
    store.data[CONSENT_KEY] = true;
    const consent = createStoredConsent(store, true);
    expect(await consent.get()).toBe(false);
    await expect(consent.set(true)).rejects.toThrow("Fresh combined");
    await consent.grant(TEST_PERMISSION.version);
    const permission = await consent.read();
    expect(permission?.state).toBe("granted");
    expect(permission?.purposes).toEqual({
      usage: true,
      email: true,
      ai: true,
    });
    await consent.grant(TEST_PERMISSION.version);
    expect(await consent.read()).toEqual(permission);
    const stopping = consent.set(false);
    expect(await consent.get()).toBe(false);
    await stopping;
    const tombstone = readAnalyticsPermission(store.data[CONSENT_KEY]);
    expect(tombstone).toMatchObject({
      state: "stopped",
      origin: permission!.origin,
      generation: permission!.generation + 1,
    });
    await expect(consent.grant(TEST_PERMISSION.version)).rejects.toThrow(
      "cleanup is pending",
    );
    expect(store.data[CONSENT_KEY]).toEqual(tombstone);
  });
  it("a failed stop persists a local hold and never revives consent", async () => {
    const store = memory();
    store.data[CONSENT_KEY] = TEST_PERMISSION;
    const consent = createStoredConsent(
      {
        get: store.get,
        set: async () => {
          throw Error("io");
        },
      },
      true,
    );
    await expect(consent.set(false)).rejects.toThrow("io");
    expect(await consent.get()).toBe(false);
  });
});

describe("observation and transport authority", () => {
  it("never admits an action observed before a later permission grant", async () => {
    let permission: AnalyticsPermission | null = null;
    const h = harness({ permission: async () => permission });
    const early = h.client.track("opened", { where: "popup" });
    permission = TEST_PERMISSION;
    await early;
    expect(h.identity).not.toHaveBeenCalled();
    await h.client.track("active", {});
    await h.client.flush();
    expect(h.bodies.flatMap((b) => b.batch).map((e) => e.event)).toEqual([
      "active",
    ]);
  });
  it("stops before a delayed identity completion can append", async () => {
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      identity: async () => {
        reached();
        await gate;
        return ID;
      },
    });
    const tracking = h.client.track("active", {});
    await entered;
    h.client.permissionChanged();
    const clearing = h.client.clearQueue();
    release();
    await tracking;
    await clearing;
    expect(h.store.data[QUEUE_KEY] ?? []).toEqual([]);
    expect(h.sink).not.toHaveBeenCalled();
  });
  it("aborts an in-flight request immediately, emits no farewell and clears the backlog", async () => {
    let signal: AbortSignal | null = null;
    let reached!: () => void;
    const entered = new Promise<void>((r) => (reached = r));
    const h = harness({
      fetch: (async (_url, init) => {
        signal = init?.signal as AbortSignal;
        reached();
        await new Promise<void>((_, reject) =>
          signal!.addEventListener("abort", () => reject(Error("aborted")), {
            once: true,
          }),
        );
        throw Error("aborted");
      }) as typeof fetch,
    });
    await h.client.track("active", {});
    const flushing = h.client.flush();
    await entered;
    const stopping = h.client.sendOptOut();
    expect(signal!.aborted).toBe(true);
    await flushing;
    await stopping;
    expect(h.store.data[QUEUE_KEY]).toEqual([]);
  });
  it("persists purge debt and holds a restarted client until both stores verify removal", async () => {
    const queue = memory();
    let refuse = false;
    const queueStore = {
      get: queue.get,
      set: async (k: string, v: unknown) => {
        if (refuse) return;
        await queue.set(k, v);
      },
    };
    const h = harness({ queueStore });
    await h.client.track("active", {});
    refuse = true;
    await h.client.clearQueue();
    expect(h.store.data[STATE_KEY]).toMatchObject({ stopPending: true });
    const restart = new AnalyticsClient(h.deps);
    await restart.flush();
    expect(h.sink).not.toHaveBeenCalled();
    refuse = false;
    await restart.flush();
    expect(queue.data[QUEUE_KEY]).toEqual([]);
    expect(h.sink).not.toHaveBeenCalled();
  });
  it.each(["null", "unreadable"] as const)(
    "%s after an acknowledged purge keeps debt until an explicit empty queue is read",
    async (missing) => {
      const queue = memory(null);
      let lose = false;
      const h = harness({
        queueStore: {
          get: async (key) => {
            if (lose && key === QUEUE_KEY) {
              if (missing === "unreadable") throw Error("unavailable");
              return null;
            }
            return queue.get(key);
          },
          set: async (key, value) => {
            if (!lose) await queue.set(key, value);
          },
        },
      });
      await h.client.track("active", {});
      const original = structuredClone(queue.data[QUEUE_KEY]);
      expect(original).toHaveLength(1);
      lose = true;
      await h.client.clearQueue(false);
      expect(h.store.data[STATE_KEY]).toMatchObject({ stopPending: true });
      const restart = new AnalyticsClient(h.deps);
      expect(await restart.canReport()).toBe(false);
      await restart.track("opened", { where: "popup" });
      await restart.flush();
      expect(h.store.data[STATE_KEY]).toMatchObject({ stopPending: true });
      expect(queue.data[QUEUE_KEY]).toEqual(original);
      expect(h.sink).not.toHaveBeenCalled();
      lose = false;
      expect(await restart.canReport()).toBe(true);
      expect(queue.data[QUEUE_KEY]).toEqual([]);
      expect(h.store.data[STATE_KEY]).toMatchObject({ stopPending: false });
      await restart.confirm(null, { quiet: true });
      await restart.track("opened", { where: "popup" });
      await restart.flush();
      expect(
        h.bodies.flatMap((body) => body.batch).map((event) => event.event),
      ).toEqual(["opened"]);
    },
  );
  it("a stale account observation cannot flush a current account's queued event", async () => {
    const h = harness();
    await h.client.identify(A);
    const stale = await h.client.captureObservation();
    expect(stale).not.toBeNull();
    await h.client.identify(B);
    await h.client.track("opened", { where: "popup" });
    const waiting = structuredClone(h.store.data[QUEUE_KEY]);
    expect(waiting).toHaveLength(1);
    await h.client.flush(stale!);
    expect(h.sink).not.toHaveBeenCalled();
    expect(h.store.data[QUEUE_KEY]).toEqual(waiting);
    const current = await h.client.captureObservation();
    expect(current).not.toBeNull();
    await h.client.flush(current!);
    expect(h.bodies.flatMap((body) => body.batch)).toMatchObject([
      { event: "opened", properties: { distinct_id: B } },
    ]);
    expect(h.store.data[QUEUE_KEY]).toEqual([]);
  });
  it("a null queue read cannot discharge a forgotten account's erasure debt", async () => {
    const queue = memory();
    let lose = false;
    const h = harness({
      queueStore: {
        get: async (key) => (lose ? null : queue.get(key)),
        set: async (key, value) => {
          if (!lose) await queue.set(key, value);
        },
      },
    });
    await h.client.identify(A);
    await h.client.track("active", {});
    const original = structuredClone(queue.data[QUEUE_KEY]);
    expect(original).toHaveLength(1);
    lose = true;
    await h.client.confirm(null, { forget: true, quiet: true });
    expect(h.store.data[STATE_KEY]).toMatchObject({ forgotten: [A] });
    const restart = new AnalyticsClient(h.deps);
    await restart.flush();
    expect(h.store.data[STATE_KEY]).toMatchObject({ forgotten: [A] });
    expect(queue.data[QUEUE_KEY]).toEqual(original);
    expect(h.sink).not.toHaveBeenCalled();
    lose = false;
    await restart.flush();
    expect(h.store.data[STATE_KEY]).toMatchObject({ forgotten: [] });
    expect(queue.data[QUEUE_KEY]).toEqual([]);
    expect(h.sink).not.toHaveBeenCalled();
  });
  it("A to B to A never makes the old A batch eligible again", async () => {
    const h = harness();
    await h.client.identify(A);
    await h.client.track("opened", { where: "popup" });
    await h.client.identify(B);
    await h.client.identify(A);
    await h.client.track("signed_in", {});
    await h.client.flush();
    expect(h.bodies.flatMap((b) => b.batch).map((e) => e.event)).toEqual([
      "signed_in",
    ]);
  });
  it("revalidates queued data and never emits person updates or private permission metadata", async () => {
    const h = harness();
    await h.client.track("active", {});
    const queue = h.store.data[QUEUE_KEY] as {
      properties: Record<string, unknown>;
    }[];
    queue.push({
      ...structuredClone(queue[0]!),
      properties: {
        ...queue[0]!.properties,
        $set: { email: "forbidden@example.test" },
      },
    });
    await h.client.flush();
    expect(h.bodies.flatMap((b) => b.batch)).toHaveLength(1);
    const sent = JSON.stringify(h.bodies);
    expect(sent).not.toContain("email");
    expect(sent).not.toContain("permission");
    expect(sent).not.toContain(TEST_PERMISSION.origin);
  });
  it("a trusted private popup cannot report through the host", async () => {
    const h = harness();
    const host = createExtensionAnalyticsHost({
      ...h.deps,
      ...TEST_PRIVACY,
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
    });
    expect(
      host.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "active",
          props: {},
        },
        { incognito: true },
        () => {},
      ),
    ).toBe(false);
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.sink).not.toHaveBeenCalled();
  });
});

describe("closed V3 catalogue", () => {
  it("contains exactly 42 declared events and one canonical master producer", () => {
    expect(Object.keys(EVENT_SCHEMA)).toHaveLength(42);
    expect(
      validateEvent("service_toggled", {
        service: "youtube",
        enabled: true,
        where: "popup",
      }),
    ).toBeNull();
    expect(
      canonicalEvent("service_toggled", {
        service: "youtube",
        enabled: true,
        where: "popup",
      }),
    ).toEqual({
      name: "master_toggled",
      props: {
        site: "youtube",
        enabled: true,
        where: "popup",
        cause: "direct",
      },
    });
  });
  it.each(Object.entries(EVENT_SCHEMA))(
    "validates %s and rejects undeclared free text",
    (name, schema) => {
      const props = Object.fromEntries(
        Object.entries(schema).map(([key, spec]) => [
          key,
          spec === "boolean" ? true : spec === "version" ? "3.0.0" : spec[0],
        ]),
      );
      if (name === "paywall_viewed" || name === "paywall_dismissed")
        props.trigger = "upgrade_button";
      expect(validateEvent(name, props)).toEqual(props);
      expect(
        validateEvent(name, {
          ...props,
          url: "https://youtube.com/shorts/private",
        }),
      ).toBeNull();
    },
  );
  it("requires the locked switch to belong to its declared site", () => {
    const valid = {
      trigger: "locked_switch",
      where: "options",
      site: "youtube",
      switch: "youtube.shorts",
    };
    expect(validateEvent("paywall_viewed", valid)).toEqual(valid);
    expect(
      validateEvent("paywall_viewed", {
        trigger: "locked_switch",
        where: "options",
      }),
    ).toBeNull();
    expect(
      validateEvent("paywall_viewed", { ...valid, trigger: "upgrade_button" }),
    ).toBeNull();
    expect(
      validateEvent("paywall_viewed", { ...valid, site: "instagram" }),
    ).toBeNull();
    expect(isAppClientEvent("purchase_recorded")).toBe(false);
    expect(isAppClientEvent("purchase_refunded")).toBe(false);
    expect(isAppClientEvent("account_created")).toBe(false);
  });
});

describe("actual hosts and permission-origin lifetime", () => {
  it("a trusted master action reaches the mocked sink once under the canonical name", async () => {
    const h = harness();
    const host = createExtensionAnalyticsHost({
      ...h.deps,
      ...TEST_PRIVACY,
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
    });
    host.onStart(null);
    await host.flushWhenReady();
    const result = await new Promise((r) =>
      host.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "service_toggled",
          props: { service: "instagram", enabled: false, where: "popup" },
        },
        {},
        r,
      ),
    );
    expect(result).toBe(true);
    await host.flushWhenReady();
    const events = h.bodies.flatMap((b) => b.batch);
    expect(events.map((e) => e.event)).toEqual(["master_toggled", "active"]);
    expect(events[0]!.properties).toMatchObject({
      site: "instagram",
      enabled: false,
      cause: "direct",
      where: "popup",
      build_channel: "test",
    });
    expect(JSON.stringify(events)).not.toContain("service_toggled");
  });
  it("provider IDs survive a same-origin restart and differ after confirmed cleanup plus a fresh grant", async () => {
    const authority = memory();
    const consent = createStoredConsent(authority, false);
    await consent.grant(TEST_PERMISSION.version);
    const first = (await consent.read())!;
    const h = harness({ permission: consent.read });
    await h.client.track("active", {});
    await h.client.flush();
    const restart = new AnalyticsClient(h.deps);
    await restart.track("opened", { where: "popup" });
    await restart.flush();
    const initial = h.bodies.flatMap((b) => b.batch);
    expect(initial.map((e) => e.properties.distinct_id)).toEqual([
      first.provider.anonymousId,
      first.provider.anonymousId,
    ]);
    expect(
      initial.every((e) => e.properties.$device_id === first.provider.deviceId),
    ).toBe(true);
    expect(JSON.stringify(initial)).not.toContain(ID.installId);
    await consent.set(false);
    await restart.clearQueue();
    // Test-only confirmed-cleanup simulation; no provider operation or erasure proof is inferred.
    delete authority.data[CONSENT_KEY];
    await consent.grant(TEST_PERMISSION.version);
    const next = (await consent.read())!;
    expect(next.origin).not.toBe(first.origin);
    expect(next.provider.anonymousId).not.toBe(first.provider.anonymousId);
    expect(next.provider.deviceId).not.toBe(first.provider.deviceId);
    await restart.track("signed_in", {});
    await restart.flush();
    const last = h.bodies.at(-1)!.batch;
    expect(last).toHaveLength(1);
    expect(last[0]!.properties.distinct_id).toBe(next.provider.anonymousId);
    expect(JSON.stringify(last)).not.toContain(first.provider.deviceId);
    expect(JSON.stringify(last)).not.toContain("$anon_distinct_id");
  });
  it("a failed Off persistence cannot revive its old granted origin in a fresh client", async () => {
    const h = harness();
    await h.client.track("active", {});
    await h.client.clearQueue();
    // Authority deliberately still returns the old grant, as if its Off write failed.
    const restart = new AnalyticsClient(h.deps);
    await restart.track("opened", { where: "popup" });
    await restart.flush();
    expect(h.sink).not.toHaveBeenCalled();
    expect(h.store.data[QUEUE_KEY]).toEqual([]);
    expect(h.store.data[STATE_KEY]).toMatchObject({
      stoppedOrigin: TEST_PERMISSION.origin,
    });
  });
  it("raw malformed waiting records cannot masquerade as verified erasure", async () => {
    const queue = memory();
    let refuse = false;
    const queueStore = {
      get: queue.get,
      set: async (k: string, value: unknown) => {
        if (!refuse) await queue.set(k, value);
      },
    };
    const h = harness({ queueStore });
    await h.client.track("active", {});
    queue.data[QUEUE_KEY] = [null, { secret: "private invalid record" }];
    refuse = true;
    await h.client.clearQueue();
    expect(h.store.data[STATE_KEY]).toMatchObject({ stopPending: true });
    const restart = new AnalyticsClient(h.deps);
    await restart.flush();
    expect(h.sink).not.toHaveBeenCalled();
    expect(queue.data[QUEUE_KEY]).toEqual([
      null,
      { secret: "private invalid record" },
    ]);
  });
  it("account replacement aborts optional email attachment and cannot mark a late completion", async () => {
    const { createAccountIdentifier, SERVER_IDENTIFIED_KEY } = await import("../extension-host.js");
    const h = harness();
    await h.client.identify(A);
    let reached!: () => void;
    const entered = new Promise<void>((r) => (reached = r));
    let signal: AbortSignal | undefined;
    const accounts = createAccountIdentifier({
      client: h.client,
      local: h.store,
      consent: async () => true,
      identifyOnServer: async (s) => {
        signal = s;
        reached();
        await new Promise(() => {});
      },
    });
    const attaching = accounts.attach();
    await entered;
    const change = h.client.identify(B);
    expect(signal!.aborted).toBe(true);
    await attaching;
    await change;
    expect(h.store.data[SERVER_IDENTIFIED_KEY]).toBeUndefined();
  });
});

describe("waiting optional callbacks stay fenced", () => {
  it("revocation during a permission read drops the observed action", async () => {
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((r) => (reached = r));
    const wait = new Promise<void>((r) => (release = r));
    const h = harness({
      permission: async () => {
        reached();
        await wait;
        return TEST_PERMISSION;
      },
    });
    const pending = h.client.track("active", {});
    await entered;
    h.client.permissionChanged();
    release();
    await pending;
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.sink).not.toHaveBeenCalled();
    expect(h.store.data).toEqual({});
  });
  it("revocation while a queue append is awaiting persistence retires it before any send", async () => {
    const queue = memory();
    let pause = false;
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      queueStore: {
        get: queue.get,
        set: async (k, value) => {
          if (pause) {
            pause = false;
            reached();
            await gate;
          }
          await queue.set(k, value);
        },
      },
    });
    expect(await h.client.canReport()).toBe(true);
    pause = true;
    const tracking = h.client.trackOnce("eligible", "active", {});
    await entered;
    const stopping = h.client.clearQueue();
    release();
    await tracking;
    await stopping;
    await h.client.flush();
    expect(h.sink).not.toHaveBeenCalled();
    expect(queue.data[QUEUE_KEY]).toEqual([]);
    expect(await h.client.hasTrackedOnce("eligible")).toBe(false);
  });
  it("a late Apple context cannot reconstruct an action after withdrawal", async () => {
    const { createAppAnalytics } = await import("../apple-app.js");
    const store = memory();
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const sink = vi.fn(async () => new Response("{}"));
    const app = createAppAnalytics({
      ...TEST_PRIVACY,
      config: { key: "test", host: "https://us.i.posthog.com" },
      store,
      fetch: sink,
      bridge: {
        analyticsContext: async () => {
          reached();
          await gate;
          return {
            ...ID,
            platform: "macos",
            device: "desktop",
            appVersion: "3.0.0",
            previousVersion: null,
            consent: true,
            noticeSeen: true,
            extensionEnabled: true,
          };
        },
        setAnalyticsConsent: async () => false,
        acknowledgeAnalyticsNotice: async () => {},
      },
    });
    app.ui.track("opened", { where: "app" });
    await entered;
    expect(await app.ui.setSharing!(false)).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(sink).not.toHaveBeenCalled();
    expect(store.data).toEqual({});
  });
});

describe("retiring old unattributed history", () => {
  it("a forget with no current permission never creates identity to attribute old waiting events", async () => {
    const h = harness({ permission: async () => null });
    h.store.data[STATE_KEY] = {
      userId: A,
      identifiedAs: null,
      daily: {},
      anonId: null,
      forgotten: [],
      permission: TEST_PERMISSION,
      accountGeneration: 1,
    };
    h.store.data[QUEUE_KEY] = [
      {
        event: "active",
        uuid: crypto.randomUUID(),
        timestamp: "2026-10-03T00:00:00.000Z",
        properties: {},
        attributeLater: true,
        permission: TEST_PERMISSION,
        accountGeneration: 1,
      },
    ];
    await h.client.confirm(null, { forget: true });
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.sink).not.toHaveBeenCalled();
    expect(h.store.data[QUEUE_KEY]).toEqual([]);
  });
});

describe("declared host producers", () => {
  it("an invalid page event never creates an active event or attaches email", async () => {
    const h = harness();
    const attach = vi.fn(async () => {});
    const host = createExtensionAnalyticsHost({
      ...h.deps,
      ...TEST_PRIVACY,
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
      identifyOnServer: attach,
    });
    host.onStart(null);
    await host.flushWhenReady();
    expect(
      host.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "active",
          props: { url: "https://youtube.com/shorts/private" },
        },
        {},
        () => {},
      ),
    ).toBe(false);
    expect(
      host.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "purchase_recorded",
          props: {},
        },
        {},
        () => {},
      ),
    ).toBe(false);
    await host.flushWhenReady();
    expect(h.sink).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(h.identity).not.toHaveBeenCalled();
  });
});

describe("acknowledged storage failures", () => {
  it("a scope write silently lost by storage never authorizes identity or transport", async () => {
    const backing = memory();
    const h = harness({ store: { get: backing.get, set: async () => {} } });
    await h.client.track("active", {});
    await h.client.flush();
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.sink).not.toHaveBeenCalled();
  });
  it("a silently lost append does not consume its once marker", async () => {
    const queue = memory();
    let refuse = false;
    const h = harness({
      queueStore: {
        get: queue.get,
        set: async (k, value) => {
          if (!refuse) await queue.set(k, value);
        },
      },
    });
    expect(await h.client.canReport()).toBe(true);
    refuse = true;
    await h.client.trackOnce("eligible", "active", {});
    expect(await h.client.hasTrackedOnce("eligible")).toBe(false);
    refuse = false;
    await h.client.trackOnce("eligible", "active", {});
    await h.client.flush();
    expect(h.bodies.flatMap((b) => b.batch).map((e) => e.event)).toEqual([
      "active",
    ]);
  });
  it("a silently lost account replacement remains unconfirmed and cannot attach the wrong account", async () => {
    const backing = memory();
    let refuse = false;
    const h = harness({
      store: {
        get: backing.get,
        set: async (k, value) => {
          if (!refuse) await backing.set(k, value);
        },
      },
    });
    await h.client.identify(A);
    refuse = true;
    await h.client.identify(B);
    expect(h.client.accountConfirmed).toBe(false);
    expect(await h.client.signedInAs()).toBe(A);
    const { createAccountIdentifier } = await import("../extension-host.js");
    const attach = vi.fn(async () => {});
    await createAccountIdentifier({
      client: h.client,
      local: backing,
      consent: async () => true,
      identifyOnServer: attach,
    }).attach();
    await h.client.track("signed_in", {});
    await h.client.flush();
    expect(attach).not.toHaveBeenCalled();
    expect(h.sink).not.toHaveBeenCalled();
  });
});

describe("shared host original observation ports", () => {
  it("holds an earlier null observation on page/activity/update despite a later valid permission", async () => {
    const h = harness();
    const host = createExtensionAnalyticsHost({
      ...h.deps,
      ...TEST_PRIVACY,
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
    });
    host.onStart(null);
    await host.flushWhenReady();
    const observed = Promise.resolve(null);
    const response = new Promise((resolve) =>
      host.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        {},
        resolve,
        observed,
      ),
    );
    expect(await response).toBe(false);
    host.onActivity(observed);
    host.onInstalled({ reason: "update", previousVersion: "2.0.0" }, observed);
    await host.flushWhenReady();
    expect(h.store.data[QUEUE_KEY] ?? []).toEqual([]);
    expect(h.sink).not.toHaveBeenCalled();
    host.stop();
  });
  it("revalidates the original generation after a native/startup wait and admits a new same-origin observation", async () => {
    const h = harness();
    const host = createExtensionAnalyticsHost({
      ...h.deps,
      ...TEST_PRIVACY,
      local: h.store,
      noticeApplies: false,
      isTrustedPage: () => true,
    });
    host.onStart(null);
    await host.flushWhenReady();
    const captured = host.client.captureObservation();
    await captured;
    host.client.permissionChanged();
    const old = new Promise((resolve) =>
      host.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "options" },
        },
        {},
        resolve,
        captured,
      ),
    );
    expect(await old).toBe(false);
    const fresh = new Promise((resolve) =>
      host.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        {},
        resolve,
        host.client.captureObservation(),
      ),
    );
    expect(await fresh).toBe(true);
    await host.flushWhenReady();
    expect(
      h.bodies
        .flatMap((body) => body.batch)
        .find((event) => event.properties.where === "options"),
    ).toBeUndefined();
    expect(
      h.bodies
        .flatMap((body) => body.batch)
        .find((event) => event.properties.where === "popup"),
    ).toBeDefined();
    host.stop();
  });
  it("terminal stop releases startup and send timers and rejects late observations", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const host = createExtensionAnalyticsHost({
        ...h.deps,
      ...TEST_PRIVACY,
        local: h.store,
        noticeApplies: false,
        isTrustedPage: () => true,
      });
      const response = new Promise((resolve) =>
        host.listener(
          {
            kind: ANALYTICS_MESSAGE_KIND,
            action: "track",
            name: "opened",
            props: { where: "popup" },
          },
          {},
          resolve,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      host.stop();
      expect(await response).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(
        host.listener(
          {
            kind: ANALYTICS_MESSAGE_KIND,
            action: "track",
            name: "opened",
            props: { where: "popup" },
          },
          {},
          () => {},
        ),
      ).toBe(false);
      host.onActivity();
      host.onInstalled({ reason: "update", previousVersion: "2.0.0" });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sink).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
