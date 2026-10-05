import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeStorageAdapter, createSettingsIntentRouter } from "../../storage/index.js";
import { createExtensionUiController, type ExtensionPurchaseDeps } from "../extension-setup.js";
import {
  extensionSupabaseConfig,
  type ExtensionSessionState,
} from "../../sync/extension-session.js";
import type { RequestCodeOutcome, VerifyCodeOutcome, WebCheckoutOutcome } from "../../sync/ports.js";
import type { CheckoutReconcileOutcome } from "../controller.svelte.js";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache, type StoredSettingsRecord, type SettingsIntent, SettingsStorageRecovery } from "../../storage/index.js";
import { EntitlementCache } from "../../entitlement/cache.js";
import type { createDesktopPopupBinding } from "../v3/desktop-popup-binding.js";

const paidTierIt = it.runIf(PAID_TIER_ENABLED);
const includedAccessIt = it.runIf(!PAID_TIER_ENABLED);

// Plan U6: the shared extension wiring. The FIRST test is the Safari acceptance pin (AE7/3.1.1):
// no injection → no sign-in, no checkout CTA, no web price — byte-for-byte today's explanatory
// popup. The rest exercise the injected seams (message-closures in real wiring, mocks here) and
// the pure build-mode env gate (fail-safe: absent config disables the spine, never a dev fallback).

type Listener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;

// Minimal in-memory chrome.storage.local + onChanged (the chrome-adapter test pattern) so the
// wiring's SettingsCache/EntitlementCache adapters run without a browser.
function installChrome(initial: Record<string, unknown> = {}): { store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  const listeners = new Set<Listener>();
  const chromeMock = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) {
            const oldValue = store[k];
            store[k] = v;
            for (const l of listeners) l({ [k]: { oldValue, newValue: v } }, "local");
          }
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
  };
  const origin = "chrome-extension://synthetic/";
  Object.assign(chromeMock, { runtime: {
    id: "synthetic", getURL: () => origin,
    sendMessage: (message: unknown) => new Promise(resolve => {
      router(message, { id: "synthetic", url: origin + "popup.html" }, resolve);
    }),
  } });
  vi.stubGlobal("chrome", chromeMock);
  const authority = new ChromeStorageAdapter({ authority: true });
  const router = createSettingsIntentRouter(intent => authority.commitIntent(intent), "synthetic", origin);
  return { store };
}

afterEach(() => vi.unstubAllGlobals());

/** Settle the mount microtasks (getState snapshot, hydrations). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const CHECKOUT_URL = "https://pay.rev.cat/tok/user-uuid";

function snapshot(over: Partial<ExtensionSessionState> = {}): ExtensionSessionState {
  return { userId: null, entitled: false, checkoutPending: null, pendingOtp: null, ...over };
}

/** An ext-chromium-shaped injection with in-memory fakes for the message closures. */
function makePurchase(over: { state?: ExtensionSessionState } = {}) {
  const openCheckoutTab = vi.fn((_url: string) => Promise.resolve<number | undefined>(7));
  const reconcile = vi.fn(() => Promise.resolve<CheckoutReconcileOutcome>("unknown"));
  const createCheckout = vi.fn(() =>
    Promise.resolve<WebCheckoutOutcome>({ kind: "checkout-url", url: CHECKOUT_URL }),
  );
  const setCheckoutPending = vi.fn();
  const deps: ExtensionPurchaseDeps = {
    displayPrice: "$1.99",
    getState: vi.fn(() => Promise.resolve(over.state ?? snapshot())),
    auth: {
      requestCode: vi.fn(() => Promise.resolve<RequestCodeOutcome>({ kind: "sent" })),
      verifyCode: vi.fn(() =>
        Promise.resolve<VerifyCodeOutcome>({ kind: "verified", userId: "user-1" }),
      ),
      signOut: vi.fn(() => Promise.resolve()),
      deleteAccount: vi.fn(() => Promise.resolve()),
    },
    persistence: { setPendingOtp: vi.fn(), setPurchaseIntent: vi.fn() },
    checkout: {
      createCheckout,
      openCheckoutTab,
      setPending: setCheckoutPending,
      reconcile,
    },
  };
  return { deps, openCheckoutTab, reconcile, createCheckout, setCheckoutPending };
}

