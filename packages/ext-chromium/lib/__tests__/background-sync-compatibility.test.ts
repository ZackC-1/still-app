import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SETTINGS,
  PAID_TIER_ENABLED,
  type SettingsV2,
} from "@still/shared-types";
import {
  ChromeStorageAdapter,
  requireModernSettings,
  type StoredSettingsRecord,
} from "@still/core/storage";
import type { ExtensionSession, ExtensionSessionDeps } from "@still/core/sync";

// Synthetic browser/SDK auth/realtime transport only. The maintained background,
// session, SyncService, SupabaseBackendPort, SDK HTTP, cache and writer remain real.
// No tokens, hosted cryptography, outbound requests or provider activation are evidence here.
const boundary = vi.hoisted(() => ({
  browser: {} as typeof chrome,
  clients: [] as SupabaseClient[],
  configure: null as ((client: SupabaseClient) => void) | null,
  spines: [] as ExtensionSessionDeps[],
  sessions: [] as ExtensionSession[],
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
      boundary.configure?.(client);
      return client;
    },
  };
});
vi.mock("@still/core/sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("@still/core/sync")>();
  return {
    ...real,
    createExtensionSession: (deps: ExtensionSessionDeps) => {
      boundary.spines.push(deps);
      const session = real.createExtensionSession(deps);
      boundary.sessions.push(session);
      return session;
    },
  };
});
vi.mock("../analytics.js", () => ({
  storageKeyValue: () => ({}),
  createBackgroundAnalytics: () => ({
    onInstalled: vi.fn(),
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

const KEY = "still:settings";
const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINEAGE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const legacy = (globalOn = true): StoredSettingsRecord => ({
  settings: { ...structuredClone(DEFAULT_SETTINGS), globalOn, updatedAt: 1 },
  syncMetadata: null,
});
const record = (store: Record<string, unknown>) =>
  store[KEY] as StoredSettingsRecord;

async function start(
  options: {
    initial?: Record<string, unknown>;
    signedIn?: boolean;
    flag?: string;
    install?: boolean;
    configured?: boolean;
  } = {},
) {
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.stubEnv("PROD", true);
  vi.stubEnv(
    "VITE_SUPABASE_URL",
    options.configured === false ? "" : "https://compatibility.invalid",
  );
  vi.stubEnv(
    "VITE_SUPABASE_ANON_KEY",
    options.configured === false ? "" : "synthetic-public-key",
  );
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", options.flag ?? "");
  vi.stubEnv("VITE_POSTHOG_KEY", "");
  const store = structuredClone(options.initial ?? { [KEY]: legacy() });
  const writes: Record<string, unknown>[] = [];
  const changes = new Set<
    Parameters<typeof chrome.storage.onChanged.addListener>[0]
  >();
  const messages: ((
    payload: unknown,
    sender: chrome.runtime.MessageSender,
    reply: (value: unknown) => void,
  ) => boolean | void)[] = [];
  const installed: Parameters<
    typeof chrome.runtime.onInstalled.addListener
  >[0][] = [];
  const origin = "chrome-extension://compatibility/";
  const local = {
    async get(keys: string | string[] | null) {
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
      id: "compatibility",
      getURL: (path: string) => origin + path,
      getManifest: () => ({ version: "test" }),
      onMessage: {
        addListener: (listener: (typeof messages)[number]) =>
          messages.push(listener),
      },
      onInstalled: {
        addListener: (listener: (typeof installed)[number]) =>
          installed.push(listener),
      },
    },
    tabs: { remove: async () => {} },
  } as unknown as typeof chrome;
  vi.stubGlobal("chrome", boundary.browser);
  let signedIn = options.signedIn ?? false;
  const session = {
    user: { id: USER, email: "synthetic@example.test" },
  } as Session;
  // A current cloud row is deliberately newer than the retained local timestamp.
  let cloudSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    globalOn: false,
    updatedAt: 2,
  };
  let version = 1;
  let writeId: string | null = null;
  let modern: SettingsV2 | null = null;
  const requests: { path: string; body: Record<string, unknown> | null }[] = [];
  const row = () => ({
    settings: cloudSettings,
    settings_version: version,
    settings_server_updated_at: "2026-10-04T00:00:00Z",
    settings_last_write_id: writeId,
  });
  const canonical = () => ({
    status: "ready",
    protocol: 2,
    empty: false,
    settings: modern,
    settingsVersion: version,
    settingsServerUpdatedAt: "2026-10-04T00:00:00Z",
    writeId,
    lineage: LINEAGE,
    receipt: {
      version: 1,
      lineage: LINEAGE,
      revision: version,
      mac: "A".repeat(43),
    },
  });
  const network = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const raw =
        init?.body ??
        (input instanceof Request ? await input.text() : undefined);
      const body =
        typeof raw === "string" && raw
          ? (JSON.parse(raw) as Record<string, unknown>)
          : null;
      requests.push({ path: url.pathname, body });
      const respond = (data: unknown) =>
        new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      if (url.hostname !== "compatibility.invalid")
        throw new Error("Outbound request forbidden");
      if (url.pathname.endsWith("/get_current_rule_set"))
        return new Response("{}", { status: 503 });
      if (url.pathname.endsWith("/profiles")) return respond(row());
      if (url.pathname.endsWith("/entitlements"))
        return respond({ still_sync: false });
      if (url.pathname.endsWith("/reconcile-entitlement")) return respond({});
      if (url.pathname.endsWith("/write_profile_settings")) {
        cloudSettings = body!.p_settings as typeof cloudSettings;
        writeId = body!.p_write_id as string;
        version += 1;
        return respond([row()]);
      }
      if (url.pathname.endsWith("/sync-settings")) {
        if (body?.action !== "read") {
          // This bounded canonical fixture accepts exactly the exercised global edit.
          const operations = body!.operations as {
            path: string;
            value: boolean;
            baseRevision: number;
            localStep: number;
          }[];
          expect(operations).toHaveLength(1);
          expect(operations[0]!.path).toBe("globalOn");
          modern = {
            ...modern!,
            globalOn: operations[0]!.value,
            updatedAt: 3,
            clocks: {
              ...modern!.clocks,
              globalOn: {
                baseRevision: operations[0]!.baseRevision,
                localStep: operations[0]!.localStep,
              },
            },
          };
          writeId = body!.writeId as string;
          version += 1;
        }
        return respond(canonical());
      }
      throw new Error("Unexpected synthetic SDK transport: " + url.pathname);
    },
  );
  vi.stubGlobal("fetch", network);
  boundary.configure = (client) => {
    vi.spyOn(client.auth, "getSession").mockImplementation(async () =>
      signedIn
        ? { data: { session }, error: null }
        : { data: { session: null }, error: null },
    );
    vi.spyOn(client.auth, "getClaims").mockImplementation(async () =>
      signedIn
        ? ({
            data: {
              claims: { sub: USER, session_id: SESSION },
              header: { alg: "ES256", typ: "JWT" },
              signature: new Uint8Array(),
            },
            error: null,
          } as Awaited<ReturnType<typeof client.auth.getClaims>>)
        : { data: null, error: null },
    );
    vi.spyOn(client.auth, "verifyOtp").mockImplementation(async () => {
      signedIn = true;
      return { data: { session, user: session.user }, error: null };
    });
    const channel = client.channel("synthetic-realtime-transport");
    vi.spyOn(channel, "subscribe").mockReturnValue(channel);
    vi.spyOn(channel, "unsubscribe").mockResolvedValue("ok");
    vi.spyOn(client, "channel").mockReturnValue(channel);
  };
  const install = () => installed[0]!({ reason: "install" });
  vi.stubGlobal("defineBackground", (body: () => void) => {
    body();
    if (options.install) install();
  });
  await import("../../entrypoints/background.js");
  const message = (payload: unknown) =>
    new Promise<unknown>((resolve) => {
      for (const listener of messages)
        if (
          listener(
            payload,
            { id: "compatibility", url: origin + "popup.html" },
            resolve,
          ) === true
        )
          return;
      resolve(undefined);
    });
  const barrier = () =>
    message({
      kind: "still:settings-intent",
      path: "globalOn",
      value: record(store)?.settings?.globalOn ?? true,
      updatedAt: 42,
    });
  const spine = boundary.spines[0];
  // Await actual reconcile/readiness instead of advancing a wall clock.
  if (spine) await boundary.sessions[0]!.resume();
  await barrier();
  return {
    store,
    writes,
    requests,
    install,
    message,
    barrier,
    spine,
    setCanonical(settings: SettingsV2) {
      modern = structuredClone(settings);
    },
    cloud: () => cloudSettings,
  };
}

afterEach(async () => {
  for (const spine of boundary.spines) await spine.sync.signOut();
  for (const client of boundary.clients) {
    await client.removeAllChannels();
    await client.auth.dispose();
  }
  boundary.clients.length =
    boundary.spines.length =
    boundary.sessions.length =
      0;
  boundary.configure = null;
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("maintained configured default free legacy sync compatibility", () => {
  it("retained signed-in resume reads actual account settings and uploads a later exact deliberate edit without entitlement", async () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    const h = await start({
      signedIn: true,
      initial: { [KEY]: legacy(), "still:last-identity": USER },
    });
    expect(h.requests.some((r) => r.path.endsWith("/profiles"))).toBe(true);
    expect(record(h.store).atomic).toBeUndefined();
    expect(record(h.store).settings.globalOn).toBe(false);
    await h.message({
      kind: "still:settings-record",
      record: {
        ...record(h.store),
        settings: {
          ...record(h.store).settings,
          globalOn: true,
          updatedAt: 50,
        },
      },
    });
    await h.spine!.sync.retryNow!();
    const uploads = h.requests.filter((r) =>
      r.path.endsWith("/write_profile_settings"),
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.body!.p_settings).toMatchObject({
      globalOn: true,
      updatedAt: 50,
    });
    expect(h.cloud().globalOn).toBe(true);
    expect(h.spine!.sync.getState()).toMatchObject({
      entitled: false,
      cloudReachable: true,
      pendingUpload: false,
    });
    expect(h.requests.some((r) => r.path.endsWith("/sync-settings"))).toBe(
      false,
    );
  });

  it("fresh optional code sign-in with absent settings reads the actual legacy backend and uploads the later free edit", async () => {
    const h = await start({ initial: {}, install: true });
    const absentBeforeSignIn = !Object.hasOwn(h.store, KEY);
    const verified = await h.message({
      kind: "still:session",
      action: "verifyCode",
      email: "synthetic@example.test",
      token: "123456",
    });
    expect(verified).toMatchObject({ kind: "verified", userId: USER });
    expect(h.requests.some((r) => r.path.endsWith("/profiles"))).toBe(true);
    expect(absentBeforeSignIn).toBe(true);
    expect(record(h.store).atomic).toBeUndefined();
    expect(record(h.store).settings.globalOn).toBe(false);
    await h.message({
      kind: "still:settings-record",
      record: {
        ...record(h.store),
        settings: {
          ...record(h.store).settings,
          globalOn: true,
          updatedAt: 60,
        },
      },
    });
    await h.spine!.sync.retryNow!();
    expect(
      h.requests.filter((r) => r.path.endsWith("/write_profile_settings")),
    ).toHaveLength(1);
    expect(h.cloud().globalOn).toBe(true);
    expect(h.spine!.sync.getState().entitled).toBe(false);
    expect(h.requests.some((r) => r.path.endsWith("/sync-settings"))).toBe(
      false,
    );
  });

  it.each(["", "false", "TRUE", " true", "1"])(
    "flag %j preserves exact readable legacy bytes on wake and install",
    async (flag) => {
      const raw = { ...legacy(false), opaque: { future: [1, "retained"] } };
      const before = JSON.stringify(raw);
      const h = await start({ initial: { [KEY]: raw }, flag, install: true });
      expect(JSON.stringify(h.store[KEY])).toBe(before);
      expect(h.writes.filter((w) => Object.hasOwn(w, KEY))).toEqual([]);
      expect(h.spine!.backend.modernSettingsEnabled).toBe(false);
      expect(h.requests.some((r) => r.path.endsWith("/sync-settings"))).toBe(
        false,
      );
    },
  );

  it.each([null, undefined, "corrupt", { settings: { schemaVersion: 99 } }])(
    "retained unreadable/future input %j cannot become an install record",
    async (raw) => {
      const h = await start({
        initial: { [KEY]: raw },
        install: true,
        signedIn: true,
      });
      expect(h.store[KEY]).toEqual(raw);
      expect(h.writes.filter((w) => Object.hasOwn(w, KEY))).toEqual([]);
      expect(
        h.requests.some((r) =>
          /profiles|write_profile_settings|sync-settings/.test(r.path),
        ),
      ).toBe(false);
    },
  );

  it("retained raw null denies install initialization while signed out", async () => {
    const h = await start({ initial: { [KEY]: null }, install: true });
    expect(h.store[KEY]).toBeNull();
    expect(h.writes.filter((w) => Object.hasOwn(w, KEY))).toEqual([]);
    expect(
      h.requests.some((r) =>
        /profiles|write_profile_settings|sync-settings/.test(r.path),
      ),
    ).toBe(false);
  });

  it("explicit configured opt-in pairs actual verified scope with real canonical read/write transport", async () => {
    const h = await start({ flag: "true" });
    expect(h.spine!.backend.modernSettingsEnabled).toBe(true);
    const authority = new ChromeStorageAdapter({ authority: true });
    h.setCanonical({
      ...requireModernSettings((await authority.get())!),
      globalOn: false,
    });
    expect(await h.spine!.auth.currentSettingsSession?.()).toBeNull();
    expect(
      await h.message({
        kind: "still:session",
        action: "verifyCode",
        email: "synthetic@example.test",
        token: "123456",
      }),
    ).toMatchObject({ kind: "verified" });
    expect(await h.spine!.auth.currentSettingsSession?.()).toEqual({
      userId: USER,
      sessionId: SESSION,
    });
    expect(
      h.requests.filter(
        (r) => r.path.endsWith("/sync-settings") && r.body?.action === "read",
      ),
    ).toHaveLength(1);
    expect(record(h.store).atomic!.scope).toMatchObject({
      accountId: USER,
      sessionId: SESSION,
    });
    expect(record(h.store).settings.globalOn).toBe(false);
    await h.message({
      kind: "still:settings-intent",
      path: "globalOn",
      value: true,
      updatedAt: 70,
    });
    await h.spine!.sync.retryNow!();
    expect(
      h.requests.filter(
        (r) => r.path.endsWith("/sync-settings") && r.body?.action !== "read",
      ),
    ).toHaveLength(1);
    expect(record(h.store).atomic!.pending).toEqual([]);
    expect(record(h.store).settings.globalOn).toBe(true);
    expect(
      h.requests.some((r) => /profiles|write_profile_settings/.test(r.path)),
    ).toBe(false);
  });

  it.each(["unknown", "never-linked"] as const)(
    "already atomic %s records retain history with modern cloud held and no legacy bypass",
    async (ownership) => {
      const h = await start({ flag: "true" });
      const initial = structuredClone(h.store);
      initial[KEY] = {
        ...record(initial),
        atomic: {
          ...record(initial).atomic!,
          ownership,
          paused: "ownership-hold",
        },
      };
      const raw = JSON.stringify(initial[KEY]);
      // Start the default configured lifetime with the retained current record.
      await boundary.spines[0]!.sync.signOut();
      boundary.spines.length = boundary.sessions.length = 0;
      const next = await start({ initial, signedIn: true, install: true });
      expect(JSON.stringify(next.store[KEY])).toBe(raw);
      expect(
        next.requests.some((r) =>
          /profiles|write_profile_settings|sync-settings/.test(r.path),
        ),
      ).toBe(false);
      expect(next.spine!.sync.getState().cloudReachable).toBe(false);
      await next.message({ kind: "still:settings-record", record: legacy() });
      expect(JSON.stringify(next.store[KEY])).toBe(raw);
    },
  );

  it("unconfigured true opt-in remains local-only atomic without constructing an SDK client", async () => {
    const h = await start({
      configured: false,
      flag: "true",
      initial: {},
      install: true,
    });
    expect(boundary.clients).toEqual([]);
    expect(h.spine).toBeUndefined();
    expect(record(h.store).atomic).toMatchObject({
      ownership: "never-linked",
      sequence: 0,
    });
    expect(h.requests).toEqual([]);
  });
});
