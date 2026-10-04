import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type SettingsV2,
} from "@still/shared-types";
import type { ExtensionSessionDeps } from "@still/core/sync";

const boundary = vi.hoisted(() => ({
  browser: {} as typeof chrome,
  installed: vi.fn(),
  sessionDeps: null as ExtensionSessionDeps | null,
  sdkStorage: null as import("@supabase/supabase-js").SupportedStorage | null,
}));
vi.mock("wxt/browser", () => ({
  get browser() {
    return boundary.browser;
  },
}));
vi.mock("../analytics.js", () => ({
  storageKeyValue: () => ({}),
  createBackgroundAnalytics: () => ({
    onInstalled: boundary.installed,
    onStart: vi.fn(),
    onActivity: vi.fn(),
    listener: () => false,
    flushWhenReady: vi.fn(),
  }),
}));
vi.mock("@still/core/analytics", () => ({
  createIndexedDbKeyValue: () => ({}),
  QUIET_FLUSH_ALARM: "quiet",
  requestQuietFlush: vi.fn(),
}));
vi.mock("@still/core/rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/core/rules")>()),
  createRuleSetRefresher: () => async () => undefined,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (
    _url: string,
    _key: string,
    options: {
      auth: { storage: import("@supabase/supabase-js").SupportedStorage };
    },
  ) => {
    boundary.sdkStorage = options.auth.storage;
    return {
      auth: {
        onAuthStateChange: vi.fn(),
        getSession: async () => ({ data: { session: null } }),
      },
    };
  },
}));
// The external session is a captured port boundary; settings authority/router/cache stay real.
vi.mock("@still/core/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/core/sync")>()),
  createExtensionSession: (deps: ExtensionSessionDeps) => {
    boundary.sessionDeps = deps;
    return {
      resume: async () => "signed-out",
      getState: async () => ({ userId: null }),
      onNudge: async () => undefined,
    };
  },
}));

