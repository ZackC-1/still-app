import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Component } from "svelte";
import type { SafariSetupObservation } from "../../native/bridge.js";
import { DEFAULT_SETTINGS, type StillSettings } from "@still/shared-types";
import { AtomicSettingsWriter, requireModernSettings } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { WKWebViewStorageAdapter, type StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { NativeBridge } from "../../native/bridge.js";
import { UiController, type UiAnalytics } from "../controller.svelte.js";
import { STRINGS } from "../strings.js";
import { PRIVACY_POLICY_URL } from "../config.js";
import { createDesktopPopupBinding } from "./desktop-popup-binding.js";
import { EntitlementCache } from "../../entitlement/cache.js";
import {
  appleSettingsCacheOptions,
  appleSettingsHelp,
  appleSettingsPlatform,
  appleSettingsRestore,
  appleSettingsSetup,
  appleSettingsSync,
  APPLE_SETUP_OBSERVATION_DEADLINE_MS,
  observeAppleSetup,
  watchAppleSetup,
  appleSettingsToggleReporter,
  createAppleSettingsAuthority,
  openExternalLink,
  selectAppleSettingsMode,
  type AppleSettingsAccountSource,
} from "./apple-settings-host.js";

// The host component lives in packages/app-webview (the only bundle allowed to carry D04's global
// stylesheet). It is loaded by a computed path (as other cross-package tests here do) so core's
// typecheck stays inside its rootDir.
const HOST_PATH = resolve(import.meta.dirname, "../../../../app-webview/src/AppleSettingsHost.svelte");
const MAIN_PATH = resolve(import.meta.dirname, "../../../../app-webview/src/main.ts");
async function loadHost(): Promise<Component<Record<string, unknown>>> {
  const module = (await import(/* @vite-ignore */ HOST_PATH)) as { default: Component<Record<string, unknown>> };
  return module.default;
}

type NativeMessage = { kind: string; command?: string; path?: string; value?: boolean; updatedAt?: number };

/** A fake App Group host: the existing atomic writer behind the WK message shapes. */
function fakeNative(seed: StillSettings = DEFAULT_SETTINGS, options: { fail?: string[]; initialized?: Promise<void> } = {}) {
  const storage = new InMemoryStorageAdapter(seed);
  const writer = new AtomicSettingsWriter(storage);
  const fail = new Set<string>(options.fail);
  const messages: NativeMessage[] = [];
  const postMessage = vi.fn(async (message: NativeMessage): Promise<unknown> => {
    messages.push(message);
    if (fail.has(message.kind)) return null;
    switch (message.kind) {
      case "get":
        return (await storage.get()) ?? "";
      case "settingsAtomic": {
        await options.initialized;
        const command = JSON.parse(message.command!) as { action: string; ownership?: "unknown" };
        return command.action === "initialize" ? writer.initialize(command.ownership!) : null;
      }
      case "settingsIntent": {
        const committed = await writer.commit({ path: message.path as never, value: message.value!, updatedAt: message.updatedAt! });
        const { intentCommitted, ...record } = committed as typeof committed & { intentCommitted?: boolean };
        return { changed: intentCommitted === true, record };
      }
      default:
        return null;
    }
  });
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: { postMessage } } } };
  return { storage, writer, fail, messages, postMessage, win };
}

function analyticsDouble(enabled = true) {
  const setSharing = vi.fn(async (next: boolean) => next);
  const analytics: UiAnalytics = {
    track: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    sharing: async () => ({ enabled, noticeNeeded: false }),
    setSharing,
  };
  return { analytics, setSharing };
}

