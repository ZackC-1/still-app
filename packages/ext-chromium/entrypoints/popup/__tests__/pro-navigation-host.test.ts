import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { initialAccessSnapshot, ACCESS_BENEFITS } from "../../../../core/src/entitlement/access-policy.js";
import { EntitlementCache } from "../../../../core/src/entitlement/cache.js";
import { createDesktopPopupBinding } from "../../../../core/src/ui/v3/desktop-popup-binding.js";
import { fixture as desktopFixture } from "../../../../core/src/ui/v3/DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "../../../../core/src/ui/v3/ExtensionSettings.test-fixtures.js";
import { browser, capture, flush } from "../../../../core/src/ui/__tests__/committed-popup-host.fixtures.js";
import { CHROMIUM_SURFACE_GUIDANCE } from "@still/core/ui";
import { bindProOptionsNavigation, openBrowserPro, PRO_NAVIGATION_KEY, PRO_OPTIONS_HASH, PRO_OFFER_READY_KEY } from "../../../lib/pro-navigation.js";
import PopupApp from "../PopupApp.svelte";
import ExtensionSettings from "../../../../core/src/ui/v3/ExtensionSettings.svelte";
import { watchAccountStatus } from "../../../../core/src/ui/account-status.js";

vi.mock("@still/shared-types", async original => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  cleanup();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function session() {
  const records: Record<string, unknown> = {};
  const listeners = new Set<Parameters<typeof chrome.storage.onChanged.addListener>[0]>();
  const set = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(records, structuredClone(values));
    for (const [key, value] of Object.entries(values))
      for (const listener of [...listeners]) listener({ [key]: { newValue: structuredClone(value) } }, "session");
  });
  const get = vi.fn(async (key: string) => ({ [key]: structuredClone(records[key]) }));
  const openOptionsPage = vi.fn(async () => {});
  Object.assign(chrome.storage, { session: { get, set } });
  Object.assign(chrome.runtime, { openOptionsPage });
  const oldAdd = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
  const oldRemove = chrome.storage.onChanged.removeListener.bind(chrome.storage.onChanged);
  Object.assign(chrome.storage.onChanged, {
    addListener: (listener: Parameters<typeof oldAdd>[0]) => { listeners.add(listener); oldAdd(listener); },
    removeListener: (listener: Parameters<typeof oldRemove>[0]) => { listeners.delete(listener); oldRemove(listener); },
  });
  return { records, set, get, openOptionsPage, listeners };
}

/** Only the options-navigation requests (the popup also remembers its last sales answer). */
const navigationSets = (set: ReturnType<typeof vi.fn>) =>
  set.mock.calls.filter(([values]) => PRO_NAVIGATION_KEY in (values as object));

function root() {
  const target = document.createElement("main");
  document.body.append(target);
  return target;
}

async function options(target: HTMLElement) {
  const { props } = await settingsFixture("locked");
  const buy = vi.fn();
  props.pro = { ownership: "none", channel: "ready", offer: { price: "Synthetic localized price" }, onSignIn: vi.fn(), onBuy: buy };
  props.sync.account = { confirmed: true };
  const view = render(ExtensionSettings, { target, props });
  return { view, buy, card: () => within(target).getByRole("region", { name: "Still Pro" }) };
}

