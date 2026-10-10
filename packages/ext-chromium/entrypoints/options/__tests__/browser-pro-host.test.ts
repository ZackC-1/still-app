import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { unmount } from "svelte";
import { FEATURE_REGISTRY, type AccessState, type BenefitAccessSnapshot } from "@still/shared-types";
import { initialAccessSnapshot, ACCESS_BENEFITS } from "@still/core/entitlement";
import { browser, flush } from "../../../../core/src/ui/__tests__/committed-popup-host.fixtures.js";

// The paid-tier browser Still Pro card over the actual options page, controller, App and
// ExtensionSettings. Only the background is synthetic: it answers the session messages and the
// access observation the way the real worker does (a reconcile changes what the next observation
// reads; a "none" answer changes nothing in storage).
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

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CHECKOUT_URL = "https://checkout.fixture.invalid/session";

beforeAll(async () => {
  await import("@still/core/ui/v3/ExtensionSettings.svelte");
  await import("../InformationalProSettings.svelte");
});
afterEach(async () => {
  for (const instance of mounted.instances.splice(0)) await unmount(instance);
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); localStorage.clear();
});

function access(state: AccessState): BenefitAccessSnapshot {
  const value = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  return { ...value, states: Object.fromEntries(Object.entries(value.states).map(([id, prior]) => [id, FEATURE_REGISTRY.some(row => row.id === id && row.tier === "pro") ? state : prior])) as BenefitAccessSnapshot["states"] };
}

function visibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

interface Fixture {
  signedIn?: boolean;
  /** What the page observes before any re-check (the lost "known none" after a worker restart). */
  before?: AccessState;
  /** What the observation reads after each reconcile. */
  after?: AccessState;
  outcome?: "entitled" | "not-entitled" | "unknown";
  available?: boolean;
  checkout?: Record<string, unknown>;
}

async function host(options: Fixture = {}) {
  const f = await browser();
  let snapshot = access(options.before ?? "verification_required");
  let after = options.after ?? "locked";
  let outcome = options.outcome ?? "not-entitled";
  let available = options.available ?? true;
  let checkout = options.checkout ?? { kind: "checkout-url", url: CHECKOUT_URL };
  const accountId: string | null = options.signedIn === false ? null : ACCOUNT;
  const messages: Record<string, unknown>[] = [];
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    messages.push(message);
    if (message.kind === "observeBenefits") return { ok: true, snapshot };
    if (message.kind === "still:analytics") return undefined;
    if (message.kind === "still:session") {
      switch (message.action) {
        case "getState": return { userId: accountId, entitled: false, pendingOtp: null, checkoutPending: null };
        case "getSyncStatus": return accountId ? { accountId, email: "fixture@still.test", lastSyncedAt: 1, pendingUpload: false, cloudReachable: true, updatedAt: 1 } : null;
        case "getVerifiedAccount": return accountId ? { id: accountId, email: "fixture@still.test", emailConfirmed: true } : null;
        case "reconcile": snapshot = access(after); return outcome;
        case "checkoutAvailable": return available;
        case "createCheckout": return checkout;
        case "requestCode": return { kind: "sent" };
        case "setPendingOtp": return "ok";
        default: return undefined;
      }
    }
    return original(message);
  });
  const tabsCreate = vi.fn(async (_options: { url: string }) => ({ id: 7 }));
  Object.assign(chrome.storage, { session: { set: vi.fn(async () => {}), get: async () => ({}) } });
  Object.assign(chrome.runtime, { sendMessage, openOptionsPage: vi.fn(async () => {}), getPlatformInfo: async () => ({ os: "mac" }) });
  Object.assign(chrome, { tabs: { create: tabsCreate } });
  vi.stubEnv("VITE_SUPABASE_URL", "https://fixture.invalid");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "fixture-public-key");
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
  visibility("visible");
  return {
    ...f, messages, tabsCreate,
    actions: () => messages.map(message => String(message.action ?? message.kind)),
    set(next: { after?: AccessState; outcome?: Fixture["outcome"]; available?: boolean; checkout?: Record<string, unknown> }) {
      after = next.after ?? after; outcome = next.outcome ?? outcome;
      available = next.available ?? available; checkout = next.checkout ?? checkout;
    },
  };
}

const region = () => screen.findByRole("region", { name: "Still Pro" });
const paid = (messages: Record<string, unknown>[]) =>
  messages.filter(message => message.action === "setCheckoutPending" || (message.action === "setPurchaseIntent" && message.active !== false));