async function composeAtomic(seed?: StillSettings, options?: Parameters<typeof fakeNative>[1]) {
  const native = fakeNative(seed, options);
  const cache = new SettingsCache(new WKWebViewStorageAdapter(native.win), appleSettingsCacheOptions("atomic"));
  cache.watch();
  const bridge = new NativeBridge(native.win);
  const authority = createAppleSettingsAuthority(cache, bridge);
  const { analytics, setSharing } = analyticsDouble();
  const controller = new UiController({ cache, host: { canPurchase: true }, analytics });
  return { native, cache, authority, controller, setSharing, hydrated: cache.hydrate() };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Apple settings mode rule", () => {
  it.each([
    [undefined, undefined, true, "atomic"],
    ["", "", true, "atomic"],
    ["https://still-audit.invalid", undefined, true, "atomic"],
    [undefined, "public-audit-placeholder", true, "atomic"],
    [undefined, undefined, false, "legacy"],
    ["https://still-audit.invalid", "public-audit-placeholder", true, "legacy"],
    ["https://still-audit.invalid", "public-audit-placeholder", false, "legacy"],
  ] as const)("url=%s key=%s port=%s -> %s", (supabaseUrl, supabaseAnonKey, nativePort, mode) => {
    expect(selectAppleSettingsMode({ supabaseUrl, supabaseAnonKey, nativePort })).toBe(mode);
  });

  it("keeps the legacy cache construction and gives atomic mode unknown ownership", () => {
    expect(appleSettingsCacheOptions("legacy")).toBeUndefined();
    expect(appleSettingsCacheOptions("atomic")).toEqual({ atomicOwnership: "unknown" });
  });

  it("entry: inline build-time pre-filter, one dynamic host import, no Apple modern-sync opt-in", () => {
    const main = readFileSync(MAIN_PATH, "utf8");
    expect(main).toMatch(/!\(\s*import\.meta\.env\.VITE_SUPABASE_URL && import\.meta\.env\.VITE_SUPABASE_ANON_KEY\s*\)\s*\?\s*selectAppleSettingsMode\(/);
    expect(main).toContain('import("./AppleSettingsHost.svelte")');
    expect(main).not.toMatch(/^import[^;]*AppleSettingsHost/m);
    expect(main).not.toMatch(/AppleSettings\.svelte/);
    expect(main).not.toContain("VITE_MODERN_SETTINGS_SYNC_ENABLED");
    // Exactly the shipped legacy construction remains on the legacy branch.
    expect(main).toContain(": new SettingsCache(new WKWebViewStorageAdapter());");
    const index = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");
    expect(index).not.toMatch(/AppleSettings\.svelte/);
  });
});

describe("one cache and writer", () => {
  it("atomic hydration initializes through native with unknown ownership; legacy reads only", async () => {
    const atomic = fakeNative();
    const cache = new SettingsCache(new WKWebViewStorageAdapter(atomic.win), appleSettingsCacheOptions("atomic"));
    await cache.hydrate();
    expect(atomic.messages.map((m) => m.kind)).toEqual(["settingsAtomic"]);
    expect(JSON.parse(atomic.messages[0]!.command!)).toEqual({ action: "initialize", ownership: "unknown" });
    expect(cache.currentRecord().atomic?.ownership).toBe("unknown");

    const legacy = fakeNative();
    const legacyCache = new SettingsCache(new WKWebViewStorageAdapter(legacy.win), appleSettingsCacheOptions("legacy"));
    await legacyCache.hydrate();
    expect(legacy.messages.map((m) => m.kind)).toEqual(["get"]);
    expect(legacyCache.currentRecord().atomic).toBeUndefined();
  });

  it("commands go through the same cache and port; no second adapter", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const before = f.native.postMessage.mock.calls.length;
    expect((await f.authority.binding.setService("youtube", false)).status).toBe("committed");
    const sent = f.native.messages.slice(before);
    expect(sent).toEqual([expect.objectContaining({ kind: "settingsIntent", path: "services.youtube", value: false })]);
    expect(requireModernSettings((await f.native.storage.get())!).services.youtube).toBe(false);
    expect(f.authority.binding.current().settings?.services.youtube).toBe(false);
    f.authority.stop();
  });
});

