import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { resolve } from "node:path";
import type { Component } from "svelte";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SETTINGS,
  readSettingsOperationRequest,
  type SettingsField,
  type SettingsV2,
  type UntrustedSettingsOperationRequest,
} from "@still/shared-types";
import { AtomicSettingsWriter, requireModernSettings } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { migrateSettingsV2 } from "../../storage/settings-v2.js";
import { WKWebViewStorageAdapter, type StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { mergeSettingsField } from "../../sync/field-order.js";
import { SupabaseBackendPort } from "../../sync/profile.js";
import { SyncService } from "../../sync/service.js";
import { createAppleSession } from "../../sync/apple-session.js";
import { makeBridge } from "../../sync/__tests__/support/apple-session-harness.js";
import { NativeBridge } from "../../native/bridge.js";
import { UiController } from "../controller.svelte.js";
import { STRINGS } from "../strings.js";
import { appleSettingsCacheOptions, appleSettingsHelp, createAppleSettingsAuthority } from "./apple-settings-host.js";

// U3-W4 P4: the Apple app's atomic-cloud composition, as packages/app-webview/src/main.ts builds it
// for a configured build with VITE_MODERN_SETTINGS_SYNC_ENABLED=true: the one atomic settings cache
// over the native App Group writer, the configured controller and AppleSession, and SyncService over
// SupabaseBackendPort with the modern settings option. The entry's construction is pinned in
// apple-settings-host.test.ts; this proves the composition it pins actually syncs and drives D04.

const ACCOUNT = "11111111-1111-1111-1111-111111111111";
const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LINEAGE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EMAIL = "person@example.com";

const HOST_PATH = resolve(import.meta.dirname, "../../../../app-webview/src/AppleSettingsHost.svelte");
async function loadHost(): Promise<Component<Record<string, unknown>>> {
  return ((await import(/* @vite-ignore */ HOST_PATH)) as { default: Component<Record<string, unknown>> }).default;
}
beforeAll(async () => {
  await loadHost();
}, 60_000);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fieldValue(settings: SettingsV2, path: SettingsField): boolean {
  if (path === "globalOn") return settings.globalOn;
  return (path.startsWith("services.") ? settings.services[path.slice(9)] : settings.sites[path.slice(6)]) as boolean;
}
function withField(settings: SettingsV2, path: SettingsField, on: boolean): SettingsV2 {
  if (path === "globalOn") return { ...settings, globalOn: on };
  const group = path.startsWith("services.") ? "services" : "sites";
  return { ...settings, [group]: { ...settings[group], [path.slice(group.length + 1)]: on } };
}

/** The native App Group writer behind the WK message shapes the app's bridge answers. */
function nativeAppGroup() {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 21, services: { ...DEFAULT_SETTINGS.services, facebook: false } });
  const writer = new AtomicSettingsWriter(storage);
  async function answer(message: { kind: string; command?: string; path?: string; value?: boolean; updatedAt?: number }): Promise<unknown> {
    switch (message.kind) {
      case "get":
        return (await storage.get()) ?? "";
      case "settingsAtomic": {
        const command = JSON.parse(message.command!) as { action: string; ownership?: "unknown"; accountId?: string | null; sessionId?: string; envelope?: never; scope?: never };
        if (command.action === "initialize") return writer.initialize(command.ownership!);
        if (command.action === "scope") return writer.enterScope(command.accountId ?? null, command.sessionId);
        if (command.action === "acknowledge") return writer.acknowledge(command.envelope!, command.scope!);
        return null;
      }
      case "settingsIntent": {
        const committed = await writer.commit({ path: message.path as SettingsField, value: message.value!, updatedAt: message.updatedAt! });
        const { intentCommitted, ...record } = committed as typeof committed & { intentCommitted?: boolean };
        return { changed: intentCommitted === true, record, status: "committed" };
      }
      default:
        return null;
    }
  }
  const postMessage = vi.fn((message: Parameters<typeof answer>[0]) => answer(message).catch(() => ({ status: "unavailable" })));
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: { postMessage } } } };
  return { storage, win, postMessage };
}