describe("createExtensionUiController — no injection (the Safari pin, AE7/3.1.1)", () => {
  it("exposes no auth, no checkout, and no web price", async () => {
    installChrome();
    const c = createExtensionUiController();
    await flush();
    expect(c.host.canPurchase).toBe(false);
    expect(c.canSignIn).toBe(false);
    expect(c.canUseCode).toBe(false);
    expect(c.canWebCheckout).toBe(false);
    expect(c.canDeleteAccount).toBe(false);
    expect(c.paywallPrice).toBeNull();
    // No injected snapshot: the popup boots signed-out with no pending presentations.
    expect(c.userId).toBeNull();
    expect(c.checkoutFlow).toBe("none");
    expect(c.authFlow).toBe("idle");
  });
});

describe("createExtensionUiController — onLocalSettingsCommit (Safari App-Group push)", () => {
  it("fires with the committed record on a LOCAL popup edit", async () => {
    installChrome();
    const commits: boolean[] = [];
    const c = createExtensionUiController(undefined, {
      onLocalSettingsCommit: (record) => commits.push(record.settings.globalOn),
    });
    await flush();
    const before = c.settings.globalOn;

    c.toggleGlobal(); // a user toggle in this popup → source "local" → must push
    await flush();
    expect(commits).toEqual([!before]);
  });

  it("does NOT re-push an EXTERNAL change that arrived from the shared store", async () => {
    const { store } = installChrome();
    const commits: boolean[] = [];
    createExtensionUiController(undefined, {
      onLocalSettingsCommit: (record) => commits.push(record.settings.globalOn),
    });
    await flush();

    // The app edited via the App Group; the value lands in browser.storage and fans out as an
    // onChanged (source "external"). It already came FROM the shared store — re-pushing it would be
    // a wasted echo, so the commit hook must stay silent.
    await chrome.storage.local.set({
      "still:settings": {
        settings: { globalOn: false, services: { youtube: true, instagram: false, tiktok: false, facebook: false }, pauses: [], updatedAt: 9_999_999_999 },
        syncMetadata: null,
      },
    });
    await flush();
    void store;
    expect(commits).toEqual([]);
  });

  it("is optional — the no-arg wiring omits it without error", async () => {
    installChrome();
    const c = createExtensionUiController();
    await flush();
    expect(() => c.toggleGlobal()).not.toThrow();
  });
});