async function popup(browserName: "Chrome" | "Firefox", android = false, state: "locked" | "unsupported" | "checking" = "locked", ready = true, offer: boolean | (() => Promise<boolean>) = true) {
  await browser();
  // The background's "would Settings offer Get Still Pro?" answer (lib/checkout-availability.ts).
  const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: unknown) => Promise<unknown>;
  const asked = vi.fn();
  Object.assign(chrome.runtime, {
    sendMessage: vi.fn(async (message: unknown) => {
      const m = message as { kind?: string; action?: string };
      if (m.kind === "still:session" && m.action === "checkoutAvailable") {
        asked();
        return typeof offer === "function" ? offer() : offer;
      }
      return send(message);
    }),
  });
  const navigation = session();
  const { controller } = capture();
  const f = await desktopFixture(state);
  const access = new EntitlementCache({
    get: async () => false,
    set: async () => {},
    subscribe: () => () => {},
    observeBenefits: async () => state === "unsupported" ? initialAccessSnapshot() : f.props.access,
  }, { access: { paidMode: true, supported: new Set(ACCESS_BENEFITS) } });
  await access.refreshAccess();
  const binding = createDesktopPopupBinding(f.cache, access);
  stops.push(binding.stop);
  vi.stubEnv("FIREFOX", browserName === "Firefox" ? "true" : "");
  vi.stubEnv("VITE_SUPABASE_URL", "");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
  const props = { controller, committedPopupBinding: binding, browser: browserName, platform: Promise.resolve(android ? "android" as const : "desktop" as const), surfaceGuidance: CHROMIUM_SURFACE_GUIDANCE, proDestinationReady: ready };
  const view = render(PopupApp, { props });
  const youtube = await screen.findByRole("button", { name: "YouTube Blocker" });
  if (youtube.getAttribute("aria-expanded") !== "true") await fireEvent.click(youtube);
  await flush();
  return { ...navigation, view, props, binding, f, asked, access, controller };
}