/** The account's row behind the sync-settings function: reads and receipt-bound operations. */
function syncSettingsServer() {
  const seed = migrateSettingsV2({ ...DEFAULT_SETTINGS, updatedAt: 1, services: { ...DEFAULT_SETTINGS.services, tiktok: false } }, { kind: "acknowledged-account", revision: 1 });
  if (seed.status !== "ready") throw new Error("fixture");
  let settings = seed.settings;
  let revision = 1;
  let lastWriteId: string | null = null;
  const operations: UntrustedSettingsOperationRequest[] = [];
  const response = () => ({ status: "ready", protocol: 2, empty: false, settings: structuredClone(settings), settingsVersion: revision,
    settingsServerUpdatedAt: "2026-10-05T00:00:00Z", writeId: lastWriteId, lineage: LINEAGE,
    receipt: { version: 1, lineage: LINEAGE, revision, mac: "A".repeat(43) } });
  const invoke = vi.fn(async (name: string, options: { body: unknown }) => {
    if (name !== "sync-settings") return { data: {}, error: null };
    if ((options.body as { action?: string }).action === "read") return { data: response(), error: null };
    const parsed = readSettingsOperationRequest(options.body);
    if (parsed.status !== "parsed") return { data: null, error: new Error("request-shape") };
    operations.push(parsed.request);
    for (const op of parsed.request.operations) {
      const current = { value: fieldValue(settings, op.path), stamp: settings.clocks[op.path] };
      const merged = mergeSettingsField(current, { value: op.value, stamp: { ...current.stamp, baseRevision: op.baseRevision, localStep: op.localStep } });
      settings = withField(settings, op.path, merged.value);
      settings = { ...settings, clocks: { ...settings.clocks, [op.path]: merged.stamp } };
    }
    revision += 1;
    lastWriteId = parsed.request.writeId;
    return { data: response(), error: null };
  });
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => "ok" };
  const builder = { select: () => builder, maybeSingle: async () => ({ data: null, error: null }) };
  const client = { functions: { invoke }, channel: () => channel, from: () => builder } as unknown as SupabaseClient;
  return { client, invoke, operations, settings: () => settings };
}

/** main.ts's atomic-cloud composition, with only the network and native ends faked. */
async function composeCloud(options: { modernSettings: boolean }) {
  const native = nativeAppGroup();
  const server = syncSettingsServer();
  const adapter = new WKWebViewStorageAdapter(native.win);
  const cache = new SettingsCache(adapter, appleSettingsCacheOptions("atomic-cloud"));
  cache.watch();
  void cache.hydrate().catch(() => {});
  let account: string | null = null;
  const authPort = {
    currentUserId: async () => account,
    currentSettingsSession: async () => (account === null ? null : { userId: account, sessionId: SESSION }),
    signOut: async () => {
      account = null;
    },
    signInWithMagicLink: async () => ({}),
  };
  // The entry's construction: modern settings for atomic-cloud (the negative control omits it).
  const backend = options.modernSettings
    ? new SupabaseBackendPort(server.client, { modernSettings: true })
    : new SupabaseBackendPort(server.client);
  // eslint-disable-next-line prefer-const -- assigned before any callback can fire, as in main.ts
  let session: ReturnType<typeof createAppleSession>;
  const sync = new SyncService(cache, authPort, backend, (state) => session.onSyncState(state));
  const controller = new UiController({
    cache,
    host: { canPurchase: true },
    auth: {
      requestCode: vi.fn(async () => ({ kind: "sent" as const })),
      verifyCode: vi.fn(),
      signOut: () => session.signOutEverywhere(),
      deleteAccount: () => session.deleteAccountEverywhere(),
    } as never,
  });
  session = createAppleSession({ controller, sync, bridge: makeBridge(), exchangeAppleCredential: async () => ({ userId: ACCOUNT }) });
  controller.retrySync = () => sync.retryNow();
  const authority = createAppleSettingsAuthority(cache, { native: new NativeBridge(native.win), initializer: adapter, hydration: cache.whenHydrated() });
  await authority.settled;
  return {
    native, server, cache, controller, session, sync, authority,
    async signIn() {
      account = ACCOUNT;
      await session.enterSession(ACCOUNT, EMAIL);
    },
  };
}