const KEY = "still:settings";
async function start(initial: Record<string, unknown> = {}) {
  vi.resetModules();
  const store = structuredClone(initial);
  const installed: Array<(details: chrome.runtime.InstalledDetails) => void> =
    [];
  const messages: Array<
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      reply: (value: unknown) => void,
    ) => boolean | void
  > = [];
  const changes = new Set<
    Parameters<typeof chrome.storage.onChanged.addListener>[0]
  >();
  const writes: Record<string, unknown>[] = [];
  let blockedWrite: { key: string; began(): void; wait: Promise<void> } | null =
    null;
  let failRead = false;
  let failSettingsWrite = false;
  let failAuthWrite = false;
  const local = {
    async get(keys: string | string[] | null) {
      if (failRead) throw new Error("read unavailable");
      const names =
        keys === null
          ? Object.keys(store)
          : Array.isArray(keys)
            ? keys
            : [keys];
      return Object.fromEntries(
        names
          .filter((key) => Object.hasOwn(store, key))
          .map((key) => [key, structuredClone(store[key])]),
      );
    },
    async set(values: Record<string, unknown>) {
      if (blockedWrite && Object.hasOwn(values, blockedWrite.key)) {
        const blocked = blockedWrite;
        blockedWrite = null;
        blocked.began();
        await blocked.wait;
      }
      if (failAuthWrite && Object.hasOwn(values, "still:auth"))
        throw new Error("auth write outcome unknown");
      if (failSettingsWrite && Object.hasOwn(values, KEY))
        throw new Error("write unavailable");
      writes.push(structuredClone(values));
      for (const [key, value] of Object.entries(values)) {
        const oldValue = store[key];
        store[key] = structuredClone(value);
        for (const listener of changes)
          listener({ [key]: { oldValue, newValue: value } }, "local");
      }
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys)
        delete store[key];
    },
  };
  const origin = "chrome-extension://synthetic/";
  const runtime = {
    id: "synthetic",
    getURL: (path: string) => origin + path,
    getManifest: () => ({ version: "3.0.0" }),
    onInstalled: {
      addListener: (listener: (typeof installed)[number]) =>
        installed.push(listener),
    },
    onMessage: {
      addListener: (listener: (typeof messages)[number]) =>
        messages.push(listener),
    },
  };
  boundary.browser = {
    storage: {
      local,
      onChanged: {
        addListener: (
          listener: typeof changes extends Set<infer T> ? T : never,
        ) => changes.add(listener),
        removeListener: (
          listener: typeof changes extends Set<infer T> ? T : never,
        ) => changes.delete(listener),
      },
    },
    runtime,
  } as unknown as typeof chrome;
  vi.stubGlobal("chrome", boundary.browser);
  vi.stubGlobal("defineBackground", (body: () => void) => body());
  await import("../../entrypoints/background.js");
  const settle = async () => {
    for (let i = 0; i < 12; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await settle();
  return {
    store,
    writes,
    installed,
    messages,
    settle,
    failRead: () => {
      failRead = true;
    },
    failAuthWrite: () => {
      failAuthWrite = true;
    },
    failSettingsWrite: () => {
      failSettingsWrite = true;
    },
    gateWrite(key: string) {
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      blockedWrite = { key, began, wait };
      return { started, release };
    },
    message(message: unknown, url = origin + "popup.html") {
      return new Promise<unknown>((resolve) => {
        for (const listener of messages) {
          if (listener(message, { id: "synthetic", url }, resolve) === true)
            return;
        }
        resolve(undefined);
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  boundary.sessionDeps = null;
  boundary.sdkStorage = null;
});

describe("maintained background settings bootstrap", () => {
  it("a real first-install event publishes modern never-linked settings once", async () => {
    const h = await start();
    expect(h.installed).toHaveLength(1);
    expect(h.store[KEY]).toBeUndefined();
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(h.store[KEY]).toMatchObject({
      settings: {
        schemaVersion: 2,
        globalOn: true,
        services: {
          youtube: true,
          instagram: true,
          tiktok: true,
          facebook: true,
        },
      },
      atomic: {
        format: 1,
        sequence: 0,
        ownership: "never-linked",
        scope: { accountId: null, generation: 0 },
        pending: [],
        held: {},
        paused: null,
      },
    });
    const modern = (h.store[KEY] as { settings: SettingsV2 }).settings;
    for (const feature of FEATURE_REGISTRY)
      expect(modern.sites[feature.id]).toBe(feature.tier === "free");
    expect(
      Object.values(modern.clocks).every(
        (clock) => clock.baseRevision === 0 && clock.localStep === 0,
      ),
    ).toBe(true);
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toHaveLength(
      1,
    );
    expect(boundary.installed).toHaveBeenCalledTimes(2);
  });
  it.each(["update", "chrome_update"] as const)(
    "%s and ordinary wakes never seed absent settings",
    async (reason) => {
      const h = await start();
      h.installed[0]!({ reason });
      await h.settle();
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
      expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toEqual([]);
      expect(boundary.installed).toHaveBeenCalledWith({ reason });
    },
  );
  it.each([
    [KEY, null],
    [KEY, { damaged: true }],
    [KEY, { settings: { ...DEFAULT_SETTINGS, schemaVersion: 99 } }],
    ["still:auth", null],
    ["still:auth", "retained-session"],
    ["still:auth-code-verifier", "verifier"],
    ["still:last-identity", null],
    ["still:last-identity", "old-account"],
    ["still:entitlement", { entitled: false }],
    ["still:pending-otp", null],
    ["still:checkout-pending", { damaged: true }],
    ["still:nudge-stamp", 0],
  ])(
    "raw retained slot %s denies fresh admission without rewriting it (%j)",
    async (key, value) => {
      const h = await start({ [key as string]: value });
      const before = JSON.stringify(h.store);
      const writes = h.writes.length;
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(JSON.stringify(h.store)).toBe(before);
      expect(h.writes).toHaveLength(writes);
    },
  );
  it("readable retained legacy Off/custom choices migrate with unknown ownership", async () => {
    const h = await start({
      [KEY]: {
        settings: {
          ...DEFAULT_SETTINGS,
          globalOn: false,
          services: {
            ...DEFAULT_SETTINGS.services,
            youtube: false,
            opaque: false,
          },
          updatedAt: 42,
          opaque: { retained: true },
        },
        syncMetadata: null,
        opaqueRoot: 17,
      },
    });
    expect(h.store[KEY]).toMatchObject({
      settings: {
        schemaVersion: 2,
        globalOn: false,
        services: { youtube: false, opaque: false },
        opaque: { retained: true },
      },
      atomic: { ownership: "unknown" },
      opaqueRoot: 17,
    });
    const before = JSON.stringify(h.store);
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(JSON.stringify(h.store)).toBe(before);
  });
  it.each(["read", "write"] as const)(
    "failed %s holds absent storage without success or an unhandled rejection",
    async (operation) => {
      const h = await start();
      if (operation === "read") h.failRead();
      else h.failSettingsWrite();
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
      expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toEqual([]);
    },
  );
  it("runtime payloads cannot manufacture installation provenance", async () => {
    const h = await start();
    expect(
      await h.message({ kind: "still:settings-install", reason: "install" }),
    ).toBeUndefined();
    expect(
      await h.message(
        { kind: "still:settings-install", reason: "install" },
        "https://youtube.com/",
      ),
    ).toBeUndefined();
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
  });
  it("actual broker edits after install preserve independent choices and allocate durable intent", async () => {
    const h = await start();
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(
      await h.message({
        kind: "still:settings-intent",
        path: "globalOn",
        value: false,
        updatedAt: 10,
      }),
    ).toMatchObject({ status: "committed" });
    expect(
      await h.message({
        kind: "still:settings-intent",
        path: "services.youtube",
        value: false,
        updatedAt: 11,
      }),
    ).toMatchObject({ status: "committed" });
    expect(h.store[KEY]).toMatchObject({
      settings: {
        globalOn: false,
        services: { youtube: false, instagram: true },
      },
      atomic: {
        sequence: 2,
        pending: [
          { operations: [{ path: "globalOn", value: false }] },
          { operations: [{ path: "services.youtube", value: false }] },
        ],
      },
    });
    const before = JSON.stringify(h.store[KEY]);
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(JSON.stringify(h.store[KEY])).toBe(before);
  });
  it.each([
    "auth",
    "identity",
    "pendingOtp",
    "checkoutPending",
    "nudgeStamp",
    "entitlement",
  ] as const)(
    "queued maintained %s persistence is observed before fresh admission",
    async (port) => {
      vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
      vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-key");
      const h = await start();
      const deps = boundary.sessionDeps!;
      const key = {
        auth: "still:auth",
        identity: "still:last-identity",
        pendingOtp: "still:pending-otp",
        checkoutPending: "still:checkout-pending",
        nudgeStamp: "still:nudge-stamp",
        entitlement: "still:entitlement",
      }[port];
      const held = h.gateWrite(key);
      const mutation =
        port === "auth"
          ? boundary.sdkStorage!.setItem(key, "session")
          : port === "identity"
            ? deps.identity!.set("old-account")
            : port === "entitlement"
              ? deps.records.setRecord({ entitled: false, updatedAt: 42 })
              : deps.stores[port].set({ retained: true } as never);
      let publishedWhileHeld: boolean;
      try {
        await held.started;
        h.installed[0]!({ reason: "install" });
        await h.settle();
        publishedWhileHeld = Object.hasOwn(h.store, KEY);
      } finally {
        held.release();
      }
      await mutation;
      expect(publishedWhileHeld).toBe(false);
      await h.settle();
      expect(Object.hasOwn(h.store, key)).toBe(true);
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
    },
  );

  it.each(["removed", "failed"] as const)(
    "%s SDK account writes retain an admission hold in the live install owner",
    async (operation) => {
      vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
      vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-key");
      const h = await start();
      if (operation === "removed")
        await boundary.sdkStorage!.removeItem("still:auth");
      else {
        h.failAuthWrite();
        await boundary.sdkStorage!.setItem("still:auth", "attempted-session");
      }
      expect(Object.hasOwn(h.store, "still:auth")).toBe(false);
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
    },
  );
  it("legacy entitlement runtime writes are fenced before fresh initialization", async () => {
    const h = await start();
    const held = h.gateWrite("still:entitlement");
    const mutation = h.message({
      kind: "setEntitlementRecord",
      record: { entitled: false, updatedAt: 42 },
    });
    await held.started;
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
    held.release();
    await mutation;
    await h.settle();
    expect(h.store["still:entitlement"]).toBeDefined();
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
  });
});