describe("createExtensionUiController — with the ext-chromium injection (plan U6)", () => {
  it("exposes sign-in, web checkout, delete-account, and the host display price", async () => {
    installChrome();
    const { deps } = makePurchase();
    const c = createExtensionUiController(deps);
    await flush();
    expect(c.host.canPurchase).toBe(true);
    expect(c.canSignIn).toBe(true);
    expect(c.canUseCode).toBe(true);
    expect(c.canWebCheckout).toBe(true);
    expect(c.canDeleteAccount).toBe(true);
    expect(c.paywallPrice).toBe("$1.99");
  });

  it("opens the checkout tab with the URL from the checkout outcome", async () => {
    installChrome();
    const { deps, openCheckoutTab } = makePurchase({ state: snapshot({ userId: "user-1" }) });
    const c = createExtensionUiController(deps);
    await flush();
    await c.startWebCheckout();
    expect(openCheckoutTab).toHaveBeenCalledWith(CHECKOUT_URL);
  });

  it("rehydrates code entry (with purchase intent) from the mount snapshot (AE2/AE1)", async () => {
    installChrome();
    const { deps } = makePurchase({
      state: snapshot({
        pendingOtp: { email: "a@b.co", requestedAt: Date.now(), purchaseIntent: true },
      }),
    });
    const c = createExtensionUiController(deps);
    await flush();
    expect(c.authFlow).toBe("code-entry");
    expect(c.codeEmail).toBe("a@b.co");
    expect(c.signInOpen).toBe(true);
    expect(c.purchaseIntent).toBe(true);
  });

  paidTierIt("rehydrates a fresh checkout-pending flag into the checking presentation (U4/R3)", async () => {
    installChrome();
    const { deps, reconcile } = makePurchase({
      state: snapshot({ userId: "user-1", checkoutPending: { startedAt: Date.now() } }),
    });
    const c = createExtensionUiController(deps);
    await flush();
    expect(c.userId).toBe("user-1");
    expect(c.checkoutFlow).toBe("checking");
    expect(c.paywallOpen).toBe(true);
    // The pending rehydration starts its own fast-poll window — the poll IS the reconcile, so the
    // separate popup-open reconcile must not double-fire on top of it.
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  includedAccessIt("clears a leftover checkout-pending flag quietly while the paid tier is dormant", async () => {
    // The user who matters here started a purchase on an older build and walked away. Nothing can
    // complete that checkout now, so opening the popup must not present it, must not start the
    // repeating entitlement check behind a sheet that no longer renders, and must not leave the
    // flag in place to do the same thing again tomorrow. Opening the popup once clears it.
    installChrome();
    const { deps, reconcile, setCheckoutPending } = makePurchase({
      state: snapshot({ userId: "user-1", checkoutPending: { startedAt: Date.now() } }),
    });
    const c = createExtensionUiController(deps);
    await flush();
    expect(c.checkoutFlow).toBe("none");
    expect(c.paywallOpen).toBe(false);
    expect(setCheckoutPending).toHaveBeenCalledWith(null);
    expect(reconcile).not.toHaveBeenCalled();
  });

  paidTierIt("reconciles once on a signed-in popup open with no pending flag (R4)", async () => {
    installChrome();
    const { deps, reconcile } = makePurchase({ state: snapshot({ userId: "user-1" }) });
    createExtensionUiController(deps);
    await flush();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  includedAccessIt("spends no purchase-service query on opening the popup", async () => {
    // With nothing for an entitlement to unlock, this call would ask the server, which asks the
    // purchase service, every single time someone opens Still, and change nothing anyone can see.
    installChrome();
    const { deps, reconcile } = makePurchase({ state: snapshot({ userId: "user-1" }) });
    createExtensionUiController(deps);
    await flush();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("never reconciles on a signed-out open (no session, nothing to check)", async () => {
    installChrome();
    const { deps, reconcile } = makePurchase({ state: snapshot() });
    createExtensionUiController(deps);
    await flush();
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("extensionSupabaseConfig — the build-mode trust gate (fail-safe)", () => {
  it("returns the config only when BOTH url and anon key are present", () => {
    expect(extensionSupabaseConfig("https://x.supabase.co", "anon-key")).toEqual({
      url: "https://x.supabase.co",
      anonKey: "anon-key",
    });
  });

  it("disables the spine on absent or blank config — never a dev fallback", () => {
    expect(extensionSupabaseConfig(undefined, undefined)).toBeNull();
    expect(extensionSupabaseConfig("https://x.supabase.co", undefined)).toBeNull();
    expect(extensionSupabaseConfig(undefined, "anon-key")).toBeNull();
    expect(extensionSupabaseConfig("", "anon-key")).toBeNull();
    expect(extensionSupabaseConfig("https://x.supabase.co", "")).toBeNull();
    expect(extensionSupabaseConfig("   ", "anon-key")).toBeNull();
    expect(extensionSupabaseConfig("https://x.supabase.co", "  ")).toBeNull();
  });

  it("trims surrounding whitespace from a real value (a padded .env line still works)", () => {
    expect(extensionSupabaseConfig(" https://x.supabase.co ", " anon-key ")).toEqual({
      url: "https://x.supabase.co",
      anonKey: "anon-key",
    });
  });
});

type CommittedPopupBinding = ReturnType<typeof createDesktopPopupBinding>;
const bindingStops: (() => void)[] = [];
afterEach(() => {
  for (const stop of bindingStops.splice(0)) stop();
  vi.restoreAllMocks();
});

/** Synthetic browser API only: the maintained adapter, writer and message router own commits. */
async function installCommittedChrome() {
  const store: Record<string, unknown> = {
    "still:settings": { settings: structuredClone(DEFAULT_SETTINGS), syncMetadata: null },
  };
  const listeners = new Set<Listener>();
  const set = vi.fn(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key];
      store[key] = structuredClone(value);
      for (const listener of [...listeners])
        listener({ [key]: { oldValue, newValue: structuredClone(value) } }, "local");
    }
  });
  const origin = "chrome-extension://synthetic/";
  const sendMessage = vi.fn((message: unknown) => new Promise(resolve => {
    router(message, { id: "synthetic", url: origin + "popup.html" }, resolve);
  }));
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => key in store ? { [key]: structuredClone(store[key]) } : {},
        set,
      },
      onChanged: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
    runtime: { id: "synthetic", getURL: () => origin, sendMessage },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  let commit = (intent: SettingsIntent) => authority.commitIntent(intent);
  const router = createSettingsIntentRouter(intent => commit(intent), "synthetic", origin);
  await authority.initializeAtomic("never-linked");
  set.mockClear();
  return {
    store, authority, set, sendMessage, listeners,
    port(next: typeof commit) { commit = next; },
    async external(record: StoredSettingsRecord) { await set({ "still:settings": record }); },
  };
}

function captureCommittedFactory(options: {
  onLocalSettingsCommit?: (record: StoredSettingsRecord) => void;
} = {}) {
  const handed = vi.fn<(binding: CommittedPopupBinding) => void>();
  let binding: CommittedPopupBinding | undefined;
  const controller = createExtensionUiController(undefined, {
    ...options,
    onCommittedPopupBinding(value) {
      binding = value;
      bindingStops.push(value.stop);
      handed(value);
    },
  });
  expect(handed).toHaveBeenCalledOnce();
  expect(binding).toBeDefined();
  return { controller, binding: binding!, handed };
}

function boundaryGate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

describe("createExtensionUiController — committed popup handoff", () => {
  it("hands off the same watched caches once, initially held, then hydrates real free accountless state", async () => {
    const f = await installCommittedChrome();
    const settingsHydrate = vi.spyOn(SettingsCache.prototype, "hydrate");
    const settingsObserve = vi.spyOn(SettingsCache.prototype, "subscribeAuthority");
    const accessHydrate = vi.spyOn(EntitlementCache.prototype, "hydrate");
    const accessObserve = vi.spyOn(EntitlementCache.prototype, "subscribeAccess");
    const { controller, binding, handed } = captureCommittedFactory();
    expect(binding.current().commandAvailability).toBe("unavailable");
    expect(binding.current().settings).toBeNull();
    expect(await binding.setGlobalOn(false)).toEqual({ status: "unavailable", reason: "modern-settings-unavailable" });
    await flush();
    expect(handed).toHaveBeenCalledOnce();
    expect(settingsHydrate).toHaveBeenCalledOnce();
    expect(settingsObserve).toHaveBeenCalledOnce();
    expect(settingsObserve.mock.instances[0]).toBe(settingsHydrate.mock.instances[0]);
    expect(accessHydrate).toHaveBeenCalledOnce();
    expect(accessObserve).toHaveBeenCalledOnce();
    expect(accessObserve.mock.instances[0]).toBe(accessHydrate.mock.instances[0]);
    expect(binding.current().commandAvailability).toBe("ready");
    expect(binding.current().settings!.globalOn).toBe(true);
    expect(binding.current().access.states["youtube.shorts"]).toBe("free");
    expect(binding.current().access.states["tiktok.all"]).toBe("free");
    expect(controller.userId).toBeNull();
    expect(controller.canSignIn).toBe(false);
    expect(f.set).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("uses real committed receipts for free controls and only local commits reach the existing hook", async () => {
    const f = await installCommittedChrome();
    const commits = vi.fn();
    const { controller, binding } = captureCommittedFactory({ onLocalSettingsCommit: commits });
    await flush();
    for (const request of [
      () => binding.setFeature("youtube.shorts", false),
      () => binding.setService("instagram", false),
      () => binding.setGlobalOn(false),
    ]) {
      const before = (await f.authority.get())!;
      expect(await request()).toEqual({ status: "committed" });
      expect((await f.authority.get())!.atomic!.sequence).toBe(before.atomic!.sequence + 1);
    }
    expect(binding.current().settings!.sites["youtube.shorts"]).toBe(false);
    expect(binding.current().settings!.services.instagram).toBe(false);
    expect(controller.settings.globalOn).toBe(false);
    expect(commits).toHaveBeenCalledTimes(3);
    const saved = await f.authority.get();
    expect(await binding.setGlobalOn(false)).toEqual({ status: "not-committed" });
    expect(await binding.setFeature("youtube.shorts", true)).toEqual({ status: "rejected", reason: "inactive-or-unavailable" });
    expect(await binding.setService("youtube", false)).toEqual({ status: "rejected", reason: "inactive-or-unavailable" });
    expect(await f.authority.get()).toEqual(saved);
    expect(commits).toHaveBeenCalledTimes(3);
  });

  it("does not grant unsupported optional controls from a legacy entitled boolean", async () => {
    const f = await installCommittedChrome();
    const { controller, binding } = captureCommittedFactory();
    await flush();
    await chrome.storage.local.set({ "still:entitlement": { entitled: true, updatedAt: Date.now() } });
    await flush();
    expect(controller.entitled).toBe(true);
    expect(binding.current().access.states["youtube.comments"]).toBe("unsupported");
    const saved = await f.authority.get();
    expect(await binding.setFeature("youtube.comments", true)).toEqual({ status: "rejected", reason: "inactive-or-unavailable" });
    expect(await f.authority.get()).toEqual(saved);
  });

  it.each(["paused", "previous-account"] as const)("observes external %s authority without claiming a local commit or rewriting choices", async kind => {
    const f = await installCommittedChrome();
    const commits = vi.fn();
    const { binding } = captureCommittedFactory({ onLocalSettingsCommit: commits });
    await flush();
    const saved = (await f.authority.get())!;
    const displayed = binding.current().settings;
    const record: StoredSettingsRecord = {
      ...saved,
      atomic: {
        ...saved.atomic!, sequence: saved.atomic!.sequence + 1,
        paused: kind === "paused" ? "ordering-hold" : "ownership-unconfirmed",
        ownership: kind === "previous-account" ? "previous-account" : "never-linked",
      },
    };
    const states: string[] = [];
    binding.subscribe(state => states.push(state.commandAvailability));
    await f.external(record);
    const before = await f.authority.get();
    expect(binding.current().commandAvailability).toBe("unavailable");
    expect(states).toEqual(["ready", "unavailable"]);
    expect(binding.current().settings).toEqual(displayed);
    expect((await binding.setGlobalOn(false)).status).toBe("unavailable");
    expect(await f.authority.get()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
  });

  it.each([
    [0, "modern-settings-unavailable"],
    [101, "atomic-command-unavailable"],
  ] as const)("holds initially missing atomic provenance at timestamp %s without creating defaults or a new authority", async (updatedAt, reason) => {
    const f = await installCommittedChrome();
    const saved = (await f.authority.get())!;
    const unproven = { ...saved, settings: { ...saved.settings, updatedAt }, atomic: undefined };
    await f.external(unproven);
    f.set.mockClear();
    const { binding } = captureCommittedFactory();
    await flush();
    expect(binding.current().commandAvailability).toBe("unavailable");
    expect(binding.current().reason).toBe(reason);
    expect((await binding.setGlobalOn(false)).status).toBe("unavailable");
    expect(await f.authority.get()).toEqual(unproven);
    expect(f.set).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("returns non-commit for a refused request even when an independent real edit matches its value", async () => {
    const f = await installCommittedChrome();
    const { binding } = captureCommittedFactory();
    await flush();
    const reached = boundaryGate(), held = boundaryGate();
    f.port(async () => {
      reached.open();
      await held.promise;
      return { ...(await f.authority.get())!, intentCommitted: false };
    });
    const pending = binding.setGlobalOn(false);
    await reached.promise;
    await f.authority.commitIntent({ path: "globalOn", value: false, updatedAt: 101 });
    held.open();
    expect(await pending).toEqual({ status: "not-committed" });
    expect(binding.current().settings!.globalOn).toBe(false);
  });

  it("keeps refused authority writes truthful and saved choices intact", async () => {
    const f = await installCommittedChrome();
    const { binding } = captureCommittedFactory();
    await flush();
    const saved = await f.authority.get();
    f.port(async () => { throw new SettingsStorageRecovery("authority-unavailable"); });
    expect(await binding.setGlobalOn(false)).toEqual({ status: "unavailable", reason: "authority-unavailable" });
    expect(binding.current().settings!.globalOn).toBe(true);
    expect(await f.authority.get()).toEqual(saved);
    expect(f.set).not.toHaveBeenCalled();
  });

  it("stops new commands and late views while an already-admitted real write can still commit", async () => {
    const f = await installCommittedChrome();
    const { controller, binding } = captureCommittedFactory();
    await flush();
    const reached = boundaryGate(), held = boundaryGate();
    f.port(async intent => { reached.open(); await held.promise; return f.authority.commitIntent(intent); });
    const listener = vi.fn();
    binding.subscribe(listener);
    const pending = binding.setGlobalOn(false);
    await reached.promise;
    binding.stop();
    const stopped = binding.current();
    listener.mockClear();
    const calls = f.sendMessage.mock.calls.length;
    expect(await binding.setGlobalOn(false)).toEqual({ status: "unavailable", reason: "stopped" });
    expect(f.sendMessage).toHaveBeenCalledTimes(calls);
    held.open();
    expect(await pending).toEqual({ status: "committed" });
    expect((await f.authority.get())!.settings.globalOn).toBe(false);
    expect(controller.settings.globalOn).toBe(false); // Factory page-lifetime watchers remain.
    expect(listener).not.toHaveBeenCalled();
    expect(binding.current()).toEqual(stopped);
  });

  it("stops the handed binding and propagates a callback failure", async () => {
    const f = await installCommittedChrome();
    let binding: CommittedPopupBinding | undefined;
    const failure = new Error("Synthetic handoff failed");
    expect(() => createExtensionUiController(undefined, {
      onCommittedPopupBinding(value) { binding = value; bindingStops.push(value.stop); throw failure; },
    })).toThrow(failure);
    expect(binding!.current().reason).toBe("stopped");
    await flush();
    expect(await binding!.setGlobalOn(false)).toEqual({ status: "unavailable", reason: "stopped" });
    const listener = vi.fn();
    binding!.subscribe(listener);
    const saved = (await f.authority.get())!;
    await f.external({ ...saved, atomic: { ...saved.atomic!, sequence: saved.atomic!.sequence + 1, paused: "ordering-hold" } });
    expect(listener).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});
describe("retained local-only authority observation in the maintained factory", () => {
  it("accepts readable unknown local choices without claiming an observer edit, then commits once", async () => {
    const f = await installCommittedChrome(); const commits = vi.fn();
    const { binding } = captureCommittedFactory({ onLocalSettingsCommit: commits }); await flush();
    const saved = (await f.authority.get())!;
    await f.external({ ...saved, settings: { ...saved.settings, globalOn: false }, atomic: {
      ...saved.atomic!, sequence: saved.atomic!.sequence + 1, ownership: "unknown", pending: [], paused: null } });
    expect(binding.current().commandAvailability).toBe("ready");
    expect(binding.current().settings!.globalOn).toBe(false);
    expect(commits).not.toHaveBeenCalled();
    expect(await binding.setGlobalOn(true)).toEqual({ status: "committed" });
    expect(commits).toHaveBeenCalledOnce();
    expect(await f.authority.get()).toMatchObject({ settings: { globalOn: true, clocks: { globalOn: { localStep: 1 } } },
      atomic: { ownership: "unknown", sequence: saved.atomic!.sequence + 2, pending: [], paused: null } });
  });
});
