import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { initialAccessSnapshot, ACCESS_BENEFITS } from "../../../../core/src/entitlement/access-policy.js";
import { EntitlementCache } from "../../../../core/src/entitlement/cache.js";
import { createDesktopPopupBinding } from "../../../../core/src/ui/v3/desktop-popup-binding.js";
import { fixture as desktopFixture } from "../../../../core/src/ui/v3/DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "../../../../core/src/ui/v3/ExtensionSettings.test-fixtures.js";
import { browser, capture, flush } from "../../../../core/src/ui/__tests__/committed-popup-host.fixtures.js";
import { CHROMIUM_SURFACE_GUIDANCE } from "@still/core/ui";
import { bindProOptionsNavigation, openBrowserPro, PRO_NAVIGATION_KEY, PRO_OPTIONS_HASH } from "../../../lib/pro-navigation.js";
import PopupApp from "../PopupApp.svelte";
import ExtensionSettings from "../../../../core/src/ui/v3/ExtensionSettings.svelte";

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

async function popup(browserName: "Chrome" | "Firefox", android = false, state: "locked" | "unsupported" | "checking" = "locked", ready = true) {
  await browser();
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
  return { ...navigation, view, props, binding, f };
}

describe("live popup/App/browser Pro navigation", () => {
  it.each([
    ["Chrome", false], ["Firefox", false], ["Firefox", true],
  ] as const)("%s Android=%s sends a fixed options request, focuses real Pro after lazy mount, and never buys", async (name, android) => {
    const f = await popup(name, android);
    const before = await f.f.storage.get();
    await fireEvent.click(screen.getByRole("button", { name: "Comments. Included in Still Pro. See Still Pro" }));
    await waitFor(() => expect(f.openOptionsPage).toHaveBeenCalledOnce());
    expect(f.set).toHaveBeenCalledOnce();
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

  it.each(["unsupported", "checking"] as const)("%s access suppresses navigation even with a verified host destination", async state => {
    const f = await popup("Chrome", false, state);
    const lock = screen.queryByRole("button", { name: /Comments\. Included in Still Pro/ });
    if (lock) await fireEvent.click(lock);
    expect(f.set).not.toHaveBeenCalled();
    expect(f.openOptionsPage).not.toHaveBeenCalled();
  });

  it("withdraws navigation when its host destination is replaced or unavailable", async () => {
    const f = await popup("Chrome");
    await f.view.rerender({ ...f.props, proDestinationReady: false });
    const lock = screen.getByRole("button", { name: "Comments. Included in Still Pro." });
    expect(lock.getAttribute("aria-disabled")).toBe("true");
    await fireEvent.click(lock);
    expect(f.set).not.toHaveBeenCalled();
    await f.view.rerender(f.props);
    Reflect.deleteProperty(chrome.storage, "session");
    await f.view.rerender({ ...f.props, proDestinationReady: false });
    await f.view.rerender(f.props);
    await fireEvent.click(screen.getByRole("button", { name: "Comments. Included in Still Pro." }));
    expect(f.openOptionsPage).not.toHaveBeenCalled();
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
