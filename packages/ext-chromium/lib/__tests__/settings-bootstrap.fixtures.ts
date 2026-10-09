import { afterEach, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import type { ExtensionSessionDeps } from "@still/core/sync";
import { migrateSettingsV2 } from "@still/core/storage";

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
  buildChannelEnvelope: () => undefined,
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
type DnrUpdate = (
  options: chrome.declarativeNetRequest.UpdateRulesetOptions,
) => Promise<void>;
/** Additive browser doubles: session-rule DNR calls, and env overrides for configured lanes. */
interface StartExtras {
  readonly sessionRules?: {
    getSessionRules(): Promise<readonly { readonly id: number }[]>;
    updateSessionRules(options: { removeRuleIds: number[]; addRules: unknown[] }): Promise<void>;
  };
  readonly env?: Readonly<Record<string, string>>;
}
async function start(
  initial: Record<string, unknown> = {},
  updateEnabledRulesets?: DnrUpdate,
  // "false" with stubbed Supabase config gives a configured legacy (atomicLocal false) build.
  modernSyncFlag = "true",
  extras: StartExtras = {},
) {
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", modernSyncFlag);
  for (const [name, value] of Object.entries(extras.env ?? {})) vi.stubEnv(name, value);
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
  // Additive browser-I/O fault controls; authority/cache/router remain real.
  const retry = {
    rawReads: 0,
    singleReads: 0,
    settingsWrites: 0,
    lostAck: false,
    notify: true,
    afterPersist: null as (() => void) | null,
    afterRawFailure: null as (() => void) | null,
  };
  const attempts = { rawReads: 0, singleReads: 0, settingsWrites: 0 };
  const local = {
    async get(keys: string | string[] | null) {
      const freshRead = Array.isArray(keys) && keys.includes(KEY);
      if (freshRead) attempts.rawReads += 1;
      if (keys === KEY) attempts.singleReads += 1;
      if (freshRead && retry.rawReads > 0) {
        retry.rawReads -= 1;
        retry.afterRawFailure?.();
        throw new Error("transient pristine read");
      }
      if (keys === KEY && retry.singleReads > 0) {
        retry.singleReads -= 1;
        throw new Error("transient authority read");
      }
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
      if (Object.hasOwn(values, KEY)) {
        attempts.settingsWrites += 1;
        if (retry.settingsWrites > 0) {
          retry.settingsWrites -= 1;
          throw new Error("transient settings write");
        }
      }
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
        if (key !== KEY || retry.notify)
          for (const listener of changes)
            listener({ [key]: { oldValue, newValue: value } }, "local");
      }
      if (Object.hasOwn(values, KEY)) {
        retry.afterPersist?.();
        if (retry.lostAck) {
          retry.lostAck = false;
          throw new Error("settings persisted, acknowledgement lost");
        }
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
    ...(updateEnabledRulesets
      ? { declarativeNetRequest: { updateEnabledRulesets, ...extras.sessionRules } }
      : {}),
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
    attempts,
    retryFaults(options: Partial<typeof retry>) {
      Object.assign(retry, options);
      attempts.rawReads = attempts.singleReads = attempts.settingsWrites = 0;
    },
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

// Only the browser API is doubled: migration, storage authority, cache and gate remain real.
function retainedDnrRecord(globalOn: boolean, youtube: boolean) {
  const migrated = migrateSettingsV2(
    {
      ...DEFAULT_SETTINGS,
      globalOn,
      services: {
        ...DEFAULT_SETTINGS.services,
        youtube,
        instagram: false,
        facebook: false,
        opaque: false,
      },
      updatedAt: 42,
      opaque: { retained: true },
    },
    { kind: "readable-local" },
  );
  if (migrated.status !== "ready") throw new Error("Invalid retained fixture");
  return {
    settings: { ...migrated.settings, pauses: [] },
    syncMetadata: null,
    syncEpoch: 0,
    atomic: {
      format: 1,
      sequence: 7,
      ownership: "unknown",
      scope: { accountId: null, generation: 0 },
      anchor: null,
      pending: [],
      held: {},
      paused: null,
    },
    opaqueRoot: { retained: 17 },
  };
}

const dnrUpdate = () => vi.fn<DnrUpdate>().mockResolvedValue(undefined);

function expectDnr(update: ReturnType<typeof dnrUpdate>, enabled: boolean) {
  expect(update).toHaveBeenCalled();
  for (const args of update.mock.calls)
    expect(args).toEqual([
      enabled
        ? { enableRulesetIds: ["youtube-shorts-redirect"] }
        : { disableRulesetIds: ["youtube-shorts-redirect"] },
    ]);
}

export { boundary, KEY, start, retainedDnrRecord, dnrUpdate, expectDnr };