describe("paid-tier browser Still Pro card", () => {
  it("re-checks when the page opens, reads access after the reconcile, and offers Buy with no price", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await within(card).findByRole("button", { name: "Get Still Pro" });
    expect(within(card).getByText("The price is shown at checkout.")).toBeTruthy();
    expect(card.textContent).not.toMatch(/\$|9\.99|1\.99/);
    const actions = f.actions();
    // The access read that shows Buy comes after the page-open reconcile, and the Buy question
    // after that "known none".
    expect(actions.indexOf("reconcile")).toBeGreaterThan(-1);
    expect(actions.lastIndexOf("observeBenefits")).toBeGreaterThan(actions.indexOf("reconcile"));
    expect(actions.indexOf("checkoutAvailable")).toBeGreaterThan(actions.indexOf("reconcile"));
    expect(actions.filter(action => action === "reconcile")).toHaveLength(1);
    expect(actions).not.toContain("createCheckout");
  });

  it("Buy calls the background's createCheckout, opens the hosted checkout and waits without a pending flag", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await fireEvent.click(await within(card).findByRole("button", { name: "Get Still Pro" }));
    await waitFor(() => expect(f.tabsCreate).toHaveBeenCalledWith({ url: CHECKOUT_URL }));
    expect(f.actions().filter(action => action === "createCheckout")).toHaveLength(1);
    const waiting = within(card).getByRole("button", { name: "Waiting for checkout…" }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    // The legacy paywall's persisted pending flag would reopen that sheet in the popup.
    expect(paid(f.messages)).toEqual([]);
  });

  it("shows Purchased after the purchase completes, and stops after a refund on the next re-check", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await fireEvent.click(await within(card).findByRole("button", { name: "Get Still Pro" }));
    await waitFor(() => expect(f.tabsCreate).toHaveBeenCalledOnce());
    // Paid in the checkout tab, then back to this page: the re-check completes the purchase.
    visibility("hidden");
    f.set({ after: "purchased", outcome: "entitled" });
    // The clock keeps running; each return to the page is past the re-check spacing.
    const realNow = Date.now.bind(Date);
    let offset = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const reads = f.actions().filter(action => action === "observeBenefits").length;
    visibility("visible");
    await screen.findByText("Purchased");
    // Let that re-check finish its second access read before the next return to the page.
    await waitFor(() => expect(f.actions().filter(action => action === "observeBenefits").length).toBe(reads + 2));
    expect(screen.getByText("Still Pro and sync")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull());
    // Refunded: the server revokes, and the next re-check no longer shows Purchased.
    f.set({ after: "locked", outcome: "not-entitled" });
    offset = 20_000;
    visibility("hidden");
    visibility("visible");
    await waitFor(() => expect(screen.queryByText("Purchased")).toBeNull());
    expect(await within(await region()).findByRole("button", { name: "Get Still Pro" })).toBeTruthy();
  });

  it("offers no Buy when the background says this build may not sell here", async () => {
    const f = await host({ available: false });
    render(OptionsApp);
    const card = await region();
    await within(card).findByText("Still Pro can't be bought here yet.");
    expect(within(card).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(f.actions()).toContain("checkoutAvailable");
    expect(f.actions()).not.toContain("createCheckout");
  });

  it("asks nothing about Buy and offers none while access needs verifying", async () => {
    const f = await host({ after: "verification_required", outcome: "unknown" });
    render(OptionsApp);
    const card = await region();
    await within(card).findByText("Still Pro needs to be verified again.");
    await flush();
    expect(within(card).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(f.actions()).not.toContain("checkoutAvailable");
  });

  it("Restore runs the scoped re-check and reports from the access it reads", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await within(card).findByRole("button", { name: "Get Still Pro" });
    const before = f.actions().filter(action => action === "reconcile").length;
    await fireEvent.click(within(card).getByRole("button", { name: "Restore purchase" }));
    await screen.findByText("No Still Pro purchase was found for this account.");
    expect(f.actions().filter(action => action === "reconcile")).toHaveLength(before + 1);
    expect(f.actions()).not.toContain("restore");
    f.set({ after: "purchased", outcome: "entitled" });
    await fireEvent.click(within(card).getByRole("button", { name: "Restore purchase" }));
    await screen.findByText("Still Pro is restored on this device.");
    await screen.findByText("Purchased");
    expect(paid(f.messages)).toEqual([]);
  });

  it("a reconcile that says entitled without access to show is not reported as restored", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await within(card).findByRole("button", { name: "Get Still Pro" });
    f.set({ after: "verification_required", outcome: "entitled" });
    await fireEvent.click(within(card).getByRole("button", { name: "Restore purchase" }));
    await screen.findByText("We couldn't finish checking. Nothing changed.");
    expect(screen.queryByText("Still Pro is restored on this device.")).toBeNull();
  });

  it("signed out, Restore opens the normal sign-in instead of checking", async () => {
    const f = await host({ signedIn: false });
    render(OptionsApp);
    const card = await region();
    await within(card).findByText("Still Pro needs to be verified again.");
    await fireEvent.click(within(card).getByRole("button", { name: "Restore purchase" }));
    await screen.findByRole("dialog", { name: "Your email is only for sign-in" });
    expect(f.actions()).not.toContain("reconcile");
    expect(f.actions()).not.toContain("checkoutAvailable");
  });

  it("a checkout that cannot start shows the calm failure, and Try again asks and buys again", async () => {
    const f = await host({ checkout: { kind: "unavailable" } });
    render(OptionsApp);
    const card = await region();
    await fireEvent.click(await within(card).findByRole("button", { name: "Get Still Pro" }));
    await within(card).findByText("The purchase wasn't confirmed.");
    expect(f.tabsCreate).not.toHaveBeenCalled();
    f.set({ checkout: { kind: "checkout-url", url: CHECKOUT_URL } });
    const asked = f.actions().filter(action => action === "checkoutAvailable").length;
    await fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(f.tabsCreate).toHaveBeenCalledWith({ url: CHECKOUT_URL }));
    expect(f.actions().filter(action => action === "checkoutAvailable")).toHaveLength(asked + 1);
  });
});
