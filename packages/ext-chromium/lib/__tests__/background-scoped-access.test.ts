import vectors from "../../../../tests/access-proof/vectors.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Session,
  SupabaseClient,
  SupportedStorage,
} from "@supabase/supabase-js";
import { DEFAULT_SETTINGS, type SettingsV2 } from "@still/shared-types";
import { type StoredSettingsRecord } from "@still/core/storage";
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
  authStorage: [] as SupportedStorage[],
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
      boundary.authStorage.push(args[2]!.auth!.storage!);
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

vi.mock("@still/shared-types", async (original) => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

const KEY = "still:settings";
const USER = vectors.account;
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
    scopedReply?: unknown;
    accessEnvironment?: string;
  } = {},
) {
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.spyOn(Date, "now").mockReturnValue(vectors.verifiedAt);
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
  vi.stubEnv("VITE_ACCESS_ENVIRONMENT", options.accessEnvironment ?? "sandbox");
  vi.stubEnv("VITE_BACKEND_ROUTE_PROFILE", options.accessEnvironment === "production" ? "production" : "shared-hosted-sandbox");
  vi.stubEnv(
    "VITE_ACCESS_PUBLIC_KEYS",
    JSON.stringify([
      {
        kid: "synthetic-access",
        publicKeyHex: vectors.publicKeyHex,
        purpose: "access",
        environment: "sandbox",
      },
    ]),
  );
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
      if (url.pathname.endsWith("/reconcile-entitlement") || url.pathname.endsWith("/qa-sandbox-reconcile-entitlement"))
        return respond(options.scopedReply ?? {});
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
  const authListeners: Array<
    Parameters<SupabaseClient["auth"]["onAuthStateChange"]>[0]
  > = [];
  boundary.configure = (client) => {
    const subscribe = client.auth.onAuthStateChange.bind(client.auth);
    vi.spyOn(client.auth, "onAuthStateChange").mockImplementation(
      (callback) => {
        authListeners.push(callback);
        return subscribe(callback);
      },
    );
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
    client: boundary.clients[0]!,
    authStorage: boundary.authStorage[0]!,
    emitAuth: (event: "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED") => {
      for (const listener of authListeners)
        void listener(event, event === "SIGNED_OUT" ? null : session);
    },
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
  boundary.authStorage.length = 0;
  boundary.configure = null;
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const signed = () => ({
  access: {
    status: "verified",
    environment: "sandbox",
    proofs: [vectors.vectors.find((v) => v.name === "paid-account")!.envelope],
    revocations: [],
    issuer_time: vectors.verifiedAt,
  },
});
describe("configured modern paid background scoped access", () => {
  it("holds the QA session spine when modern settings are not enabled", async () => {
    const h = await start({ signedIn: true, flag: "", scopedReply: signed() });
    expect(h.spine).toBeUndefined();
    expect(h.requests.some(r => /profiles|write_profile_settings|sync-settings|reconcile-entitlement/.test(r.path))).toBe(false);
  });
  it("consumes signed account proof through the maintained backend/session and single writer", async () => {
    const h = await start({
      signedIn: true,
      flag: "true",
      scopedReply: signed(),
    });
    vi.spyOn(Date, "now").mockReturnValue(vectors.verifiedAt);
    expect(await h.spine!.backend.reconcileEntitlementChecked()).toBe("ok");
    const record = (
      h.store["still:entitlement"] as {
        access: { accountId: string; sessionId: string; rights: unknown[] };
      }
    ).access;
    expect(record.accountId).toBe(USER);
    expect(record.sessionId).toBe(SESSION);
    expect(record.rights).toHaveLength(1);
    const projection = (await h.message({ kind: "observeBenefits" })) as {
      ok: boolean;
      snapshot: { states: Record<string, string>; refreshAfterMs: number };
    };
    expect(projection.ok).toBe(true);
    expect(projection.snapshot.states["youtube.comments"]).toBe("purchased");
    expect(
      h.requests.find((r) => r.path.endsWith("/qa-sandbox-reconcile-entitlement"))?.body,
    ).toEqual({ access_schema: 1 });
    expect(await h.spine!.backend.readEntitlement()).toBe("entitled");
    expect(
      h.requests.filter((r) => r.path.endsWith("/entitlements")),
    ).toHaveLength(0);
  });
  it("fresh authoritative no-right response unlocks the offer state only for its verified session", async () => {
    const h = await start({
      signedIn: true,
      flag: "true",
      scopedReply: {
        access: { ...signed().access, status: "none", proofs: [] },
      },
    });
    vi.spyOn(Date, "now").mockReturnValue(vectors.verifiedAt);
    expect(await h.spine!.backend.reconcileEntitlementChecked()).toBe("ok");
    // First projection near expiry must use the remaining absence lifetime, not start a new one.
    vi.mocked(Date.now).mockReturnValue(vectors.verifiedAt + 59_000);
    const reply = (await h.message({ kind: "observeBenefits" })) as {
      ok: boolean;
      snapshot: { states: Record<string, string>; refreshAfterMs: number };
    };
    expect(reply.ok).toBe(true);
    expect(reply.snapshot.states["instagram.explore"]).toBe("locked");
    expect(reply.snapshot.refreshAfterMs).toBeLessThanOrEqual(1000);
    vi.mocked(Date.now).mockReturnValue(vectors.verifiedAt + 60_001);
    const expired = (await h.message({
      kind: "observeBenefits",
    })) as typeof reply;
    expect(expired.snapshot.states["instagram.explore"]).toBe(
      "verification_required",
    );
  });
  it("same-account sign-out/sign-in during verified claims cannot write delayed account authority", async () => {
    const h = await start({
      signedIn: true,
      flag: "true",
      scopedReply: signed(),
    });
    vi.mocked(h.client.auth.getClaims).mockImplementationOnce(async () => {
      h.emitAuth("SIGNED_OUT");
      h.emitAuth("SIGNED_IN");
      return {
        data: {
          claims: { sub: USER, session_id: SESSION },
          header: { alg: "ES256", typ: "JWT" },
          signature: new Uint8Array(),
        },
        error: null,
      } as Awaited<ReturnType<typeof h.client.auth.getClaims>>;
    });
    expect(await h.spine!.backend.reconcileEntitlementChecked()).toBe(
      "unavailable",
    );
    await h.barrier();
    expect(
      (h.store["still:entitlement"] as { access?: { rights: unknown[] } })
        ?.access?.rights ?? [],
    ).toHaveLength(0);
  });
  it("missing SDK session is unknown and preserves the durable account lane", async () => {
    const h = await start({
      signedIn: true,
      flag: "true",
      scopedReply: signed(),
    });
    expect(await h.spine!.backend.reconcileEntitlementChecked()).toBe("ok");
    const before = structuredClone(
      (
        h.store["still:entitlement"] as {
          access: { generation: number; rights: unknown[] };
        }
      ).access,
    );
    vi.mocked(h.client.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    const reply = (await h.message({ kind: "observeBenefits" })) as {
      ok: boolean;
      snapshot: { states: Record<string, string> };
    };
    expect(reply.ok).toBe(true);
    expect(reply.snapshot.states["youtube.comments"]).toBe(
      "verification_required",
    );
    const after = (h.store["still:entitlement"] as { access: typeof before })
      .access;
    expect(after.generation).toBe(before.generation);
    expect(after.rights).toHaveLength(1);
  });
  it("token refresh after a durable proof write cannot clear the same account lane", async () => {
    const h = await start({
      signedIn: true,
      flag: "true",
      scopedReply: signed(),
    });
    const original = boundary.browser.storage.local.set;
    let refreshed = false;
    vi.spyOn(boundary.browser.storage.local, "set").mockImplementation(
      async (values) => {
        await original(values);
        if (
          !refreshed &&
          (
            (values as Record<string, unknown>)["still:entitlement"] as
              { access?: { rights: unknown[] } } | undefined
          )?.access?.rights.length
        ) {
          refreshed = true;
          h.emitAuth("TOKEN_REFRESHED");
        }
      },
    );
    expect(await h.spine!.backend.reconcileEntitlementChecked()).toBe(
      "unavailable",
    );
    const record = (
      h.store["still:entitlement"] as {
        access: { accountId: string; rights: unknown[] };
      }
    ).access;
    expect(record.accountId).toBe(USER);
    expect(record.rights).toHaveLength(1);
  });
  it("Boolean DB authority and mismatched packaged environment cannot grant", async () => {
    const h = await start({
      signedIn: true,
      flag: "true",
      scopedReply: { still_sync: true },
    });
    expect(await h.spine!.backend.reconcileEntitlementChecked()).toBe(
      "unavailable",
    );
    expect(await h.spine!.backend.readEntitlement()).toBe("unknown");
    expect(
      (h.store["still:entitlement"] as { access?: { rights: unknown[] } })
        ?.access?.rights ?? [],
    ).toHaveLength(0);
  });
  it("production packaging cannot consume sandbox proof or keys", async () => {
    const h = await start({
      signedIn: true,
      flag: "true",
      scopedReply: signed(),
      accessEnvironment: "production",
    });
    expect(await h.spine!.backend.reconcileEntitlementChecked()).toBe(
      "unavailable",
    );
    expect(await h.spine!.backend.readEntitlement()).toBe("unknown");
  });
  it("verified auth may persist a refreshed token through the settings queue without deadlock", async () => {
    const h = await start({
      signedIn: true,
      flag: "true",
      scopedReply: signed(),
    });
    vi.useRealTimers();
    vi.spyOn(Date, "now").mockReturnValue(vectors.verifiedAt);
    vi.mocked(h.client.auth.getClaims).mockImplementation(async () => {
      await h.authStorage.setItem("synthetic-refresh-probe", "synthetic");
      return {
        data: {
          claims: { sub: USER, session_id: SESSION },
          header: { alg: "ES256", typ: "JWT" },
          signature: new Uint8Array(),
        },
        error: null,
      } as Awaited<ReturnType<typeof h.client.auth.getClaims>>;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      h.spine!.backend.reconcileEntitlementChecked(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("deadlock"), 1000);
      }),
    ]);
    clearTimeout(timer);
    expect(outcome).toBe("ok");
    expect(h.store["synthetic-refresh-probe"]).toBe("synthetic");
  });
});