describe("no native port", () => {
  it("is never presented as saved defaults", async () => {
    const empty: StillBridgeWindow = {};
    expect(selectAppleSettingsMode({ supabaseUrl: undefined, supabaseAnonKey: undefined, nativePort: new NativeBridge(empty).available })).toBe("legacy");
    // The legacy cache reports absence, and committed authority over it holds instead of projecting.
    const cache = new SettingsCache(new WKWebViewStorageAdapter(empty));
    await cache.hydrate();
    expect(cache.legacyReadState().status).toBe("absent");
    const binding = createDesktopPopupBinding(cache, new EntitlementCache({ get: async () => null, set: async () => {}, subscribe: () => () => {} }));
    expect(binding.current().settings).toBeNull();
    // Even a forced atomic cache without a port holds rather than inventing choices.
    const forced = new SettingsCache(new WKWebViewStorageAdapter(empty), appleSettingsCacheOptions("atomic"));
    await expect(forced.hydrate()).rejects.toMatchObject({ reason: "native-atomic-unavailable" });
    const held = createAppleSettingsAuthority(forced, new NativeBridge(empty));
    expect(held.binding.current().settings).toBeNull();
    expect(held.binding.current().commandAvailability).toBe("unavailable");
    binding.stop();
    held.stop();
  });
});