async function renderHost(f: Awaited<ReturnType<typeof composeCloud>>) {
  const Host = await loadHost();
  return render(Host, {
    props: { controller: f.controller, authority: f.authority, observeSetup: async () => null, help: appleSettingsHelp(vi.fn()) },
  });
}

describe("Apple atomic-cloud composition (configured, modern sync flag on)", () => {
  it("signed out: D04 shows saved choices, the decision 7 caption and a working Sign in, and nothing reaches the server", async () => {
    const f = await composeCloud({ modernSettings: true });
    await renderHost(f);
    expect(await screen.findByText("Optional. Blocking works without an account.")).toBeInTheDocument();
    expect(screen.queryByText(/Blocking and Still Pro work without an account/)).toBeNull();
    const signIn = screen.getByRole("button", { name: "Sign in" });
    expect(signIn).toBeEnabled();
    await fireEvent.click(signIn);
    expect(f.controller.signInOpen).toBe(true);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect((await f.native.storage.get())?.atomic?.ownership).toBe("unknown");
    expect(f.server.invoke).not.toHaveBeenCalled();
    f.authority.stop();
  });

  it("signing in links through modern sync: the account wins, D04 shows the account as synced, and a later choice uploads per field", async () => {
    const f = await composeCloud({ modernSettings: true });
    await renderHost(f);
    await f.signIn();
    await waitFor(() => expect(f.controller.lastSyncedAt).not.toBeNull());
    expect(f.controller.cloudReachable).toBe(true);
    // Owner decisions 28/29: an unknown-owner device adopts the account's values on first link.
    const saved = (await f.native.storage.get())!;
    expect(saved.atomic).toMatchObject({ ownership: "previous-account", scope: { accountId: ACCOUNT, sessionId: SESSION }, paused: null });
    expect(requireModernSettings(saved).services).toMatchObject({ tiktok: false, facebook: true });
    expect(await screen.findByText(EMAIL)).toBeInTheDocument();
    expect(await screen.findByText(STRINGS.sync.synced)).toBeInTheDocument();
    expect(screen.queryByText("Optional. Blocking works without an account.")).toBeNull();
    expect(f.server.invoke.mock.calls.every(([name]) => name === "sync-settings" || name === "reconcile-entitlement")).toBe(true);

    // A deliberate D04 choice is one committed native intent, then one receipt-bound operation.
    const before = f.server.operations.length;
    expect(await f.authority.binding.setService("youtube", false)).toEqual({ status: "committed" });
    await waitFor(() => expect(f.server.operations.length).toBe(before + 1));
    expect(f.server.operations.at(-1)!.operations).toEqual([expect.objectContaining({ path: "services.youtube", value: false })]);
    await waitFor(() => expect(fieldValue(f.server.settings(), "services.youtube")).toBe(false));
    await waitFor(async () => expect((await f.native.storage.get())!.atomic!.pending).toEqual([]));
    f.authority.stop();
  });

  it("negative control: the legacy backend construction over the atomic cache holds sync (rollout held) and never writes", async () => {
    const f = await composeCloud({ modernSettings: false });
    await renderHost(f);
    await f.signIn();
    await waitFor(() => expect(f.controller.cloudReachable).toBe(false));
    expect(f.controller.lastSyncedAt).toBeNull();
    expect(await screen.findByText(STRINGS.sync.unreachable)).toBeInTheDocument();
    expect(f.server.invoke.mock.calls.some(([name]) => name === "sync-settings")).toBe(false);
    expect(f.server.operations).toEqual([]);
    f.authority.stop();
  });
});
