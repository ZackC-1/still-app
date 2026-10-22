import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Pinned to the dormant configuration (paid tier compiled off). The 3.x release ships the paid tier on;
// these cases keep the free-only fallback covered, and the *.paid-on suites cover the shipped value.
vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: false,
}));
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
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
function nativeAppGroup(start: "upgrade" | "first-record") {
  // "upgrade": a saved 2.x record (Facebook Off). "first-record": the new-install record the app
  // saves on first launch (owner decision 28), never linked.
  const storage = new InMemoryStorageAdapter(start === "upgrade"
    ? { ...DEFAULT_SETTINGS, updatedAt: 21, services: { ...DEFAULT_SETTINGS.services, facebook: false } }
    : null);
  const writer = new AtomicSettingsWriter(storage);
  const ready = start === "first-record" ? writer.initializeFresh(async () => true) : Promise.resolve();
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
  const postMessage = vi.fn((message: Parameters<typeof answer>[0]) => ready.then(() => answer(message)).catch(() => ({ status: "unavailable" })));
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: { postMessage } } } };
  return { storage, win, postMessage };
}

/** The account's row behind the sync-settings function: reads and receipt-bound operations. */
function syncSettingsServer(account: "saved" | "empty") {
  // "saved": an account with TikTok Off at revision 1. "empty": an account that has never saved.
  const seed = account === "saved"
    ? migrateSettingsV2({ ...DEFAULT_SETTINGS, updatedAt: 1, services: { ...DEFAULT_SETTINGS.services, tiktok: false } }, { kind: "acknowledged-account", revision: 1 })
    : migrateSettingsV2(null, { kind: "proven-fresh" });
  if (seed.status !== "ready") throw new Error("fixture");
  let settings = seed.settings;
  let revision = account === "saved" ? 1 : 0;
  let lastWriteId: string | null = null;
  const operations: UntrustedSettingsOperationRequest[] = [];
  let failing = false;
  const response = () => ({ status: "ready", protocol: 2, empty: revision === 0, settings: structuredClone(settings), settingsVersion: revision,
    settingsServerUpdatedAt: "2026-10-05T00:00:00Z", writeId: lastWriteId, lineage: LINEAGE,
    receipt: { version: 1, lineage: LINEAGE, revision, mac: "A".repeat(43) } });
  const invoke = vi.fn(async (name: string, options: { body: unknown }) => {
    if (name !== "sync-settings") return { data: {}, error: null };
    if (failing) return { data: null, error: new Error("offline") };
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
    settings = { ...settings, updatedAt: 100 + revision };
    return { data: response(), error: null };
  });
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => "ok" };
  const builder = { select: () => builder, maybeSingle: async () => ({ data: null, error: null }) };
  const client = { functions: { invoke }, channel: () => channel, from: () => builder } as unknown as SupabaseClient;
  return {
    client, invoke, operations, settings: () => settings,
    /** Another signed-in device's saved change, as the function would record it. */
    remoteEdit(path: SettingsField, on: boolean) {
      const stamp = { ...settings.clocks[path], baseRevision: revision, localStep: 1 };
      settings = withField(settings, path, on);
      settings = { ...settings, clocks: { ...settings.clocks, [path]: stamp } };
      revision += 1;
      lastWriteId = null;
      settings = { ...settings, updatedAt: 100 + revision };
    },
    fail(next: boolean) {
      failing = next;
    },
  };
}

