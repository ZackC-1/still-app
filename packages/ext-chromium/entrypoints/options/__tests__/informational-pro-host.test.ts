import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { unmount } from "svelte";
import { FEATURE_REGISTRY, type AccessState, type BenefitAccessSnapshot } from "@still/shared-types";
import { initialAccessSnapshot, ACCESS_BENEFITS } from "@still/core/entitlement";
import { browser, flush } from "../../../../core/src/ui/__tests__/committed-popup-host.fixtures.js";
import { PRO_NAVIGATION_KEY } from "../../../lib/pro-navigation.js";

vi.mock("@still/shared-types", async original => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));
vi.mock("wxt/browser", () => ({ get browser() { return globalThis.chrome; } }));
const mounted = vi.hoisted(() => ({ instances: [] as Record<string, unknown>[] }));
vi.mock("svelte", async original => {
  const real = await original<typeof import("svelte")>();
  return { ...real, mount: (component: Parameters<typeof real.mount>[0], options: Parameters<typeof real.mount>[1]) => {
    const instance = real.mount(component, options);
    mounted.instances.push(instance);
    return instance;
  } };
});
import OptionsApp from "../OptionsApp.svelte";
import { createExtensionUiController } from "@still/core/ui";

beforeAll(async () => {
  await import("@still/core/ui/v3/ExtensionSettings.svelte");
  await import("../InformationalProSettings.svelte");
});
afterEach(async () => {
  for (const instance of mounted.instances.splice(0)) await unmount(instance);
  cleanup();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); localStorage.clear();
});

function access(state: AccessState): BenefitAccessSnapshot {
  const value = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  return { ...value, states: Object.fromEntries(Object.entries(value.states).map(([id, prior]) => [id, FEATURE_REGISTRY.some(row => row.id === id && row.tier === "pro") ? state : prior])) as BenefitAccessSnapshot["states"] };
}

async function host(state: AccessState = "locked", modern = true, configured = true) {
  const f = await browser();
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  let snapshot: BenefitAccessSnapshot | Promise<BenefitAccessSnapshot> = access(state);
  let accountId: string | null = null;
  const messages: Record<string, unknown>[] = [];
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    messages.push(message);
    if (message.kind === "observeBenefits") return { ok: true, snapshot: await snapshot };
    if (message.kind === "still:analytics") return undefined;
    if (message.kind === "still:session") {
      switch (message.action) {
        case "getState": return { userId: accountId, entitled: false, pendingOtp: null, checkoutPending: null };
        case "getSyncStatus": return accountId ? { accountId, email: "fixture@still.test", lastSyncedAt: 1, pendingUpload: false, cloudReachable: true, updatedAt: 1 } : null;
        case "getVerifiedAccount": return accountId ? { id: accountId, email: "fixture@still.test", emailConfirmed: true } : null;
        case "requestCode": return { kind: "sent" };
        case "verifyCode": accountId = "11111111-1111-4111-8111-111111111111"; return { kind: "verified", userId: accountId, email: "fixture@still.test" };
        case "setPendingOtp": return "ok";
        case "restore": return "entitled"; // Deliberately unsafe legacy Boolean must not be consumed.
        default: return undefined;
      }
    }
    return original(message);
  });
  const sessionRecord: Record<string, unknown> = {};
  const sessionSet = vi.fn(async (values: Record<string, unknown>) => { Object.assign(sessionRecord, structuredClone(values)); });
  const openOptionsPage = vi.fn(async () => {});
  Object.assign(chrome.storage, { session: { set: sessionSet, get: async () => structuredClone(sessionRecord) } });
  Object.assign(chrome.runtime, { sendMessage, openOptionsPage, getPlatformInfo: async () => ({ os: "android" }) });
  vi.stubEnv("VITE_SUPABASE_URL", configured ? "https://fixture.invalid" : "");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", configured ? "fixture-public-key" : "");
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", modern ? "true" : "");
  return { ...f, messages, sessionRecord, openOptionsPage, snapshot(next: typeof snapshot) { snapshot = next; },
    async invalidate() { f.invalidate(); await flush(); },
  };
}

const money = (messages: Record<string, unknown>[]) => messages.filter(message => ["createCheckout", "setCheckoutPending", "restore"].includes(String(message.action)) || (message.action === "setPurchaseIntent" && message.active !== false));

