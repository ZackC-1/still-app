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
  delete (navigator as { onLine?: boolean }).onLine;
});

function access(state: AccessState): BenefitAccessSnapshot {
  const value = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  return { ...value, states: Object.fromEntries(Object.entries(value.states).map(([id, prior]) => [id, FEATURE_REGISTRY.some(row => row.id === id && row.tier === "pro") ? state : prior])) as BenefitAccessSnapshot["states"] };
}

/** The browser's network signal, as navigator.onLine and the window's online/offline events. */
function network(online: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
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
  let pending: Record<string, unknown> | null = null;
  let lapses = 0;
  const messages: Record<string, unknown>[] = [];
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    messages.push(message);
    if (message.kind === "observeBenefits") return { ok: true, snapshot };
    if (message.kind === "still:analytics") return undefined;
    if (message.kind === "still:session") {
      switch (message.action) {
        case "getState": return { userId: accountId, entitled: false, pendingOtp: null, checkoutPending: pending };
        case "setCheckoutPending": pending = (message.pending as Record<string, unknown> | null) ?? null; return "ok";
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
  const openTabs = new Set<number>();
  let nextTab = 7;
  const tabsCreate = vi.fn(async (_options: { url: string }) => { const id = nextTab++; openTabs.add(id); return { id }; });
  const tabsUpdate = vi.fn(async (_tabId: number, _props: { active: boolean }) => ({}));
  const sessionArea: Record<string, unknown> = {};
  Object.assign(chrome.storage, { session: {
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionArea, structuredClone(items)); }),
    get: async (key: string) => (key in sessionArea ? { [key]: structuredClone(sessionArea[key]) } : {}),
  } });
  Object.assign(chrome.runtime, { sendMessage, openOptionsPage: vi.fn(async () => {}), getPlatformInfo: async () => ({ os: "mac" }) });
  Object.assign(chrome, {
    tabs: {
      create: tabsCreate,
      get: async (tabId: number) => { if (!openTabs.has(tabId)) throw new Error("No tab"); return { id: tabId, windowId: 1 }; },
      update: tabsUpdate,
      remove: vi.fn(async (tabId: number) => { openTabs.delete(tabId); }),
    },
    windows: { update: vi.fn(async () => ({})) },
  });
  vi.stubEnv("VITE_SUPABASE_URL", "https://fixture.invalid");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "fixture-public-key");
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
  visibility("visible");
  return {
    ...f, messages, tabsCreate, tabsUpdate, openTabs,
    get pending() { return pending; },
    /** The background's "known none" went stale: a sync, a sign-in refresh or its minute passing. */
    async lapse() {
      snapshot = access("verification_required");
      // A material change to the stored access record is what makes the page observe access again.
      lapses += 1;
      await chrome.storage.local.set({ "still:entitlement": { entitled: false, updatedAt: Date.now(),
        access: lapses % 2 === 1 ? { generation: lapses } : undefined } });
      await flush();
    },
    actions: () => messages.map(message => String(message.action ?? message.kind)),
    set(next: { after?: AccessState; outcome?: Fixture["outcome"]; available?: boolean; checkout?: Record<string, unknown> }) {
      after = next.after ?? after; outcome = next.outcome ?? outcome;
      available = next.available ?? available; checkout = next.checkout ?? checkout;
    },
  };
}

const region = () => screen.findByRole("region", { name: "Still Pro" });
/** A purchase intent would reopen the legacy paywall (with its compiled price) after sign-in. */
const intent = (messages: Record<string, unknown>[]) =>
  messages.filter(message => message.action === "setPurchaseIntent" && message.active !== false);

