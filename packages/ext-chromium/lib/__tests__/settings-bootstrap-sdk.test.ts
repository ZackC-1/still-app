import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SettingsV2 } from "@still/shared-types";

// Browser and analytics are labelled local ports. The SDK, auth storage, session,
// ChromeStorageAdapter, atomic writer, settings cache and background all stay real.
const boundary = vi.hoisted(() => ({
  browser: {} as typeof chrome,
  clients: [] as SupabaseClient[],
  initialized: null as (() => void) | null,
  started: null as (() => void) | null,
  installs: vi.fn(),
}));
vi.mock("wxt/browser", () => ({
  get browser() {
    return boundary.browser;
  },
}));
vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...real,
    createClient: (...args: Parameters<typeof real.createClient>) => {
      const client = real.createClient(...args);
      boundary.clients.push(client);
      client.auth.onAuthStateChange((event) => {
        if (event === "INITIAL_SESSION") boundary.initialized?.();
      });
      return client;
    },
  };
});
vi.mock("../analytics.js", () => ({
  storageKeyValue: () => ({}),
  createBackgroundAnalytics: () => ({
    onInstalled: boundary.installs,
    onStart: () => boundary.started?.(),
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

const KEY = "still:settings";
const AUTH = "still:auth";
type Trace = {
  operation: "get" | "set" | "remove" | "install";
  keys: string[];
  present?: string[];
  values?: Record<string, unknown>;
};
const traces: Array<{ label: string; entries: Trace[] }> = [];

async function start(
  initial: Record<string, unknown> = {},
  installInFirstPass = false,
) {
  vi.resetModules();
  // Own the background account-lookup deadline so it is cleared on teardown;
  // no fake clock advance supplies evidence of settings or SDK completion.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.stubEnv("PROD", true);
  vi.stubEnv("VITE_SUPABASE_URL", "https://sdk-bootstrap.invalid");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-config-key");
  vi.stubEnv("VITE_POSTHOG_KEY", "");
  vi.stubEnv("VITE_POSTHOG_HOST", "");
  const network = vi.fn(async (_request: RequestInfo | URL) => {
    throw new Error("No outbound network in SDK bootstrap proof");
  });
  vi.stubGlobal("fetch", network);
  const store = structuredClone(initial),
    trace: Trace[] = [];
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
  const local = {
    async get(keys: string | string[] | null) {
      const names =
        keys === null
          ? Object.keys(store)
          : Array.isArray(keys)
            ? keys
            : [keys];
      const present = names.filter((key) => Object.hasOwn(store, key));
      trace.push({ operation: "get", keys: [...names], present });
      return Object.fromEntries(
        present.map((key) => [key, structuredClone(store[key])]),
      );
    },
    async set(values: Record<string, unknown>) {
      trace.push({
        operation: "set",
        keys: Object.keys(values),
        values: structuredClone(values),
      });
      for (const [key, value] of Object.entries(values)) {
        const oldValue = store[key];
        store[key] = structuredClone(value);
        for (const listener of changes)
          listener({ [key]: { oldValue, newValue: value } }, "local");
      }
    },
    async remove(keys: string | string[]) {
      const names = typeof keys === "string" ? [keys] : keys;
      trace.push({ operation: "remove", keys: [...names] });
      for (const key of names) delete store[key];
    },
  };
  const origin = "chrome-extension://sdk-bootstrap/";
  boundary.browser = {
    storage: {
      local,
      onChanged: {
        addListener: (listener: Parameters<typeof changes.add>[0]) =>
          changes.add(listener),
        removeListener: (listener: Parameters<typeof changes.add>[0]) =>
          changes.delete(listener),
      },
    },
    runtime: {
      id: "sdk-bootstrap",
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
    },
  } as unknown as typeof chrome;
  vi.stubGlobal("chrome", boundary.browser);
  const initialSession = new Promise<void>((resolve) => {
    boundary.initialized = resolve;
  });
  const onStart = new Promise<void>((resolve) => {
    boundary.started = resolve;
  });
  const install = () => {
    expect(installed).toHaveLength(1);
    trace.push({ operation: "install", keys: [] });
    installed[0]!({ reason: "install" });
  };
  vi.stubGlobal("defineBackground", (body: () => void) => {
    body();
    // Dispatch from the same synchronous registration pass, before awaiting SDK startup.
    if (installInFirstPass) install();
  });
  await import("../../entrypoints/background.js");
  expect(boundary.clients).toHaveLength(1);
  await initialSession;
  const session = await boundary.clients[0]!.auth.getSession();
  expect(session.error).toBeNull();
  expect(session.data.session).toBeNull();
  await onStart;
  const message = (payload: unknown) =>
    new Promise<unknown>((resolve) => {
      for (const listener of messages)
        if (
          listener(
            payload,
            { id: "sdk-bootstrap", url: origin + "popup.html" },
            resolve,
          ) === true
        )
          return;
      resolve(undefined);
    });
  // A valid no-op intent is an actual serialized settings writer barrier after install.
  // It cannot create an absent modern settings record or manufacture provenance.
  const barrier = () =>
    message({
      kind: "still:settings-intent",
      path: "globalOn",
      value: true,
      updatedAt: 42,
    });
  const result = await barrier();
  expect(
    await message({ kind: "still:session", action: "getState" }),
  ).toMatchObject({ userId: null });
  expect(network.mock.calls.map((call) => String(call[0]))).toEqual([
    "https://sdk-bootstrap.invalid/rest/v1/rpc/get_current_rule_set",
  ]);
  return { store, trace, install, barrier, result, network };
}

afterEach(async () => {
  for (const client of boundary.clients) {
    await client.removeAllChannels();
    await client.auth.dispose();
  }
  boundary.clients.length = 0;
  boundary.initialized = null;
  boundary.started = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  // Set only by the private author command when collecting synthetic lifecycle traces.
  const destination = process.env.STILL_SDK_BOOTSTRAP_TRACE;
  if (destination) {
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(destination, JSON.stringify(traces, null, 2) + "\n");
    await chmod(destination, 0o600);
  }
});

describe("configured real SDK signed-out background settings bootstrap", () => {
  beforeEach(() => vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true"));
  it("synchronous first-install admission creates modern free choices once while real SDK startup stays signed out", async () => {
    const h = await start({}, true);
    traces.push({ label: "first-install", entries: h.trace });
    expect(h.store[KEY]).toMatchObject({
      settings: {
        schemaVersion: 2,
        globalOn: true,
        services: {
          youtube: true,
          instagram: true,
          facebook: true,
          tiktok: true,
        },
      },
      atomic: {
        format: 1,
        sequence: 0,
        ownership: "never-linked",
        scope: { accountId: null, generation: 0 },
        anchor: null,
        pending: [],
        held: {},
        paused: null,
      },
    });
    const modern = (h.store[KEY] as { settings: SettingsV2 }).settings;
    expect(
      Object.entries(modern.sites)
        .filter(([, enabled]) => enabled)
        .map(([key]) => key)
        .sort(),
    ).toEqual(["facebook.reels", "instagram.reels", "youtube.shorts"]);
    expect(
      Object.values(modern.clocks).every(
        (clock) => clock.baseRevision === 0 && clock.localStep === 0,
      ),
    ).toBe(true);
    const before = structuredClone(h.store[KEY]);
    h.install();
    await h.barrier();
    expect(h.store[KEY]).toEqual(before);
    expect(
      h.trace.filter(
        (entry) => entry.operation === "set" && entry.keys.includes(KEY),
      ),
    ).toHaveLength(1);
    expect(boundary.installs).toHaveBeenCalledTimes(2);
    const admitted = h.trace.findIndex(
      (entry) => entry.operation === "install",
    );
    const provenanceRead = h.trace.findIndex(
      (entry) =>
        entry.operation === "get" &&
        entry.keys.includes(KEY) &&
        entry.keys.includes(AUTH),
    );
    const published = h.trace.findIndex(
      (entry) => entry.operation === "set" && entry.keys.includes(KEY),
    );
    expect(admitted).toBeLessThan(provenanceRead);
    expect(provenanceRead).toBeLessThan(published);
    expect(
      h.trace.filter(
        (entry) =>
          entry.operation !== "get" &&
          entry.keys.some((key) => key.startsWith(AUTH)),
      ),
    ).toEqual([]);
    expect(h.network.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://sdk-bootstrap.invalid/rest/v1/rpc/get_current_rule_set",
    ]);
  });
  it("configured ordinary wake executes real SDK/session reads without seeding settings", async () => {
    const h = await start();
    traces.push({ label: "ordinary-wake", entries: h.trace });
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
    expect(
      h.trace.filter(
        (entry) => entry.operation === "set" && entry.keys.includes(KEY),
      ),
    ).toEqual([]);
    expect(
      h.trace.some(
        (entry) => entry.operation === "get" && entry.keys.includes(AUTH),
      ),
    ).toBe(true);
    expect(
      h.trace.filter(
        (entry) =>
          entry.operation === "set" &&
          entry.keys.some((key) => key.startsWith(AUTH)),
      ),
    ).toEqual([]);
  });
  it.each([
    [AUTH, null],
    [AUTH, "retained-sdk-raw"],
    [AUTH, '{"not":"a-session"}'],
    [AUTH + "-code-verifier", null],
    ["still:last-identity", null],
    ["still:last-identity", "retained-account"],
    [KEY, null],
  ] as const)(
    "actual retained raw slot %s (%j) denies fresh admission through real SDK startup",
    async (key, value) => {
      const h = await start({ [key]: value }, true);
      traces.push({
        label: "retained:" + key + ":" + String(value),
        entries: h.trace,
      });
      expect(
        h.trace.filter(
          (entry) => entry.operation === "set" && entry.keys.includes(KEY),
        ),
      ).toEqual([]);
      if (key === KEY) expect(h.store[KEY]).toBeNull();
      else expect(Object.hasOwn(h.store, KEY)).toBe(false);
      if (key === AUTH && value === '{"not":"a-session"}') {
        expect(
          h.trace.some(
            (entry) =>
              entry.operation === "remove" && entry.keys.includes(AUTH),
          ),
        ).toBe(true);
        expect(Object.hasOwn(h.store, AUTH)).toBe(false);
      }
      const before = structuredClone(h.store[KEY]);
      h.install();
      await h.barrier();
      expect(h.store[KEY]).toEqual(before);
      expect(h.network.mock.calls.map((call) => String(call[0]))).toEqual([
        "https://sdk-bootstrap.invalid/rest/v1/rpc/get_current_rule_set",
      ]);
    },
  );
});

// This observer delegates to the real session constructor. Original startup
// cases above retain real SDK transport; only the explicitly labelled claims
// cases below control the SDK's already-verified getClaims response boundary.
const verifiedSessionBoundary = vi.hoisted(() => ({
  spines: [] as Parameters<
    typeof import("@still/core/sync").createExtensionSession
  >[0][],
}));
vi.mock("@still/core/sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("@still/core/sync")>();
  return {
    ...real,
    createExtensionSession: (
      ...args: Parameters<typeof real.createExtensionSession>
    ) => {
      verifiedSessionBoundary.spines.push(args[0]);
      return real.createExtensionSession(...args);
    },
  };
});

afterEach(() => {
  verifiedSessionBoundary.spines.length = 0;
  vi.restoreAllMocks();
});

type ClaimsResult = Awaited<ReturnType<SupabaseClient["auth"]["getClaims"]>>;
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const SESSION_A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_A3 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// Synthetic SDK-boundary results, not tokens or evidence of cryptographic or
// hosted verification. The actual maintained auth port still validates scope.
function controlledClaims(claims: Record<string, unknown>): ClaimsResult {
  return {
    data: {
      claims,
      header: { alg: "ES256", typ: "JWT" },
      signature: new Uint8Array(),
    },
    error: null,
  } as ClaimsResult;
}

function observedSettingsAuth() {
  expect(verifiedSessionBoundary.spines).toHaveLength(1);
  const spine = verifiedSessionBoundary.spines[0]!;
  expect(spine.backend.modernSettingsEnabled).toBe(false);
  return spine.auth;
}

describe("maintained background verified settings-session forwarding", () => {
  beforeEach(() => vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", ""));
  it("passes actual SDK signed-out claims through the real auth port without creating settings or auth", async () => {
    const h = await start();
    const auth = observedSettingsAuth();
    const claims = vi.spyOn(boundary.clients[0]!.auth, "getClaims");
    const before = structuredClone(h.store);
    expect(await auth.currentSettingsSession?.()).toBeNull();
    expect(await auth.currentUserId()).toBeNull();
    expect(claims).toHaveBeenCalledOnce();
    expect(h.store).toEqual(before);
    expect(h.network).toHaveBeenCalledOnce();
  });

  it("controlled SDK claims preserve refresh identity and follow same-user relogin and A→B→A through the same real port", async () => {
    const h = await start();
    const auth = observedSettingsAuth();
    const client = boundary.clients[0]!;
    const core = await import("@still/core/sync");
    const port = vi.spyOn(
      core.SupabaseAuthPort.prototype,
      "currentSettingsSession",
    );
    const claims = vi.spyOn(client.auth, "getClaims");
    const user = vi.spyOn(client.auth, "getUser");
    const before = structuredClone(h.store);
    const sequence = [
      { userId: USER_A, sessionId: SESSION_A1, issuedAt: 100 },
      { userId: USER_A, sessionId: SESSION_A1, issuedAt: 200 },
      { userId: USER_A, sessionId: SESSION_A2, issuedAt: 300 },
      { userId: USER_B, sessionId: SESSION_B, issuedAt: 400 },
      { userId: USER_A, sessionId: SESSION_A3, issuedAt: 500 },
    ];
    for (const { userId, sessionId, issuedAt } of sequence) {
      claims.mockResolvedValueOnce(
        controlledClaims({
          sub: userId,
          session_id: sessionId,
          iat: issuedAt,
          exp: issuedAt + 3600,
        }),
      );
      expect(await auth.currentSettingsSession?.()).toEqual({
        userId,
        sessionId,
      });
      // Display reads remain real cached SDK reads, separate from verified scope.
      expect(await auth.currentUserId()).toBeNull();
    }
    expect(claims).toHaveBeenCalledTimes(sequence.length);
    expect(port).toHaveBeenCalledTimes(sequence.length);
    for (const instance of port.mock.contexts)
      expect(instance).toBe(port.mock.contexts[0]);
    expect(user).not.toHaveBeenCalled();
    expect(h.store).toEqual(before);
    expect(h.network).toHaveBeenCalledOnce();
  });

  it.each([
    ["absent", { data: null, error: null } as ClaimsResult],
    [
      "SDK error even with claims",
      {
        ...controlledClaims({ sub: USER_A, session_id: SESSION_A1 }),
        error: new Error("Synthetic SDK verification unavailable"),
      } as ClaimsResult,
    ],
    ["missing subject", controlledClaims({ session_id: SESSION_A1 })],
    [
      "malformed subject",
      controlledClaims({ sub: "display-id", session_id: SESSION_A1 }),
    ],
    ["missing session", controlledClaims({ sub: USER_A })],
    [
      "malformed session",
      controlledClaims({ sub: USER_A, session_id: "access-token" }),
    ],
  ])(
    "controlled SDK %s returns no verified scope and never manufactures local history",
    async (_label, response) => {
      const h = await start();
      const auth = observedSettingsAuth();
      const claims = vi.spyOn(boundary.clients[0]!.auth, "getClaims");
      claims.mockResolvedValueOnce(response);
      const before = structuredClone(h.store);
      expect(await auth.currentSettingsSession?.()).toBeNull();
      expect(claims).toHaveBeenCalledOnce();
      expect(h.store).toEqual(before);
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
      expect(Object.hasOwn(h.store, AUTH)).toBe(false);
      expect(h.network).toHaveBeenCalledOnce();
    },
  );

  it("controlled SDK rejection remains unavailable and a later independent call reads new verified scope", async () => {
    const h = await start();
    const auth = observedSettingsAuth();
    const claims = vi.spyOn(boundary.clients[0]!.auth, "getClaims");
    claims.mockRejectedValueOnce(
      new Error("Synthetic claims transport failure"),
    );
    await expect(auth.currentSettingsSession?.()).rejects.toThrow(
      "Synthetic claims transport failure",
    );
    claims.mockResolvedValueOnce(
      controlledClaims({ sub: USER_B, session_id: SESSION_B }),
    );
    expect(await auth.currentSettingsSession?.()).toEqual({
      userId: USER_B,
      sessionId: SESSION_B,
    });
    expect(claims).toHaveBeenCalledTimes(2);
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
    expect(h.network).toHaveBeenCalledOnce();
  });
});