/** main.ts's atomic-cloud composition, with only the network and native ends faked. */
async function composeCloud(options: { modernSettings: boolean; start?: "upgrade" | "first-record"; account?: "saved" | "empty"; now?: () => number }) {
  const native = nativeAppGroup(options.start ?? "upgrade");
  const server = syncSettingsServer(options.account ?? "saved");
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
  const sync = new SyncService(cache, authPort, backend, (state) => session.onSyncState(state), undefined, options.now ?? Date.now);
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

const SYNC_LINE = "Sync settings across devices and browsers. Free.";

async function renderHost(f: Awaited<ReturnType<typeof composeCloud>>, platform?: "ios" | "mac") {
  const Host = await loadHost();
  const observeSetup = platform === "mac"
    ? async () => ({ ok: true, platform: "macos", extensionStatus: "enabled", enableLocation: "safariExtensionSettings" } as const)
    : platform === "ios"
      ? async () => ({ ok: true, platform: "ios", extensionStatus: "unknown", enableLocation: "settingsAppStillPage" } as const)
      : async () => null;
  return render(Host, {
    props: { controller: f.controller, authority: f.authority, observeSetup, help: appleSettingsHelp(vi.fn()) },
  });
}

describe("Apple atomic-cloud composition (configured, modern sync flag on)", () => {
  it("signed out: D04 shows saved choices, the sync card's one line and a working Sign in, and nothing reaches the server", async () => {
    const f = await composeCloud({ modernSettings: true });
    await renderHost(f);
    expect(await screen.findByText(SYNC_LINE)).toBeInTheDocument();
    // The optional-account caption is gone (owner, ISS-0029 item 11).
    expect(screen.queryByText(/without an account/)).toBeNull();
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
    expect(screen.queryByText(SYNC_LINE)).toBeNull();
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

  it("signed out, a D04 choice is one committed native intent and never reaches the server", async () => {
    const f = await composeCloud({ modernSettings: true });
    await renderHost(f);
    await screen.findByText(SYNC_LINE);
    expect(await f.authority.binding.setService("youtube", false)).toEqual({ status: "committed" });
    await waitFor(async () => expect(requireModernSettings((await f.native.storage.get())!).services.youtube).toBe(false));
    // Give any write-through a chance to run: still nothing for the server.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(f.server.invoke).not.toHaveBeenCalled();
    expect(f.native.postMessage.mock.calls.filter(([m]) => m.kind === "settingsIntent")).toHaveLength(1);
    f.authority.stop();
  });

  it("a new install's pre-sign-in choice: an account with saved settings wins (decision 29), an empty account is seeded with it", async () => {
    for (const account of ["saved", "empty"] as const) {
      const f = await composeCloud({ modernSettings: true, start: "first-record", account });
      expect((await f.native.storage.get())!.atomic?.ownership).toBe("never-linked");
      // Before signing in, the person turns Instagram Off on this new install.
      expect(await f.authority.binding.setService("instagram", false)).toEqual({ status: "committed" });
      expect(f.server.invoke).not.toHaveBeenCalled();
      await f.signIn();
      await waitFor(() => expect(f.controller.lastSyncedAt).not.toBeNull());
      await waitFor(async () => expect((await f.native.storage.get())!.atomic!.pending).toEqual([]));
      const device = requireModernSettings((await f.native.storage.get())!);
      if (account === "saved") {
        // The account's saved settings win: Instagram follows the account (On), TikTok Off arrives.
        expect(device.services).toMatchObject({ instagram: true, tiktok: false });
        expect(fieldValue(f.server.settings(), "services.instagram")).toBe(true);
      } else {
        // An account that never saved starts from this device's choice.
        expect(device.services).toMatchObject({ instagram: false, tiktok: true });
        expect(fieldValue(f.server.settings(), "services.instagram")).toBe(false);
      }
      expect(f.controller.cloudReachable).toBe(true);
      f.authority.stop();
    }
  });

  it("negative control: the legacy backend construction over the atomic cache holds sync (rollout held) and never writes", async () => {
    const f = await composeCloud({ modernSettings: false });
    await renderHost(f);
    await f.signIn();
    await waitFor(() => expect(f.controller.cloudReachable).toBe(false));
    expect(f.controller.lastSyncedAt).toBeNull();
    expect(await screen.findByText(STRINGS.sync.failed)).toBeInTheDocument();
    expect(f.server.invoke.mock.calls.some(([name]) => name === "sync-settings")).toBe(false);
    expect(f.server.operations).toEqual([]);
    f.authority.stop();
  });
});

// ISS-0061: the app's sync card shows when it last synced, as the Chrome popup does (ISS-0056):
// "Synced with your account. · Oct 15 at 2:24 PM", the time of the last successful cloud exchange.
describe("Apple sync card: last successful sync time (ISS-0061)", () => {
  // The Chrome popup's exact format (DesktopPopup.svelte), so both read the same.
  // SyncSummary's form for a day that is neither today nor yesterday (owner, 19 Oct).
  const chromeTime = (ms: number) =>
    `${new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  const card = () => document.querySelector<HTMLElement>('[data-still-card="sync"]')!;
  const clock = () => {
    const c = { t: Date.UTC(2026, 9, 15, 21, 24), now: () => c.t };
    return c;
  };

  for (const platform of ["ios", "mac"] as const) {
    it(`${platform}: after a sync the card shows that sync's time beside the success line, and it advances when another device's edit converges`, async () => {
      const time = clock();
      const f = await composeCloud({ modernSettings: true, now: time.now });
      await renderHost(f, platform);
      await screen.findByText(SYNC_LINE);
      // Signed out: no time anywhere on the card.
      expect(card().querySelector("time")).toBeNull();
      await f.signIn();
      await waitFor(() => expect(f.controller.lastSyncedAt).not.toBeNull());
      const first = f.controller.lastSyncedAt!;
      const status = (await screen.findByText(STRINGS.sync.synced)).closest<HTMLElement>('[role="status"]')!;
      await waitFor(() => expect(status.querySelector("time")).not.toBeNull());
      expect(card().querySelectorAll("time")).toHaveLength(1);
      expect(status.querySelector("time")!.dateTime).toBe(new Date(first).toISOString());
      expect(status.querySelector("time")!.textContent).toBe(chromeTime(first));
      expect(status.textContent!.replace(/\s+/g, " ").trim()).toBe(`${STRINGS.sync.synced} · ${STRINGS.sync.lastSynced} ${chromeTime(first)}`);
      // On success the label is for screen readers only, as on Chrome.
      expect(within(status).getByText(STRINGS.sync.lastSynced, { exact: false }).classList.contains("sr-only")).toBe(true);

      // Another device turns Instagram Off; the nudge's refresh converges it and records the exchange.
      time.t += 7 * 60_000;
      f.server.remoteEdit("services.instagram", false);
      await f.sync.retryNow();
      await waitFor(async () => expect(requireModernSettings((await f.native.storage.get())!).services.instagram).toBe(false));
      await waitFor(() => expect(f.controller.lastSyncedAt).toBe(time.t));
      await waitFor(() => expect(card().querySelector("time")!.dateTime).toBe(new Date(time.t).toISOString()));
      expect(card().querySelector("time")!.textContent).toBe(chromeTime(time.t));
      f.authority.stop();
    });
  }

  it("a failed sync keeps the earlier good time with a visible label; signing out removes it", async () => {
    const time = clock();
    const f = await composeCloud({ modernSettings: true, now: time.now });
    await renderHost(f);
    await f.signIn();
    await waitFor(() => expect(f.controller.lastSyncedAt).not.toBeNull());
    const good = f.controller.lastSyncedAt!;
    await waitFor(() => expect(card().querySelector("time")).not.toBeNull());
    time.t += 60_000;
    f.server.fail(true);
    await f.sync.retryNow();
    await waitFor(() => expect(f.controller.cloudReachable).toBe(false));
    const alert = (await screen.findByText(STRINGS.sync.failed)).closest<HTMLElement>('[role="alert"]')!;
    await waitFor(() => expect(alert.querySelector("time")?.dateTime).toBe(new Date(good).toISOString()));
    // Never the failed attempt's time, and the label is visible so the time is not read as success.
    const label = within(alert).getByText(STRINGS.sync.lastSynced, { exact: false });
    expect(label.classList.contains("sr-only")).toBe(false);
    expect(alert.textContent!.replace(/\s+/g, " ")).toContain(`${STRINGS.sync.lastSynced} ${chromeTime(good)}`);
    expect(within(alert).getByRole("button", { name: STRINGS.sync.tryAgain })).toBeEnabled();
    f.server.fail(false);
    await f.session.signOutEverywhere();
    await screen.findByText(SYNC_LINE);
    expect(card().querySelector("time")).toBeNull();
    f.authority.stop();
  });

  it("no time before any successful sync: the held rollout shows the failure copy alone", async () => {
    const f = await composeCloud({ modernSettings: false });
    await renderHost(f);
    await f.signIn();
    await waitFor(() => expect(f.controller.cloudReachable).toBe(false));
    expect(await screen.findByText(STRINGS.sync.failed)).toBeInTheDocument();
    expect(f.controller.lastSyncedAt).toBeNull();
    expect(card().querySelector("time")).toBeNull();
    expect(card().textContent).not.toContain(STRINGS.sync.lastSynced);
    f.authority.stop();
  });
});