describe("paid-tier browser Still Pro card", () => {
  it("counts an offer only after its sellable card enters a visible viewport, once per page", async () => {
    const observers: { callback: IntersectionObserverCallback; target?: Element }[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      record: { callback: IntersectionObserverCallback; target?: Element };
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback }; observers.push(this.record);
      }
      observe(target: Element) { this.record.target = target; }
      disconnect() {}
    });
    const f = await host();
    render(OptionsApp);
    await within(await region()).findByRole("button", { name: "Get Still Pro" });
    await waitFor(() => expect(observers.some(item => item.target)).toBe(true));
    const impressions = () => f.messages.filter(message => message.name === "paywall_viewed");
    expect(impressions()).toEqual([]);
    visibility("hidden");
    const observer = observers.find(item => item.target)!;
    observer.callback([{ target: observer.target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await flush();
    expect(impressions()).toEqual([]);
    visibility("visible"); await flush();
    expect(impressions()).toEqual([
      { kind: "still:analytics", action: "track", name: "paywall_viewed",
        props: { trigger: "settings_card", where: "options" } },
    ]);
    observer.callback([{ target: observer.target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    visibility("hidden"); visibility("visible"); await flush();
    expect(impressions()).toHaveLength(1);
  });

  it("re-checks when the page opens, reads access after the reconcile, and offers Buy with no price", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await within(card).findByRole("button", { name: "Get Still Pro" });
    // Owner, 21 Oct: the configured price line for the reviewed offer, under Get Still Pro; never
    // the retired 2.x price.
    expect(within(card).getByText("$9.99 · one-time")).toBeTruthy();
    expect(within(card).queryByText("The price is shown at checkout.")).toBeNull();
    expect(card.textContent).not.toMatch(/1\.99/);
    const actions = f.actions();
    // The access read that shows Buy comes after the page-open reconcile, and the Buy question
    // after that "known none".
    expect(actions.indexOf("reconcile")).toBeGreaterThan(-1);
    expect(actions.lastIndexOf("observeBenefits")).toBeGreaterThan(actions.indexOf("reconcile"));
    expect(actions.indexOf("checkoutAvailable")).toBeGreaterThan(actions.indexOf("reconcile"));
    expect(actions.filter(action => action === "reconcile")).toHaveLength(1);
    expect(actions).not.toContain("createCheckout");
  });

  it("Buy calls the background's createCheckout, opens the hosted checkout and records its tab", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await fireEvent.click(await within(card).findByRole("button", { name: "Get Still Pro" }));
    await waitFor(() => expect(f.tabsCreate).toHaveBeenCalledWith({ url: CHECKOUT_URL }));
    expect(f.actions().filter(action => action === "createCheckout")).toHaveLength(1);
    const waiting = within(card).getByRole("button", { name: "Waiting for checkout…" }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    // The pending record carries the tab, so sign-out or an account switch closes it.
    await waitFor(() => expect(f.pending).toMatchObject({ tabId: 7 }));
    expect(typeof f.pending?.startedAt).toBe("number");
    expect(intent(f.messages)).toEqual([]);
    expect(f.messages.filter(message => message.name === "purchase_started")).toEqual([
      { kind: "still:analytics", action: "track", name: "purchase_started",
        props: { purchase_origin: "web", product: "still-pro-v3" } },
    ]);
    expect(f.messages.some(message => message.name === "purchase_completed" || message.name === "purchase_recorded")).toBe(false);
  });

  it("Buy again brings the open checkout tab forward instead of opening a second", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await fireEvent.click(await within(card).findByRole("button", { name: "Get Still Pro" }));
    await waitFor(() => expect(f.pending).toMatchObject({ tabId: 7 }));
    visibility("hidden"); visibility("visible"); // back without paying
    await fireEvent.click(await within(card).findByRole("button", { name: "Get Still Pro" }));
    await waitFor(() => expect(f.tabsUpdate).toHaveBeenCalledWith(7, { active: true }));
    expect(f.tabsCreate).toHaveBeenCalledOnce();
    expect(f.actions().filter(action => action === "createCheckout")).toHaveLength(1);
    expect(f.pending).toMatchObject({ tabId: 7 });
  });

  it("a second settings page brings the first page's checkout tab forward", async () => {
    const f = await host();
    render(OptionsApp);
    await fireEvent.click(await within(await region()).findByRole("button", { name: "Get Still Pro" }));
    await waitFor(() => expect(f.pending).toMatchObject({ tabId: 7 }));
    for (const instance of mounted.instances.splice(0)) await unmount(instance);
    cleanup();
    render(OptionsApp); // another settings page in the same browser session
    await fireEvent.click(await within(await region()).findByRole("button", { name: "Get Still Pro" }));
    await waitFor(() => expect(f.tabsUpdate).toHaveBeenCalledWith(7, { active: true }));
    expect(f.tabsCreate).toHaveBeenCalledOnce();
    expect([...f.openTabs]).toEqual([7]);
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
    const syncSection = () => screen.getByRole("heading", { name: "Settings sync" }).closest("section")!;
    await waitFor(() => expect(within(syncSection()).getByText("Still Pro User")).toBeTruthy());
    // Let that re-check finish its second access read before the next return to the page.
    await waitFor(() => expect(f.actions().filter(action => action === "observeBenefits").length).toBe(reads + 2));
    // Owned (owner, 19 Oct): the sync card's Still Pro tag is the signal; no Still Pro card.
    expect(screen.queryByText("Still Pro and sync")).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings sync" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
      expect(within(syncSection()).getByText("Still Pro User")).toBeTruthy();
    });
    // An owner's page shown again does not re-check.
    const settled = f.actions().filter(action => action === "reconcile").length;
    offset = 60_000;
    visibility("hidden");
    visibility("visible");
    await flush();
    expect(f.actions().filter(action => action === "reconcile")).toHaveLength(settled);
    // Refunded: the server revokes, and the next re-check (opening the page) drops Purchased.
    f.set({ after: "locked", outcome: "not-entitled" });
    for (const instance of mounted.instances.splice(0)) await unmount(instance);
    cleanup();
    render(OptionsApp);
    expect(await within(await region()).findByRole("button", { name: "Get Still Pro" })).toBeTruthy();
    expect(within(screen.getByRole("heading", { name: "Settings sync" }).closest("section")!).queryByText("Still Pro User")).toBeNull();
  });

  it("reopened with a settings checkout pending, the page re-checks and never shows the legacy priced sheet", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await fireEvent.click(await within(card).findByRole("button", { name: "Get Still Pro" }));
    await waitFor(() => expect(f.pending).toMatchObject({ tabId: 7 }));
    for (const instance of mounted.instances.splice(0)) await unmount(instance);
    cleanup();
    const before = f.actions().filter(action => action === "reconcile").length;
    render(OptionsApp);
    await within(await region()).findByRole("button", { name: "Get Still Pro" });
    expect(f.actions().filter(action => action === "reconcile")).toHaveLength(before + 1);
    expect(screen.queryByRole("dialog")).toBeNull();
    // No legacy sheet price; the only price is the card's configured line (owner, 21 Oct).
    expect(document.body.textContent).not.toMatch(/1\.99/);
    expect(document.body.textContent?.match(/\$\d[\d.]*/g)).toEqual(["$9.99"]);
    expect(f.pending).toMatchObject({ tabId: 7 }); // still pending: only the background ends it
  });

  it("drops a pending record older than the pending lifetime when the page opens", async () => {
    const f = await host();
    await chrome.runtime.sendMessage({ kind: "still:session", action: "setCheckoutPending", pending: { startedAt: Date.now() - 25 * 60 * 60_000, tabId: 3 } });
    render(OptionsApp);
    await within(await region()).findByRole("button", { name: "Get Still Pro" });
    await waitFor(() => expect(f.pending).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no Buy when the background says this build may not sell here", async () => {
    const f = await host({ available: false });
    render(OptionsApp);
    const card = await region();
    await within(card).findByText("Still Pro can't be bought here yet.");
    expect(within(card).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    // Sales off: no price anywhere on the card.
    expect(card.textContent).not.toMatch(/\$|one-time ·|· one-time/);
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

  it("an open page whose known none goes stale re-checks it quietly instead of asking to verify (ISS-0072)", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await within(card).findByRole("button", { name: "Get Still Pro" });
    const before = f.actions().filter(action => action === "reconcile").length;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const send = chrome.runtime.sendMessage as unknown as { getMockImplementation(): (m: Record<string, unknown>) => Promise<unknown>; mockImplementation(fn: (m: Record<string, unknown>) => Promise<unknown>): void };
    const answer = send.getMockImplementation();
    send.mockImplementation(async message => {
      if (message.action === "reconcile") await held;
      return answer(message);
    });
    await f.lapse();
    // While the renewal runs the card says it is checking, never "verify again".
    await within(card).findByText("Checking your Still Pro access…");
    expect(within(card).queryByText("Still Pro needs to be verified again.")).toBeNull();
    release();
    send.mockImplementation(answer);
    await within(card).findByRole("button", { name: "Get Still Pro" });
    expect(f.actions().filter(action => action === "reconcile")).toHaveLength(before + 1);
    expect(within(card).queryByText("Still Pro needs to be verified again.")).toBeNull();
    // Gone stale again while hidden (the checkout tab in front), then shown: re-checked at once.
    visibility("hidden");
    await f.lapse();
    visibility("visible");
    await within(card).findByRole("button", { name: "Get Still Pro" });
    await waitFor(() => expect(f.actions().filter(action => action === "reconcile")).toHaveLength(before + 2));
    expect(within(card).queryByText("Still Pro needs to be verified again.")).toBeNull();
  });

  it("says verify again when the re-check of a stale known none does not confirm it", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await within(card).findByRole("button", { name: "Get Still Pro" });
    f.set({ after: "verification_required", outcome: "unknown" });
    await f.lapse();
    await within(card).findByText("Still Pro needs to be verified again.");
    expect(within(card).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
  });

  it("offline, Restore on an account that never bought changes nothing, and its lapse never says verify again (ISS-0090)", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    await within(card).findByRole("button", { name: "Get Still Pro" });
    network(false);
    // The reconcile cannot reach the server; the background still holds the known none.
    f.set({ after: "locked", outcome: "unknown" });
    await fireEvent.click(within(card).getByRole("button", { name: "Restore purchase" }));
    await screen.findByText("We couldn't finish checking. Nothing changed.");
    expect((within(card).getByRole("button", { name: "Get Still Pro" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(card).queryByText("Still Pro needs to be verified again.")).toBeNull();
    // That known none's minute then passes while still offline; the re-check that would renew it
    // cannot reach the server.
    f.set({ after: "verification_required", outcome: "unknown" });
    const reconciles = f.actions().filter(action => action === "reconcile").length;
    await f.lapse();
    await within(card).findByText("Still can't check right now.");
    expect(within(card).getByText("Try again when you're online.")).toBeTruthy();
    expect(within(card).queryByText("Still Pro needs to be verified again.")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    // The Still Pro rows keep their locks.
    expect(screen.queryByText("Verify Still Pro to use this. Your choice is saved.")).toBeNull();
    expect(document.querySelector('[data-access="verify"]')).toBeNull();
    expect(document.querySelectorAll('[data-access="locked"]').length).toBeGreaterThan(0);
    await waitFor(() => expect(f.actions().filter(action => action === "reconcile")).toHaveLength(reconciles + 2));
    // Restore again while held: the card keeps its offline line, never "verify again".
    await fireEvent.click(within(card).getByRole("button", { name: "Restore purchase" }));
    await waitFor(() => expect(f.actions().filter(action => action === "reconcile")).toHaveLength(reconciles + 3));
    expect(within(card).getByText("Still can't check right now.")).toBeTruthy();
    expect(within(card).queryByText("Still Pro needs to be verified again.")).toBeNull();
    // Back online: the known none is renewed and Get Still Pro returns without a reload.
    f.set({ after: "locked", outcome: "not-entitled" });
    network(true);
    await within(card).findByRole("button", { name: "Get Still Pro" });
    expect(within(card).queryByText("Still can't check right now.")).toBeNull();
    expect(within(card).queryByText("Still Pro needs to be verified again.")).toBeNull();
  });

  it("offline, Get Still Pro opens nothing and says Still can't check right now (ISS-0090)", async () => {
    const f = await host();
    render(OptionsApp);
    const card = await region();
    const buy = await within(card).findByRole("button", { name: "Get Still Pro" });
    network(false);
    f.set({ checkout: { kind: "unavailable" } });
    await fireEvent.click(buy);
    await within(card).findByText("Still can't check right now.");
    expect(within(card).queryByText("The purchase wasn't confirmed.")).toBeNull();
    expect(f.tabsCreate).not.toHaveBeenCalled();
    network(true);
    await within(card).findByRole("button", { name: "Get Still Pro" });
  });

  it("offline, a page that cannot ask about Buy says Still can't check right now, not that it can't be bought here (ISS-0090)", async () => {
    const f = await host({ available: false });
    network(false);
    render(OptionsApp);
    const card = await region();
    await within(card).findByText("Still can't check right now.");
    expect(within(card).getByText("Try again when you're online.")).toBeTruthy();
    expect(within(card).queryByText("Still Pro can't be bought here yet.")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    // Offline: the price cannot be confirmed for sale, so the slot stays empty.
    expect(card.textContent).not.toMatch(/\$|· one-time/);
    f.set({ available: true });
    network(true);
    await within(card).findByRole("button", { name: "Get Still Pro" });
    expect(within(card).queryByText("Still can't check right now.")).toBeNull();
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
    await waitFor(() => expect(within(screen.getByRole("heading", { name: "Settings sync" }).closest("section")!).getByText("Still Pro User")).toBeTruthy());
    expect(intent(f.messages)).toEqual([]);
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

  it("signed out and known not to own it, Get Still Pro is offered and starts with sign-in (ISS-0030)", async () => {
    const f = await host({ signedIn: false, before: "locked" });
    render(OptionsApp);
    const card = await region();
    const buy = await within(card).findByRole("button", { name: "Get Still Pro" });
    expect(within(card).queryByText("Still Pro needs to be verified again.")).toBeNull();
    expect(within(card).queryByText("Still Pro can't be bought here yet.")).toBeNull();
    expect(within(card).getByRole("button", { name: "Restore purchase" })).toBeTruthy();
    await fireEvent.click(buy);
    await screen.findByRole("dialog", { name: "Your email is only for sign-in" });
    // The background is asked whether this build sells at all; nothing is bought before sign-in.
    expect(f.actions()).toContain("checkoutAvailable");
    expect(f.actions()).not.toContain("createCheckout");
    expect(f.actions()).not.toContain("reconcile");
    expect(intent(f.messages)).toEqual([]);
  });

  it("signed out on a build that does not sell here, no Get Still Pro is offered", async () => {
    await host({ signedIn: false, before: "locked", available: false });
    render(OptionsApp);
    const card = await region();
    await within(card).findByText("Still Pro can't be bought here yet.");
    expect(within(card).queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(within(card).queryByText("Still Pro needs to be verified again.")).toBeNull();
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