describe("live popup/App/browser Pro navigation", () => {
  it.each([
    ["Chrome", false], ["Firefox", false], ["Firefox", true],
  ] as const)("%s Android=%s retains the same offer through a signed-in sync refresh (ISS-0032)", async (name, android) => {
    const f = await popup(name, android);
    const account = {
      accountId: "synthetic-account",
      email: "reader@example.test",
      lastSyncedAt: Date.now(),
      pendingUpload: false,
      cloudReachable: true,
      updatedAt: Date.now(),
    };
    const read = vi.fn(async () => ({ ...account }));
    stops.push(watchAccountStatus(f.controller, read));
    await screen.findByText("Synced");
    const card = screen.getByRole("region", { name: "Still Pro" });
    const before = await f.f.storage.get();

    account.pendingUpload = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByText("Syncing your settings.");
    expect(screen.getByRole("region", { name: "Still Pro" })).toBe(card);
    expect(within(card).getByRole("button", { name: "Get Still Pro" }).hasAttribute("disabled")).toBe(false);

    account.pendingUpload = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByText("Synced");
    expect(screen.getByRole("region", { name: "Still Pro" })).toBe(card);
    expect(f.openOptionsPage).not.toHaveBeenCalled();
    expect(await f.f.storage.get()).toEqual(before);
  });

  it.each([
    ["Chrome", false], ["Firefox", false], ["Firefox", true],
  ] as const)("%s Android=%s sends a fixed options request, focuses real Pro after lazy mount, and never buys", async (name, android) => {
    const f = await popup(name, android);
    const before = await f.f.storage.get();
    await fireEvent.click(screen.getByRole("button", { name: "Comments. Included in Still Pro. See Still Pro" }));
    await waitFor(() => expect(f.openOptionsPage).toHaveBeenCalledOnce());
    expect(navigationSets(f.set)).toHaveLength(1);
    expect(f.records[PRO_NAVIGATION_KEY]).toMatchObject({ target: "pro" });
    expect(Object.keys(f.records[PRO_NAVIGATION_KEY] as object).sort()).toEqual(["expiresAt", "target", "token"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Purchase Still Pro" })).toBeNull();
    expect(await f.f.storage.get()).toEqual(before);
    f.view.unmount();
    const target = root();
    stops.push(bindProOptionsNavigation(target));
    await flush();
    expect(window.location.hash).toBe(PRO_OPTIONS_HASH);
    const destination = await options(target);
    await waitFor(() => expect(document.activeElement).toBe(destination.card()));
    expect(destination.buy).not.toHaveBeenCalled();
    await fireEvent.click(within(destination.card()).getByRole("button", { name: "Get Still Pro" }));
    expect(destination.buy).toHaveBeenCalledOnce();
  });

  it.each([
    ["Chrome", false], ["Firefox", false], ["Firefox", true],
  ] as const)("%s Android=%s: the popup's Still Pro card opens the same Settings request and never buys (ISS-0032)", async (name, android) => {
    const f = await popup(name, android);
    const before = await f.f.storage.get();
    const card = await screen.findByRole("region", { name: "Still Pro" });
    expect(within(card).getByText("Hide more on Instagram, Facebook and YouTube. One-time purchase.")).toBeTruthy();
    expect(within(card).queryByText("Opens the Still app")).toBeNull();
    await fireEvent.click(within(card).getByRole("button", { name: "Get Still Pro" }));
    await waitFor(() => expect(f.openOptionsPage).toHaveBeenCalledOnce());
    expect(f.records[PRO_NAVIGATION_KEY]).toMatchObject({ target: "pro" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await f.f.storage.get()).toEqual(before);
  });

  it("no Still Pro card while Settings would not offer Get Still Pro, but the locks still open it", async () => {
    const f = await popup("Chrome", false, "locked", true, false);
    expect(f.asked).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Comments. Included in Still Pro. See Still Pro" }));
    await waitFor(() => expect(f.openOptionsPage).toHaveBeenCalledOnce());
  });

  it.each(["Chrome", "Firefox"] as const)("%s recovers an early unavailable offer answer without reopening", async name => {
    const answer = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const f = await popup(name, false, "locked", true, answer);
    await waitFor(() => expect(screen.getByRole("button", { name: "Get Still Pro" })).toBeTruthy(), { timeout: 2000 });
    expect(answer).toHaveBeenCalledTimes(2);
    expect(f.openOptionsPage).not.toHaveBeenCalled();
  });

  it("keeps stale replies out of the reopen cache while accepting a current false reply", async () => {
    let resolveOld!: (ready: boolean) => void;
    let resolveReopen!: (ready: boolean) => void;
    const old = new Promise<boolean>(resolve => { resolveOld = resolve; });
    const reopen = new Promise<boolean>(resolve => { resolveReopen = resolve; });
    const answer = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(true).mockReturnValue(reopen);
    const f = await popup("Chrome", false, "locked", true, answer);
    await f.f.cache.setGlobalOn(false);
    await waitFor(() => expect(f.records[PRO_OFFER_READY_KEY]).toBe(true));
    resolveOld(false);
    await flush();
    expect(f.records[PRO_OFFER_READY_KEY]).toBe(true);
    f.view.unmount();
    const binding = createDesktopPopupBinding(f.f.cache, f.access);
    stops.push(binding.stop);
    render(PopupApp, { props: { ...f.props, committedPopupBinding: binding } });
    await screen.findByRole("button", { name: "Get Still Pro" });
    resolveReopen(false);
    await waitFor(() => expect(f.records[PRO_OFFER_READY_KEY]).toBe(false));
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
  });

  it.each(["unsupported", "checking"] as const)("%s access shows no Still Pro card in the popup", async state => {
    await popup("Chrome", false, state);
    expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
    expect(screen.queryByText("Get Still Pro")).toBeNull();
  });

  it.each(["unsupported", "checking"] as const)("%s access suppresses navigation even with a verified host destination", async state => {
    const f = await popup("Chrome", false, state);
    const lock = screen.queryByRole("button", { name: /Comments\. Included in Still Pro/ });
    if (lock) await fireEvent.click(lock);
    expect(navigationSets(f.set)).toHaveLength(0);
    expect(f.openOptionsPage).not.toHaveBeenCalled();
  });

  it("before the background answers the rows are checking, never verify; a signed-out answer shows Still Pro locks (ISS-0030)", async () => {
    await browser();
    session();
    const { controller } = capture();
    const f = await desktopFixture("locked");
    let answer: ((snapshot: typeof f.props.access) => void) | undefined;
    const access = new EntitlementCache({
      get: async () => false,
      set: async () => {},
      subscribe: () => () => {},
      observeBenefits: () => new Promise(resolve => { answer = resolve; }),
    }, { access: { paidMode: true, supported: new Set(ACCESS_BENEFITS) } });
    const binding = createDesktopPopupBinding(f.cache, access);
    stops.push(binding.stop);
    vi.stubEnv("FIREFOX", "");
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    render(PopupApp, { props: { controller, committedPopupBinding: binding, browser: "Chrome", platform: Promise.resolve("desktop" as const), surfaceGuidance: CHROMIUM_SURFACE_GUIDANCE, proDestinationReady: true } });
    const youtube = await screen.findByRole("button", { name: "YouTube Blocker" });
    if (youtube.getAttribute("aria-expanded") !== "true") await fireEvent.click(youtube);
    expect(document.querySelectorAll('[data-access="checking"]').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-access="verify"]')).toBeNull();
    if (!answer) void access.refreshAccess();
    await waitFor(() => expect(answer).toBeDefined());
    answer!(f.props.access);
    await screen.findByRole("button", { name: "Comments. Included in Still Pro. See Still Pro" });
    expect(document.querySelector('[data-access="checking"]')).toBeNull();
    expect(document.querySelector('[data-access="verify"]')).toBeNull();
    expect(screen.getAllByText("Still Pro").length).toBeGreaterThan(0);
  });

  it("withdraws navigation when its host destination is replaced or unavailable", async () => {
    const f = await popup("Chrome");
    await f.view.rerender({ ...f.props, proDestinationReady: false });
    const lock = screen.getByRole("button", { name: "Comments. Included in Still Pro." });
    expect(lock.getAttribute("aria-disabled")).toBe("true");
    await fireEvent.click(lock);
    expect(navigationSets(f.set)).toHaveLength(0);
    await f.view.rerender(f.props);
    Reflect.deleteProperty(chrome.storage, "session");
    await f.view.rerender({ ...f.props, proDestinationReady: false });
    await f.view.rerender(f.props);
    await fireEvent.click(screen.getByRole("button", { name: "Comments. Included in Still Pro." }));
    expect(f.openOptionsPage).not.toHaveBeenCalled();
  });
});

// ISS-0032 / ISS-0062 (reopened on .361): for an account without Still Pro the card and the lock
// chips stay on the first opening and through setting changes and sync, signed in or out. They go
// only on verified ownership, and a lock tap only ever navigates (no purchase, no free row).
describe("a steady Still Pro offer (ISS-0032)", () => {
  const LOCK = "Comments. Included in Still Pro. See Still Pro";
  function snapshot(base: typeof initialAccessSnapshot extends (...a: never[]) => infer R ? R : never, state: "locked" | "purchased") {
    const states = { ...base.states };
    for (const [id, value] of Object.entries(base.states)) if (value === "locked" || value === "checking") states[id as keyof typeof states] = state;
    return { ...base, states };
  }

  /** A popup over a watched access cache whose record can change and whose reads can fail. */
  async function heldPopup(browserName: "Chrome" | "Firefox", offer: () => Promise<boolean>) {
    await browser();
    const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: unknown) => Promise<unknown>;
    Object.assign(chrome.runtime, {
      sendMessage: vi.fn(async (message: unknown) => {
        const m = message as { kind?: string; action?: string };
        return m.kind === "still:session" && m.action === "checkoutAvailable" ? offer() : send(message);
      }),
    });
    const navigation = session();
    const { controller } = capture();
    const f = await desktopFixture("locked");
    let changed: (() => void) | undefined;
    const observe = vi.fn(async () => f.props.access);
    const access = new EntitlementCache({
      get: async () => false,
      set: async () => {},
      subscribe: () => () => {},
      subscribeAccess: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; },
      observeBenefits: () => observe(),
    }, { access: { paidMode: true, supported: new Set(ACCESS_BENEFITS) } });
    stops.push(access.watch());
    await access.refreshAccess();
    const binding = createDesktopPopupBinding(f.cache, access);
    stops.push(binding.stop);
    vi.stubEnv("FIREFOX", browserName === "Firefox" ? "true" : "");
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    const view = render(PopupApp, { props: { controller, committedPopupBinding: binding, browser: browserName, platform: Promise.resolve("desktop" as const), surfaceGuidance: CHROMIUM_SURFACE_GUIDANCE, proDestinationReady: true } });
    const youtube = await screen.findByRole("button", { name: "YouTube Blocker" });
    if (youtube.getAttribute("aria-expanded") !== "true") await fireEvent.click(youtube);
    await flush();
    /** The background's access record changed (a sync or auth cycle) and the next read fails. */
    async function syncCycle() {
      observe.mockRejectedValueOnce(new Error("Stale access context"));
      changed?.();
      await flush();
      await flush();
    }
    return { ...navigation, view, f, access, observe, controller, syncCycle };
  }

  it.each(["Chrome", "Firefox"] as const)("%s first opening: readiness replies that fail at first still bring the card without reopening", async name => {
    const answer = vi.fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const f = await popup(name, false, "locked", true, answer);
    expect(f.records[PRO_OFFER_READY_KEY]).not.toBe(true);
    await waitFor(() => expect(screen.getByRole("region", { name: "Still Pro" })).toBeTruthy(), { timeout: 6_000 });
    expect(answer.mock.calls.length).toBeGreaterThanOrEqual(4);
  }, 10_000);

  it.each(["Chrome", "Firefox"] as const)("%s first opening: a readiness reply that never arrives does not hold the card back", async name => {
    const answer = vi.fn<() => Promise<boolean>>()
      .mockReturnValueOnce(new Promise<boolean>(() => {}))
      .mockResolvedValue(true);
    await popup(name, false, "locked", true, answer);
    await waitFor(() => expect(screen.getByRole("region", { name: "Still Pro" })).toBeTruthy(), { timeout: 8_000 });
  }, 12_000);

  it.each(["Chrome", "Firefox"] as const)("%s reopening: no answer yet keeps the remembered card and the memory", async name => {
    const answer = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true)
      .mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    const f = await popup(name, false, "locked", true, answer);
    await waitFor(() => expect(f.records[PRO_OFFER_READY_KEY]).toBe(true));
    f.view.unmount();
    const binding = createDesktopPopupBinding(f.f.cache, f.access);
    stops.push(binding.stop);
    render(PopupApp, { props: { ...f.props, committedPopupBinding: binding } });
    const card = await screen.findByRole("region", { name: "Still Pro" });
    await new Promise(resolve => setTimeout(resolve, 1_700));
    expect(answer.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("region", { name: "Still Pro" })).toBe(card);
    expect(f.records[PRO_OFFER_READY_KEY]).toBe(true);
  }, 8_000);

  it.each(["Chrome", "Firefox"] as const)("%s: a setting change while open keeps the card even when a re-ask would say no", async name => {
    const answer = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValue(false);
    const f = await popup(name, false, "locked", true, answer);
    const card = await screen.findByRole("region", { name: "Still Pro" });
    await f.f.cache.setService("tiktok", false);
    for (let i = 0; i < 5; i++) await flush();
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(screen.getByRole("region", { name: "Still Pro" })).toBe(card);
    expect(screen.getByRole("button", { name: LOCK })).toBeTruthy();
  });

  it.each([
    ["Chrome", false], ["Chrome", true], ["Firefox", false], ["Firefox", true],
  ] as const)("%s signed in=%s: a sync cycle and a setting change keep the card and the lock chips", async (name, signedIn) => {
    const f = await heldPopup(name, async () => true);
    if (signedIn) {
      const account = { accountId: "synthetic-account", email: "reader@example.test", lastSyncedAt: Date.now(), pendingUpload: false, cloudReachable: true, updatedAt: Date.now() };
      stops.push(watchAccountStatus(f.controller, vi.fn(async () => ({ ...account }))));
      await screen.findByText("Synced");
    }
    const card = await screen.findByRole("region", { name: "Still Pro" });
    expect(screen.getByRole("button", { name: LOCK })).toBeTruthy();
    const before = await f.f.storage.get();

    await f.syncCycle();
    // The cache really is holding access (re-confirming), not answering "locked".
    expect(f.access.currentAccess("youtube.comments")).toBe("verification_required");
    await f.f.cache.setService("tiktok", false);
    for (let i = 0; i < 5; i++) await flush();
    expect(screen.getByRole("region", { name: "Still Pro" })).toBe(card);
    const lock = screen.getByRole("button", { name: LOCK });
    // Held access keeps the locked row: its saved switch shows dimmed beside the lock (CH-96), and
    // nothing can turn a Pro row on.
    expect(document.querySelector('[data-access="verify"]')).toBeNull();
    expect(screen.getByRole("switch", { name: "Comments" }).getAttribute("aria-disabled")).toBe("true");
    await fireEvent.click(lock);
    await waitFor(() => expect(f.openOptionsPage).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Purchase Still Pro" })).toBeNull();
    // Only the deliberate TikTok change was saved; no Pro row's choice moved.
    const saved = (record: unknown) => (record as { settings: { sites: object; services: { tiktok: boolean } } }).settings;
    const after = saved(await f.f.storage.get());
    expect(after.sites).toEqual(saved(before).sites);
    expect(after.services.tiktok).toBe(false);
  });

  it.each(["Chrome", "Firefox"] as const)("%s: verified ownership removes the card and the lock chips", async name => {
    const f = await heldPopup(name, async () => true);
    await screen.findByRole("region", { name: "Still Pro" });
    await f.syncCycle();
    f.observe.mockResolvedValue(snapshot(f.f.props.access, "purchased"));
    await f.access.refreshAccess();
    await flush();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull());
    expect(screen.queryByRole("button", { name: LOCK })).toBeNull();
    expect(screen.getByRole("switch", { name: "Comments" })).toBeTruthy();
  });
});