describe("D04 host", () => {
  async function renderHost(f: Awaited<ReturnType<typeof composeAtomic>>, overrides: Record<string, unknown> = {}) {
    const Host = await loadHost();
    const open = vi.fn();
    const report = vi.fn();
    const view = render(Host, {
      props: {
        controller: f.controller,
        binding: f.authority.binding,
        platform: "ios",
        initialSetup: undefined,
        observeSetup: async () => null,
        help: appleSettingsHelp(open),
        settingsRead: f.cache.whenHydrated(),
        onCommittedToggle: report,
        ...overrides,
      },
    });
    return { view, open, report };
  }

  it("holds without saved choices until committed authority arrives, then shows saved Off as saved", async () => {
    let initialize!: () => void;
    const initialized = new Promise<void>((r) => { initialize = r; });
    const f = await composeAtomic({ ...DEFAULT_SETTINGS, updatedAt: 21, services: { ...DEFAULT_SETTINGS.services, youtube: false } }, { initialized });
    await renderHost(f);
    // Before native initialization: no switches, no hero, no defaults.
    expect(screen.queryByRole("switch", { name: "Still" })).toBeNull();
    expect(screen.queryByText("Still is active")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(STRINGS.sync.checking);
    initialize();
    await f.hydrated;
    await screen.findByText("Still is active");
    await fireEvent.click(screen.getByRole("button", { name: "YouTube Blocker" }));
    expect(screen.getByRole("switch", { name: "Still on YouTube" })).toHaveAttribute("aria-checked", "false");
    f.authority.stop();
  });

  it("commits toggles through the binding and reports only committed toggles", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const { report } = await renderHost(f);
    await fireEvent.click(await screen.findByRole("switch", { name: "Still" }));
    await screen.findByText("Still is off");
    expect(requireModernSettings((await f.native.storage.get())!).globalOn).toBe(false);
    await waitFor(() => expect(report).toHaveBeenCalledWith({ enabled: false }));
    f.authority.stop();
  });

  it("leaves the displayed saved choice unchanged when native refuses a command", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const { report } = await renderHost(f);
    f.native.fail.add("settingsIntent");
    await fireEvent.click(await screen.findByRole("switch", { name: "Still" }));
    await waitFor(() => expect(f.native.messages.some((m) => m.kind === "settingsIntent")).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("Still is active")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Still" })).toHaveAttribute("aria-checked", "true");
    expect(requireModernSettings((await f.native.storage.get())!).globalOn).toBe(true);
    expect(report).not.toHaveBeenCalled();
    f.authority.stop();
  });

  it("shows an unavailable hold with retry when native initialization fails", async () => {
    const f = await composeAtomic(undefined, { fail: ["settingsAtomic"] });
    await expect(f.hydrated).rejects.toMatchObject({ reason: "native-atomic-unavailable" });
    await renderHost(f);
    expect(await screen.findByText("Settings are unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.queryByRole("switch", { name: "Still" })).toBeNull();
    f.authority.stop();
  });

  it("paid tier off: no Still Pro card, Buy, price or Restore entry; Pro rows are not owned", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    await renderHost(f);
    await screen.findByText("Still is active");
    expect(screen.queryByText("Get Still Pro")).toBeNull();
    expect(screen.queryByText(/Checking your Still Pro access/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore purchase" })).toBeNull();
    expect(screen.queryByText(/\$\d/)).toBeNull();
    expect(screen.queryByText("Purchased")).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings sync" })).toBeInTheDocument();
    f.authority.stop();
  });

  it("renders the existing usage-sharing control, driven by the native consent setter, never the combined card", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    await renderHost(f);
    const usage = await screen.findByRole("switch", { name: STRINGS.usage.title });
    expect(usage).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("Share email and usage data")).toBeNull();
    expect(screen.queryByText(/Share your email and usage data/)).toBeNull();
    await fireEvent.click(usage);
    expect(f.setSharing).toHaveBeenCalledWith(false);
    await waitFor(() => expect(usage).toHaveAttribute("aria-checked", "false"));
    f.authority.stop();
  });

  it("offers privacy through the shipped URL and leaves guide and support unsupplied", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const { open } = await renderHost(f);
    await fireEvent.click(await screen.findByRole("button", { name: "Privacy policy" }));
    expect(open).toHaveBeenCalledWith(PRIVACY_POLICY_URL);
    expect(screen.getByRole("button", { name: "Setup guide" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Contact support" })).toBeDisabled();
    f.authority.stop();
  });

  it("without an account in this build, sign-in is not offered", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    await renderHost(f);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeDisabled();
    f.authority.stop();
  });

  it("opens the existing code sign-in sheet when the controller has a sign-in path", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const controller = new UiController({
      cache: f.cache,
      host: { canPurchase: true },
      auth: { requestCode: vi.fn(), verifyCode: vi.fn(), signOut: vi.fn() } as never,
    });
    await renderHost(f, { controller });
    await fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(controller.signInOpen).toBe(true);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    f.authority.stop();
  });

  it("shows the approved Mac setup card only while native observes the extension off", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    let next: SafariSetupObservation | null = { ...MAC, extensionStatus: "disabled" };
    await renderHost(f, {
      platform: "mac",
      initialSetup: appleSettingsSetup(next),
      observeSetup: async () => next,
    });
    expect(await screen.findByRole("heading", { name: "Turn on Still in Safari" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(expect.arrayContaining(MAC_STEPS));
    expect(screen.getByRole("button", { name: "Open Safari Settings" })).toBeDisabled();
    next = { ...MAC, extensionStatus: "enabled" };
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Turn on Still in Safari" })).toBeNull());
    f.authority.stop();
  });

  it("stops the binding and releases its listeners when the host unmounts", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const stop = vi.spyOn(f.authority.binding, "stop");
    const subscribe = f.authority.binding.subscribe;
    const released = vi.fn();
    vi.spyOn(f.authority.binding, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      return () => {
        released();
        unsubscribe();
      };
    });
    const { view } = await renderHost(f);
    await screen.findByText("Still is active");
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    expect(f.authority.binding.current().reason).toBe("stopped");
    // A later saved change cannot reach a stopped view; the shared cache keeps working.
    const before = f.native.messages.length;
    expect((await f.authority.binding.setGlobalOn(false)).status).toBe("unavailable");
    expect(f.native.messages.length).toBe(before);
    f.authority.stop();
  });
});

const MAC = { ok: true, platform: "macos", enableLocation: "safariExtensionSettings" } as const;
const IOS: SafariSetupObservation = { ok: true, platform: "ios", extensionStatus: "unknown", enableLocation: "settingsAppStillPage" };
const MAC_STEPS = ["Open Safari, then Settings, then Extensions.", "Turn on Still.", "Allow it on every website."];

describe("Safari setup card", () => {
  it("macOS disabled -> the approved card with exact steps and no invented action", () => {
    expect(appleSettingsSetup({ ...MAC, extensionStatus: "disabled" })).toEqual({
      title: "Turn on Still in Safari",
      detail: "Still works inside Safari. Your choices are saved and start working once it's on.",
      steps: MAC_STEPS,
      actionLabel: "Open Safari Settings",
    });
  });

  it.each([
    ["macOS enabled", { ...MAC, extensionStatus: "enabled" } as SafariSetupObservation],
    ["macOS unknown", { ...MAC, extensionStatus: "unknown" } as SafariSetupObservation],
    ["iOS", IOS],
    ["no observation", null],
  ])("%s -> no card", (_name, observation) => {
    expect(appleSettingsSetup(observation)).toBeUndefined();
  });

  it("a late, failed or missing native reply is treated as not observable", async () => {
    vi.useFakeTimers();
    try {
      const late = observeAppleSetup(() => new Promise<SafariSetupObservation | null>(() => {}));
      await vi.advanceTimersByTimeAsync(APPLE_SETUP_OBSERVATION_DEADLINE_MS);
      expect(await late).toBeNull();
      expect(appleSettingsSetup(await late)).toBeUndefined();
      expect(await observeAppleSetup(() => Promise.reject(new Error("down")))).toBeNull();
      const disabled = { ...MAC, extensionStatus: "disabled" } as SafariSetupObservation;
      expect(await observeAppleSetup(async () => disabled)).toBe(disabled);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-observes on return to the foreground, latest read wins, and stops cleanly", async () => {
    const replies: Array<(value: SafariSetupObservation | null) => void> = [];
    const read = vi.fn(() => new Promise<SafariSetupObservation | null>((r) => replies.push(r)));
    const publish = vi.fn();
    const stop = watchAppleSetup(read, publish, document, 60_000);
    expect(read).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    replies[1]!({ ...MAC, extensionStatus: "enabled" });
    replies[0]!({ ...MAC, extensionStatus: "disabled" });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(undefined);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    stop();
    replies[2]!({ ...MAC, extensionStatus: "disabled" });
    await new Promise((r) => setTimeout(r, 0));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("account, restore, help and telemetry mapping", () => {
  function source(overrides: Partial<AppleSettingsAccountSource> = {}): AppleSettingsAccountSource {
    return {
      userId: null,
      accountEmail: null,
      accountRevision: 3,
      cloudReachable: true,
      pendingUpload: false,
      lastSyncedAt: null,
      retrySync: undefined,
      canSignIn: false,
      canDeleteAccount: false,
      deleteFlow: "idle",
      openSignIn: vi.fn(),
      signOut: vi.fn(async () => {}),
      confirmDeleteAccount: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("signed out: sign-in only when a code path exists", () => {
    expect(appleSettingsSync(source()).onSignIn).toBeUndefined();
    const s = source({ canSignIn: true });
    appleSettingsSync(s).onSignIn!();
    expect(s.openSignIn).toHaveBeenCalledOnce();
    expect(appleSettingsSync(s).account).toBeUndefined();
  });

  it("signed in: identity is the user id, revision the controller epoch, missing email stays missing", () => {
    const s = source({ userId: "user-1", canDeleteAccount: true, lastSyncedAt: 5 });
    const sync = appleSettingsSync(s);
    expect(sync.account).toMatchObject({ address: "", identity: "user-1", revision: 3, confirmed: false, status: { tone: "success", text: STRINGS.sync.synced } });
    sync.account!.onSignOut!();
    sync.account!.onDeleteAccount!();
    expect(s.signOut).toHaveBeenCalledOnce();
    expect(s.confirmDeleteAccount).toHaveBeenCalledOnce();
    expect(appleSettingsSync(source({ userId: "u", accountEmail: "a@b.c" })).account?.address).toBe("a@b.c");
  });

  it("operations bound to an earlier account revision do nothing", () => {
    const s = source({ userId: "user-1", canDeleteAccount: true, retrySync: vi.fn(async () => {}), cloudReachable: false });
    const sync = appleSettingsSync(s);
    (s as { accountRevision: number }).accountRevision = 4;
    sync.account!.onSignOut!();
    sync.account!.onDeleteAccount!();
    sync.account!.status!.onAction!();
    expect(s.signOut).not.toHaveBeenCalled();
    expect(s.confirmDeleteAccount).not.toHaveBeenCalled();
    expect(s.retrySync).not.toHaveBeenCalled();
  });

  it("no delete without the capability or while deleting; status follows the operation", () => {
    expect(appleSettingsSync(source({ userId: "u" })).account).not.toHaveProperty("onDeleteAccount");
    const deleting = appleSettingsSync(source({ userId: "u", canDeleteAccount: true, deleteFlow: "deleting" })).account!;
    expect(deleting.onDeleteAccount).toBeUndefined();
    expect(deleting.status).toEqual({ tone: "pending", text: STRINGS.account.deleting });
    expect(appleSettingsSync(source({ userId: "u", deleteFlow: "error" })).account!.status).toEqual({ tone: "failed", text: STRINGS.account.deleteError });
    const retry = vi.fn(async () => {});
    const unreachable = appleSettingsSync(source({ userId: "u", cloudReachable: false, retrySync: retry })).account!.status!;
    expect(unreachable).toMatchObject({ tone: "failed", text: STRINGS.sync.unreachable, actionLabel: STRINGS.sync.retry });
    unreachable.onAction!();
    expect(retry).toHaveBeenCalledOnce();
    expect(appleSettingsSync(source({ userId: "u", pendingUpload: true })).account!.status).toEqual({ tone: "pending", text: STRINGS.sync.syncing });
    expect(appleSettingsSync(source({ userId: "u" })).account!.status).toEqual({ tone: "pending", text: STRINGS.sync.checking });
  });

  it("restore appears only for an actual running Restore", () => {
    expect(appleSettingsRestore({ purchaseFlow: "restoring" })).toEqual({ state: "checking" });
    for (const purchaseFlow of ["idle", "failed", "restored-none", "purchasing"] as const)
      expect(appleSettingsRestore({ purchaseFlow })).toBeUndefined();
  });

  it("opens https links through a user-activated blank-target anchor and removes it", () => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    openExternalLink(PRIVACY_POLICY_URL);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.href).toBe(PRIVACY_POLICY_URL);
    expect(clicked[0]!.target).toBe("_blank");
    expect(clicked[0]!.rel).toBe("noopener noreferrer");
    expect(document.querySelector("a[hidden]")).toBeNull();
    openExternalLink("javascript:alert(1)");
    openExternalLink("http://example.com/");
    expect(clicked).toHaveLength(1);
    expect(appleSettingsHelp(vi.fn())).toEqual({ onPrivacy: expect.any(Function) });
  });

  it("reports existing toggle events and never throws from telemetry", () => {
    const track = vi.fn();
    const report = appleSettingsToggleReporter({ track });
    report({ enabled: false });
    report({ service: "tiktok", enabled: true });
    expect(track).toHaveBeenNthCalledWith(1, "global_toggled", { enabled: false, where: "app" });
    expect(track).toHaveBeenNthCalledWith(2, "service_toggled", { service: "tiktok", enabled: true, where: "app" });
    expect(() => appleSettingsToggleReporter({ track: () => { throw new Error("x"); } })({ enabled: true })).not.toThrow();
  });

  it("uses the Mac inventory only for a native Mac observation", () => {
    expect(appleSettingsPlatform({ ok: true, platform: "macos", extensionStatus: "enabled", enableLocation: "safariExtensionSettings" })).toBe("mac");
    expect(appleSettingsPlatform({ ok: true, platform: "ios", extensionStatus: "unknown", enableLocation: "settingsAppStillPage" })).toBe("ios");
    expect(appleSettingsPlatform(null)).toBe("ios");
  });
});