describe("actual paid-V3 informational options destination", () => {
  it("mounts the compact unverified Pro card from the current access authority, focuses it, and leaves legacy Restore unavailable", async () => {
    const f = await host(); const before = structuredClone(f.store);
    render(OptionsApp);
    const region = await screen.findByRole("region", { name: "Still Pro" });
    expect(await within(region).findByText("Still Pro can't be bought here yet.")).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(within(region).queryByText("Related videos")).toBeNull();
    const restore = within(region).getByRole("button", { name: "Restore purchase" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true); await fireEvent.click(restore);
    const youtube = screen.getByRole("button", { name: "YouTube Blocker" });
    if (youtube.getAttribute("aria-expanded") !== "true") await fireEvent.click(youtube);
    await fireEvent.click(await screen.findByRole("button", { name: "Comments. Included in Still Pro. See Still Pro" }));
    expect(document.activeElement).toBe(region);
    expect(f.messages.filter(message => message.kind === "observeBenefits")).toHaveLength(1);
    expect(f.store).toEqual(before);
    expect(money(f.messages)).toEqual([]);
  });

  it.each([["Chrome", false], ["Firefox", false], ["Firefox", true]] as const)("actual %s Android=%s popup main opens the actual informational options region without checkout", async (name, android) => {
    const f = await host();
    vi.stubEnv("FIREFOX", name === "Firefox" ? "true" : "");
    Object.assign(chrome.runtime, { getPlatformInfo: async () => ({ os: android ? "android" : "linux" }) });
    document.body.innerHTML = '<div id="app"></div>';
    await import(/* @vite-ignore */ `../../popup/main.js?information-${name}-${android}`);
    const youtube = await screen.findByRole("button", { name: "YouTube Blocker" });
    if (youtube.getAttribute("aria-expanded") !== "true") await fireEvent.click(youtube);
    await fireEvent.click(await screen.findByRole("button", { name: "Comments. Included in Still Pro. See Still Pro" }));
    await waitFor(() => expect(f.openOptionsPage).toHaveBeenCalledOnce());
    expect(f.sessionRecord[PRO_NAVIGATION_KEY]).toMatchObject({ target: "pro" });
    for (const instance of mounted.instances.splice(0)) await unmount(instance);
    document.body.innerHTML = "";
    render(OptionsApp);
    const region = await screen.findByRole("region", { name: "Still Pro" });
    await waitFor(() => expect(document.activeElement).toBe(region));
    expect(within(region).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(money(f.messages)).toEqual([]);
  });

  it("keeps the actual free-sync sign-in available without turning it into a purchase intent", async () => {
    const f = await host(); render(OptionsApp); await screen.findByRole("region", { name: "Still Pro" });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const consent = await screen.findByRole("dialog", { name: "Your email is only for sign-in" });
    await fireEvent.click(within(consent).getByRole("button", { name: "Continue" }));
    await fireEvent.input(screen.getByLabelText("Email address"), { target: { value: "fixture@still.test" } });
    await fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await fireEvent.input(await screen.findByLabelText("6-digit code"), { target: { value: "123456" } });
    await fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await waitFor(() => expect(screen.getByText("fixture@still.test")).toBeTruthy());
    expect(f.messages.some(message => message.action === "verifyCode")).toBe(true);
    expect(money(f.messages)).toEqual([]);
  });

  it.each(["unsupported", "purchased", "protected", "checking", "verification_required"] as const)("%s access offers no acquisition navigation or paid Restore", async state => {
    const f = await host(state); render(OptionsApp);
    const youtube = await screen.findByRole("button", { name: "YouTube Blocker" });
    if (youtube.getAttribute("aria-expanded") !== "true") await fireEvent.click(youtube);
    await flush();
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Comments\. Included in Still Pro\. See Still Pro/ })).toBeNull();
    if (["unsupported", "purchased", "protected"].includes(state))
      await waitFor(() => expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull());
    else {
      const region = await screen.findByRole("region", { name: "Still Pro" });
      if (state === "checking") {
        await within(region).findByText("Checking your Still Pro access…");
        expect(within(region).queryByRole("button", { name: "Restore purchase" })).toBeNull();
      } else {
        await within(region).findByText("Still Pro needs to be verified again.");
        expect(within(region).getByRole("button", { name: "Restore purchase" })).toHaveProperty("disabled", true);
      }
    }
    expect(money(f.messages)).toEqual([]);
  });

  it("keeps configured legacy-host mode outside the informational destination", async () => {
    const f = await host("locked", false); render(OptionsApp);
    await screen.findByRole("switch", { name: "Still on/off" }); await flush();
    expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
    expect(f.messages.some(message => message.kind === "observeBenefits")).toBe(false);
    expect(money(f.messages)).toEqual([]);
  });

  it("uses current observation epochs after invalidation and never unlocks from the historical Boolean", async () => {
    const f = await host();
    render(OptionsApp);
    const region = await screen.findByRole("region", { name: "Still Pro" });
    await within(region).findByText("Still Pro can't be bought here yet.");
    const youtube = screen.getByRole("button", { name: "YouTube Blocker" });
    if (youtube.getAttribute("aria-expanded") !== "true") await fireEvent.click(youtube);
    const lock = screen.getByRole("button", { name: "Comments. Included in Still Pro. See Still Pro" });
    let finish!: (value: BenefitAccessSnapshot) => void;
    f.snapshot(new Promise(resolve => { finish = resolve; }));
    await chrome.storage.local.set({ "still:entitlement": { entitled: true, updatedAt: Date.now(), access: { generation: 1 } } });
    await waitFor(() => expect(f.messages.filter(message => message.kind === "observeBenefits")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Comments. Included in Still Pro. See Still Pro" })).toBeNull();
    expect(within(region).getByRole("button", { name: "Restore purchase" })).toHaveProperty("disabled", true);
    lock.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.activeElement).not.toBe(region);
    // A second invalidation fences the old locked answer. Only the fresh held observation wins.
    f.snapshot(access("verification_required"));
    await chrome.storage.local.set({ "still:entitlement": { entitled: true, updatedAt: Date.now(), access: undefined } });
    finish(access("locked"));
    await waitFor(() => expect(f.messages.filter(message => message.kind === "observeBenefits")).toHaveLength(3));
    await flush();
    expect(within(region).getByText("Still Pro needs to be verified again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Comments. Included in Still Pro. See Still Pro" })).toBeNull();
    expect(money(f.messages)).toEqual([]);
  });

  it("does not start a paid access observation without a committed binding selector", async () => {
    const f = await host();
    createExtensionUiController(undefined, { accessHost: "chromium" });
    await flush();
    expect(f.messages.some(message => message.kind === "observeBenefits")).toBe(false);
    expect(money(f.messages)).toEqual([]);
  });
});