describe("options route lifecycle", () => {
  it("reuses an already-mounted options destination and does not refocus on normal render changes or duplicate delivery", async () => {
    await browser(); const f = session();
    const target = root(); const destination = await options(target);
    stops.push(bindProOptionsNavigation(target));
    await flush();
    const focus = vi.spyOn(destination.card(), "focus");
    await openBrowserPro();
    expect(f.openOptionsPage).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    const other = document.createElement("button"); target.append(other); other.focus();
    await f.set({ [PRO_NAVIGATION_KEY]: f.records[PRO_NAVIGATION_KEY] });
    target.append(document.createElement("p"));
    await flush();
    expect(document.activeElement).toBe(other);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("aligns the offer heading at the top and follows late content until the user interacts", async () => {
    await browser(); session();
    const target = root(); const destination = await options(target);
    const card = destination.card();
    const scroll = vi.fn();
    Object.defineProperty(card, "scrollIntoView", { value: scroll, configurable: true });
    stops.push(bindProOptionsNavigation(target));
    await openBrowserPro();
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    const focus = vi.spyOn(card, "focus");
    card.append(document.createElement("p"));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    expect(focus).not.toHaveBeenCalled();
    await fireEvent.wheel(target);
    card.append(document.createElement("p"));
    await flush();
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("a newer request fences an older initial read, and changing route cancels pending lazy focus", async () => {
    await browser(); const f = session(); const target = root();
    let finish!: (value: Record<string, unknown>) => void;
    f.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    stops.push(bindProOptionsNavigation(target));
    await openBrowserPro();
    window.history.replaceState(null, "", "#help");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    finish({ [PRO_NAVIGATION_KEY]: { target: "pro", token: "11111111-1111-4111-8111-111111111111", expiresAt: Date.now() + 20_000 } });
    const destination = await options(target);
    await flush();
    expect(window.location.hash).toBe("#help");
    expect(document.activeElement).not.toBe(destination.card());
    expect(destination.buy).not.toHaveBeenCalled();
  });

  it("expired/malformed requests and unmounted hosts cannot move focus", async () => {
    await browser(); const f = session(); const target = root();
    const stop = bindProOptionsNavigation(target);
    await f.set({ [PRO_NAVIGATION_KEY]: { target: "pro", token: crypto.randomUUID(), expiresAt: Date.now() - 1 } });
    await f.set({ [PRO_NAVIGATION_KEY]: { target: "checkout", token: crypto.randomUUID(), expiresAt: Date.now() + 20_000 } });
    expect(window.location.hash).toBe("");
    await openBrowserPro();
    stop();
    expect(f.listeners.size).toBe(0);
    const destination = await options(target);
    await flush();
    expect(document.activeElement).not.toBe(destination.card());
    expect(destination.buy).not.toHaveBeenCalled();
  });

  it("a direct Pro URL focuses once, and a late initial read cannot undo subsequent navigation", async () => {
    await browser(); const f = session(); const target = root();
    const destination = await options(target);
    const focus = vi.spyOn(destination.card(), "focus");
    let finish!: (value: Record<string, unknown>) => void;
    f.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    window.history.replaceState(null, "", PRO_OPTIONS_HASH);
    stops.push(bindProOptionsNavigation(target));
    expect(focus).toHaveBeenCalledOnce();
    window.history.replaceState(null, "", "#help");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    finish({ [PRO_NAVIGATION_KEY]: { target: "pro", token: crypto.randomUUID(), expiresAt: Date.now() + 20_000 } });
    await flush();
    expect(window.location.hash).toBe("#help");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("leaves the address plain once the Pro card is reached, and when a hand-off ends unreached (ISS-0097)", async () => {
    // Firefox reuses an open Settings tab only on an exact address match, hash included.
    await browser(); session(); const target = root();
    stops.push(bindProOptionsNavigation(target));
    await openBrowserPro();
    await flush();
    expect(window.location.hash).toBe(PRO_OPTIONS_HASH);
    const destination = await options(target);
    await waitFor(() => expect(document.activeElement).toBe(destination.card()));
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
    const scroll = vi.fn();
    Object.defineProperty(destination.card(), "scrollIntoView", { value: scroll, configurable: true });
    destination.card().append(document.createElement("p"));
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "start" }));
    expect(window.location.hash).toBe("");

    // No card ever mounts: the first interaction ends the window and clears the address too.
    const bare = root();
    stops.push(bindProOptionsNavigation(bare));
    await openBrowserPro();
    await flush();
    expect(window.location.hash).toBe(PRO_OPTIONS_HASH);
    await fireEvent.wheel(bare);
    expect(window.location.hash).toBe("");
  });

  it("a request that expires while the Pro card is loading cannot steal focus later", async () => {
    await browser(); const f = session(); const target = root();
    const now = Date.now();
    stops.push(bindProOptionsNavigation(target));
    await f.set({ [PRO_NAVIGATION_KEY]: { target: "pro", token: crypto.randomUUID(), expiresAt: now + 1_000 } });
    vi.spyOn(Date, "now").mockReturnValue(now + 1_001);
    const destination = await options(target);
    await flush();
    expect(document.activeElement).not.toBe(destination.card());
    expect(destination.buy).not.toHaveBeenCalled();
  });

  it("keeps focus inside an existing modal, and user interaction cancels a pending navigation focus", async () => {
    await browser(); session(); const target = root();
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
    modal.innerHTML = '<input aria-label="Current task">'; target.append(modal);
    const input = modal.querySelector("input")!; input.focus();
    stops.push(bindProOptionsNavigation(target));
    await openBrowserPro();
    const destination = await options(target);
    await flush();
    expect(document.activeElement).toBe(input);
    await fireEvent.keyDown(input, { key: "a" });
    modal.remove();
    await flush();
    expect(document.activeElement).not.toBe(destination.card());
    expect(destination.buy).not.toHaveBeenCalled();
  });
});
