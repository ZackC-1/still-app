import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_REGISTRY, type AccessState, type BenefitAccessSnapshot } from "@still/shared-types";
import { initialAccessSnapshot, ACCESS_BENEFITS } from "@still/core/entitlement";
import type { AccessRecheck, CheckoutReconcileOutcome } from "@still/core/ui";
import type { WebCheckoutOutcome } from "@still/core/sync";
import {
  BROWSER_PRO_AVAILABLE_ACTION,
  BROWSER_PRO_SESSION_KIND,
  KEEP_ALIVE_LIMIT,
  KEEP_ALIVE_MS,
  VISIBLE_RECHECK_SPACING_MS,
  askCheckoutAvailable,
  CHECKOUT_TAB_MARK_KEY,
  extensionCheckoutTabs,
  sessionPendingStore,
  createBrowserPro,
  proOwnership,
  type BrowserProDeps,
  type CheckoutPendingLike,
  type BrowserProState,
  type ProOwnership,
} from "../browser-pro.js";
import { CHECKOUT_AVAILABLE_ACTION } from "../checkout-availability.js";
import { SESSION_MESSAGE_KIND } from "../session-messages.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function access(state: AccessState, override: Partial<Record<string, AccessState>> = {}): BenefitAccessSnapshot {
  const value = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  return { ...value, states: Object.fromEntries(Object.entries(value.states).map(([id, prior]) =>
    [id, override[id] ?? (FEATURE_REGISTRY.some(row => row.id === id && row.tier === "pro") ? state : prior)])) as BenefitAccessSnapshot["states"] };
}

function page(initial: DocumentVisibilityState = "visible") {
  const listeners = new Set<() => void>();
  const value = {
    visibilityState: initial,
    addEventListener: vi.fn((_type: string, listener: () => void) => { listeners.add(listener); }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => { listeners.delete(listener); }),
    show(state: DocumentVisibilityState) { value.visibilityState = state; for (const listener of [...listeners]) listener(); },
    listeners,
  };
  return value;
}

function harness(options: {
  recheck?: AccessState; outcome?: CheckoutReconcileOutcome; available?: boolean; checkout?: WebCheckoutOutcome; tab?: number | undefined;
  record?: { value: CheckoutPendingLike | null }; openTabs?: Set<number>;
} = {}) {
  let clock = 1_000_000;
  const visible = page();
  let next = { access: access(options.recheck ?? "locked"), outcome: options.outcome ?? "not-entitled" as CheckoutReconcileOutcome };
  const controller = {
    userId: ACCOUNT as string | null,
    signInOpen: false,
    canSignIn: true,
    openSignIn: vi.fn(),
    recheckAccess: vi.fn(async (): Promise<AccessRecheck> => next),
  };
  const checkout = {
    createCheckout: vi.fn(async (): Promise<WebCheckoutOutcome> => options.checkout ?? { kind: "checkout-url", url: "https://checkout.invalid/x" }),
    openCheckoutTab: vi.fn(async (_url: string) => ("tab" in options ? options.tab : 7)),
  };
  // The background's one checkout-pending record, shared by every page using this store.
  const record = options.record ?? { value: null as CheckoutPendingLike | null };
  const pending = {
    read: vi.fn(async () => record.value),
    write: vi.fn(async (value: CheckoutPendingLike | null) => { record.value = value; }),
  };
  const open = options.openTabs ?? new Set<number>();
  const tabs = {
    focus: vi.fn(async (r: { startedAt: number; tabId: number }) => open.has(r.tabId)),
    remember: vi.fn(async (_r: { startedAt: number; tabId: number }) => {}),
    close: vi.fn(async (tabId: number) => { open.delete(tabId); }),
  };
  checkout.openCheckoutTab.mockImplementation(async (_url: string) => {
    const tab = "tab" in options ? options.tab : 7 + open.size;
    if (tab !== undefined) open.add(tab);
    return tab;
  });
  const available = vi.fn(async () => options.available ?? true);
  const states: BrowserProState[] = [];
  const deps: BrowserProDeps = { controller, checkout, available, pending, tabs, page: visible as unknown as BrowserProDeps["page"], now: () => clock };
  const flow = createBrowserPro(deps, state => states.push(state));
  return {
    flow, controller, checkout, available, page: visible, states, pending, tabs, record, open,
    get state() { return flow.state; },
    advance(ms: number) { clock += ms; },
    answer(state: AccessState, outcome: CheckoutReconcileOutcome = "not-entitled") { next = { access: access(state), outcome }; },
    observe(ownership: ProOwnership, userId: string | null = ACCOUNT) {
      controller.userId = userId;
      flow.observe({ userId, signInOpen: controller.signInOpen, ownership });
    },
  };
}

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

describe("proOwnership reads only the access observation", () => {
  it.each([
    ["purchased", "owned"], ["protected", "hidden"], ["verification_required", "verify"],
    ["checking", "checking"], ["locked", "none"], ["unsupported", "hidden"], ["free", "hidden"],
  ] as const)("%s → %s", (state, expected) => {
    expect(proOwnership(access(state))).toBe(expected);
  });

  it("one purchased extra is owned even beside held ones; one held extra is never known none", () => {
    const pro = FEATURE_REGISTRY.filter(row => row.tier === "pro");
    expect(proOwnership(access("verification_required", { [pro[0]!.id]: "purchased" }))).toBe("owned");
    expect(proOwnership(access("locked", { [pro[0]!.id]: "verification_required" }))).toBe("verify");
    expect(proOwnership(access("locked", { [pro[0]!.id]: "checking" }))).toBe("checking");
  });
});

describe("askCheckoutAvailable", () => {
  it("speaks the session kind and the background's action name", () => {
    expect(BROWSER_PRO_SESSION_KIND).toBe(SESSION_MESSAGE_KIND);
    expect(BROWSER_PRO_AVAILABLE_ACTION).toBe(CHECKOUT_AVAILABLE_ACTION);
  });

  it.each([[true, true], [false, false], [undefined, false], ["true", false], [{ allowed: true }, false]] as const)("reply %j → %s", async (reply, expected) => {
    const sendMessage = vi.fn(async () => reply);
    expect(await askCheckoutAvailable({ sendMessage })).toBe(expected);
    expect(sendMessage).toHaveBeenCalledWith({ kind: SESSION_MESSAGE_KIND, action: CHECKOUT_AVAILABLE_ACTION });
  });

  it("a torn worker is no", async () => {
    expect(await askCheckoutAvailable({ sendMessage: async () => { throw new Error("gone"); } })).toBe(false);
  });
});

describe("checkout tabs and the pending record", () => {
  function tabsApi(options: { mark?: unknown; gone?: boolean; windows?: boolean } = {}) {
    const session: Record<string, unknown> = options.mark === undefined ? {} : { [CHECKOUT_TAB_MARK_KEY]: options.mark };
    const api = {
      storage: { session: { get: vi.fn(async (key: string) => (key in session ? { [key]: session[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(session, items); }) } },
      tabs: {
        get: vi.fn(async (tabId: number) => { if (options.gone) throw new Error(`No tab with id: ${tabId}`); return { windowId: 2 }; }),
        update: vi.fn(async () => ({})),
        remove: vi.fn(async () => {}),
      },
      ...(options.windows === false ? {} : { windows: { update: vi.fn(async () => ({})) } }),
    };
    return { api, session };
  }

  it("focuses only a tab this browser session opened for that very record", async () => {
    const record = { startedAt: 5, tabId: 7 };
    const ours = tabsApi({ mark: record });
    expect(await extensionCheckoutTabs(ours.api).focus(record)).toBe(true);
    expect(ours.api.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(ours.api.windows?.update).toHaveBeenCalledWith(2, { focused: true });
    for (const mark of [undefined, { startedAt: 5, tabId: 8 }, { startedAt: 6, tabId: 7 }]) {
      const other = tabsApi({ mark });
      expect(await extensionCheckoutTabs(other.api).focus(record)).toBe(false);
      expect(other.api.tabs.update).not.toHaveBeenCalled();
    }
    expect(await extensionCheckoutTabs(tabsApi({ mark: record, gone: true }).api).focus(record)).toBe(false);
    // Firefox for Android: no windows API, the tab still comes forward.
    expect(await extensionCheckoutTabs(tabsApi({ mark: record, windows: false }).api).focus(record)).toBe(true);
  });

  it("remembers what it opened and closes quietly", async () => {
    const h = tabsApi();
    const tabs = extensionCheckoutTabs(h.api);
    await tabs.remember({ startedAt: 5, tabId: 7 });
    expect(h.session[CHECKOUT_TAB_MARK_KEY]).toEqual({ startedAt: 5, tabId: 7 });
    h.api.tabs.remove.mockRejectedValueOnce(new Error("gone"));
    await expect(tabs.close(7)).resolves.toBeUndefined();
  });

  it("reads and writes the record through the session protocol, awaited", async () => {
    const sendMessage = vi.fn(async (message: { action?: string }) =>
      message.action === "getState" ? { userId: ACCOUNT, checkoutPending: { startedAt: 1, tabId: 2 } } : "ok");
    const store = sessionPendingStore({ sendMessage });
    expect(await store.read()).toEqual({ startedAt: 1, tabId: 2 });
    await store.write({ startedAt: 3 });
    expect(sendMessage).toHaveBeenLastCalledWith({ kind: SESSION_MESSAGE_KIND, action: "setCheckoutPending", pending: { startedAt: 3 } });
    expect(await sessionPendingStore({ sendMessage: async () => { throw new Error("torn"); } }).read()).toBeNull();
  });
});

describe("the browser Still Pro flow", () => {
  it("asks about Buy once per account, only while access is known none", async () => {
    const h = harness();
    h.observe("verify"); h.observe("checking"); await settle();
    expect(h.available).not.toHaveBeenCalled();
    h.observe("none"); h.observe("none"); await settle();
    expect(h.available).toHaveBeenCalledOnce();
    expect(h.state.channel).toBe("ready");
    // The page-open re-check belongs to the controller's setup, not to the card's first look.
    expect(h.controller.recheckAccess).not.toHaveBeenCalled();
  });

  it("a no from the background leaves the channel unavailable", async () => {
    const h = harness({ available: false });
    h.observe("none"); await settle();
    expect(h.state.channel).toBe("unavailable");
  });

  it("re-checks when someone signs in on this page, and forgets the old account's answers", async () => {
    const h = harness();
    h.observe("verify", null); await settle();
    expect(h.controller.recheckAccess).not.toHaveBeenCalled();
    h.observe("verify", ACCOUNT); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledOnce();
    expect(h.state.channel).toBe("ready"); // the re-check read "none", so Buy was asked about
    h.observe("none", OTHER); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledTimes(2);
    expect(h.available).toHaveBeenCalledTimes(2);
  });

  it("re-checks when the page is shown again, spaced, and not for an owner", async () => {
    const h = harness();
    h.observe("verify"); await settle();
    h.page.show("hidden"); h.page.show("visible"); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledOnce();
    h.advance(VISIBLE_RECHECK_SPACING_MS - 1);
    h.page.show("hidden"); h.page.show("visible"); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledOnce();
    h.advance(1);
    h.page.show("hidden"); h.page.show("visible"); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledTimes(2);
    expect(VISIBLE_RECHECK_SPACING_MS).toBeGreaterThanOrEqual(30_000);
    h.observe("owned");
    h.advance(VISIBLE_RECHECK_SPACING_MS * 4);
    h.page.show("hidden"); h.page.show("visible"); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledTimes(2);
  });

  it("a page shown again asks about Buy again behind the current answer, so a switched-off sale hides Buy", async () => {
    const h = harness();
    h.observe("none"); await settle();
    expect(h.state.channel).toBe("ready");
    h.available.mockResolvedValue(false);
    const published: string[] = [];
    h.advance(VISIBLE_RECHECK_SPACING_MS);
    const before = h.states.length;
    h.page.show("hidden"); h.page.show("visible"); await settle();
    for (const state of h.states.slice(before)) published.push(state.channel);
    expect(h.available).toHaveBeenCalledTimes(2);
    expect(h.state.channel).toBe("unavailable");
    expect(published).not.toContain("checking"); // no flash while it asks
  });

  it("renews a visible known none before it lapses, a bounded number of times per page lifetime", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.observe("none"); await settle();
    for (let i = 0; i < KEEP_ALIVE_LIMIT + 3; i++) { await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS); }
    expect(h.controller.recheckAccess).toHaveBeenCalledTimes(KEEP_ALIVE_LIMIT);
    // Hidden stops it. Shown again re-checks once, but the renewal allowance does not restart.
    h.page.show("hidden");
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
    expect(h.controller.recheckAccess).toHaveBeenCalledTimes(KEEP_ALIVE_LIMIT);
    h.advance(VISIBLE_RECHECK_SPACING_MS);
    h.page.show("visible"); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledTimes(KEEP_ALIVE_LIMIT + 1);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
    expect(h.controller.recheckAccess).toHaveBeenCalledTimes(KEEP_ALIVE_LIMIT + 1);
    // Nor does another account signing in.
    h.observe("none", OTHER); await settle();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
    expect(h.controller.recheckAccess).toHaveBeenCalledTimes(KEEP_ALIVE_LIMIT + 2); // its sign-in check only
  });

  it("does not renew anything that is not a known none, or while hidden", async () => {
    vi.useFakeTimers();
    const h = harness({ recheck: "verification_required" });
    h.observe("verify"); await settle();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
    expect(h.controller.recheckAccess).not.toHaveBeenCalled();
    const hidden = harness();
    hidden.page.visibilityState = "hidden";
    hidden.observe("none"); await settle();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
    expect(hidden.controller.recheckAccess).not.toHaveBeenCalled();
  });

  it("Buy opens the hosted checkout, waits, and offers Buy again after a return without a purchase", async () => {
    const h = harness();
    h.observe("none"); await settle();
    h.flow.buy(); await settle();
    expect(h.checkout.createCheckout).toHaveBeenCalledOnce();
    expect(h.checkout.openCheckoutTab).toHaveBeenCalledWith("https://checkout.invalid/x");
    expect(h.state.purchase).toBe("waiting");
    // The pending record is written before the tab opens, then carries the tab for teardown, and
    // this browser session remembers opening that tab for that record.
    expect(h.pending.write.mock.calls).toEqual([[{ startedAt: 1_000_000 }], [{ startedAt: 1_000_000, tabId: 7 }]]);
    expect(h.pending.write.mock.invocationCallOrder[0]).toBeLessThan(h.checkout.openCheckoutTab.mock.invocationCallOrder[0]!);
    expect(h.tabs.remember).toHaveBeenCalledWith({ startedAt: 1_000_000, tabId: 7 });
    h.flow.buy(); await settle();
    expect(h.checkout.createCheckout).toHaveBeenCalledOnce(); // no second checkout while waiting
    // Coming back from the checkout re-checks at once, whatever the spacing.
    h.page.show("hidden"); h.page.show("visible"); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledOnce();
    expect(h.state.purchase).toBe("idle");
  });

  it("coming back from the checkout re-checks even right after another re-check", async () => {
    const h = harness();
    h.observe("none"); await settle();
    h.page.show("hidden"); h.page.show("visible"); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledOnce();
    h.flow.buy(); await settle();
    h.advance(1_000); // well inside the spacing
    h.page.show("hidden"); h.page.show("visible"); await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalledTimes(2);
    expect(h.state.purchase).toBe("idle");
  });

  it("Buy that completes shows through the access observation", async () => {
    const h = harness();
    h.observe("none"); await settle();
    h.flow.buy(); await settle();
    h.observe("owned"); await settle();
    expect(h.state.purchase).toBe("idle");
  });

  it("never buys without a ready channel, an account, or a known none", async () => {
    const h = harness({ available: false });
    h.observe("none"); await settle();
    h.flow.buy(); await settle();
    const verify = harness();
    verify.observe("none"); await settle();
    verify.observe("verify"); verify.flow.buy(); await settle();
    expect(h.checkout.createCheckout).not.toHaveBeenCalled();
    expect(verify.checkout.createCheckout).not.toHaveBeenCalled();
  });

  it("a checkout that cannot start fails calmly; Try again asks the background again and buys", async () => {
    const h = harness({ checkout: { kind: "unavailable" } });
    h.observe("none"); await settle();
    h.flow.buy(); await settle();
    expect(h.state.purchase).toBe("failed");
    expect(h.pending.write).not.toHaveBeenCalled();
    h.checkout.createCheckout.mockResolvedValueOnce({ kind: "checkout-url", url: "https://checkout.invalid/y" });
    h.flow.retry(); await settle();
    expect(h.available).toHaveBeenCalledTimes(2);
    expect(h.checkout.openCheckoutTab).toHaveBeenCalledWith("https://checkout.invalid/y");
  });

  it("an ended session the page still reads as signed in fails calmly, with no hidden sign-in", async () => {
    const h = harness({ checkout: { kind: "auth-required" } });
    h.observe("none"); await settle();
    h.flow.buy(); await settle();
    expect(h.controller.openSignIn).not.toHaveBeenCalled();
    expect(h.state.purchase).toBe("failed");
    expect(h.pending.write).not.toHaveBeenCalled();
  });

  it("Buy twice brings the open checkout tab forward instead of opening a second", async () => {
    const h = harness();
    h.observe("none"); await settle();
    h.flow.buy(); await settle();
    h.page.show("hidden"); h.page.show("visible"); await settle(); // back without paying
    expect(h.state.purchase).toBe("idle");
    h.flow.buy(); await settle();
    expect(h.tabs.focus).toHaveBeenLastCalledWith({ startedAt: 1_000_000, tabId: 7 });
    expect(h.checkout.createCheckout).toHaveBeenCalledOnce();
    expect(h.checkout.openCheckoutTab).toHaveBeenCalledOnce();
    expect(h.record.value).toEqual({ startedAt: 1_000_000, tabId: 7 });
    expect(h.state.purchase).toBe("waiting");
  });

  it("a closed checkout tab is replaced by a new one, recorded in its place", async () => {
    const h = harness();
    h.observe("none"); await settle();
    h.flow.buy(); await settle();
    h.open.delete(7); // the person closed it
    h.page.show("hidden"); h.advance(5); h.page.show("visible"); await settle();
    h.flow.buy(); await settle();
    expect(h.checkout.openCheckoutTab).toHaveBeenCalledTimes(2);
    expect(h.record.value).toEqual({ startedAt: 1_000_005, tabId: 7 });
  });

  it("a second settings page brings the first page's checkout tab forward", async () => {
    const record = { value: null as CheckoutPendingLike | null };
    const openTabs = new Set<number>();
    const first = harness({ record, openTabs });
    const second = harness({ record, openTabs });
    first.observe("none"); second.observe("none"); await settle();
    first.flow.buy(); await settle();
    second.flow.buy(); await settle();
    expect(second.checkout.createCheckout).not.toHaveBeenCalled();
    expect(second.tabs.focus).toHaveBeenCalledWith({ startedAt: 1_000_000, tabId: 7 });
    expect([...openTabs]).toEqual([7]);
    expect(record.value).toEqual({ startedAt: 1_000_000, tabId: 7 });
  });

  it("two pages buying at once keep one recorded tab and close the other", async () => {
    const record = { value: null as CheckoutPendingLike | null };
    const openTabs = new Set<number>();
    const first = harness({ record, openTabs });
    const second = harness({ record, openTabs });
    first.observe("none"); second.observe("none"); await settle();
    second.advance(1); // a different start
    first.flow.buy(); second.flow.buy(); await settle();
    // The later record wins; the tab opened under the replaced record is closed, not orphaned.
    expect(openTabs.size).toBe(1);
    expect(record.value?.tabId).toBe([...openTabs][0]);
    expect(first.tabs.close.mock.calls.length + second.tabs.close.mock.calls.length).toBe(1);
  });

  it("a sign-out while the tab opened closes that tab and records nothing", async () => {
    const h = harness();
    h.observe("none"); await settle();
    h.checkout.openCheckoutTab.mockImplementationOnce(async () => {
      h.record.value = null; // the background's sign-out purge ran meanwhile
      h.open.add(9);
      return 9;
    });
    h.flow.buy(); await settle();
    expect(h.tabs.close).toHaveBeenCalledWith(9);
    expect(h.record.value).toBeNull();
    expect(h.tabs.remember).not.toHaveBeenCalled();
    expect(h.state.purchase).toBe("idle");
  });

  it("a checkout tab that did not open is a failure, not an endless wait", async () => {
    const h = harness({ tab: undefined });
    h.observe("none"); await settle();
    h.flow.buy(); await settle();
    expect(h.state.purchase).toBe("failed");
    expect(h.record.value).toBeNull();
  });

  it("a tab that did not open leaves a record another page wrote meanwhile", async () => {
    const h = harness({ tab: undefined });
    h.observe("none"); await settle();
    h.checkout.openCheckoutTab.mockImplementationOnce(async () => {
      h.record.value = { startedAt: 42, tabId: 3 }; // another settings page's Buy
      return undefined;
    });
    h.flow.buy(); await settle();
    expect(h.state.purchase).toBe("failed");
    expect(h.record.value).toEqual({ startedAt: 42, tabId: 3 });
  });

  it("already owned on the server re-checks instead of opening a checkout", async () => {
    const h = harness({ checkout: { kind: "already-entitled" } });
    h.observe("none"); await settle();
    h.flow.buy(); await settle();
    expect(h.checkout.openCheckoutTab).not.toHaveBeenCalled();
    expect(h.controller.recheckAccess).toHaveBeenCalledOnce();
    expect(h.state.purchase).toBe("idle");
  });

  it("drops a checkout answer that arrives after the account changed", async () => {
    const h = harness();
    h.observe("none"); await settle();
    let finish!: (value: WebCheckoutOutcome) => void;
    h.checkout.createCheckout.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    h.flow.buy(); await settle();
    h.observe("none", OTHER);
    finish({ kind: "checkout-url", url: "https://checkout.invalid/old" }); await settle();
    expect(h.checkout.openCheckoutTab).not.toHaveBeenCalled();
    expect(h.state.purchase).toBe("idle");
  });

  it("Restore reports restored, nothing or failed from the access it reads", async () => {
    const h = harness();
    h.observe("none"); await settle();
    h.answer("purchased", "entitled");
    h.flow.restore(); await settle();
    expect(h.state.restore).toEqual({ state: "restored" });
    h.answer("locked", "not-entitled");
    h.flow.restore(); await settle();
    expect(h.state.restore).toEqual({ state: "nothing" });
    h.answer("verification_required", "entitled");
    h.flow.restore(); await settle();
    expect(h.state.restore?.state).toBe("failed");
  });

  it("signed out, Restore opens sign-in and checks once that sign-in lands", async () => {
    const h = harness();
    h.observe("verify", null); await settle();
    h.flow.restore(); await settle();
    expect(h.controller.openSignIn).toHaveBeenCalledOnce();
    expect(h.controller.recheckAccess).not.toHaveBeenCalled();
    h.observe("verify", ACCOUNT); await settle();
    expect(h.state.restore?.state).toBe("nothing");
  });

  it("closing the sign-in sheet drops a signed-out Restore; an account change clears a shown result", async () => {
    const h = harness();
    h.observe("verify", null); await settle();
    h.flow.restore();
    h.controller.signInOpen = true; h.observe("verify", null);
    h.controller.signInOpen = false; h.observe("verify", null); await settle();
    h.observe("verify", ACCOUNT); await settle();
    expect(h.state.restore).toBeUndefined(); // the dropped request did not run after sign-in
    h.flow.restore(); await settle();
    expect(h.state.restore).toEqual({ state: "nothing" });
    h.observe("verify", OTHER); await settle();
    expect(h.state.restore).toBeUndefined();
  });

  it("a failed Restore offers Try again, which checks again", async () => {
    const h = harness();
    h.observe("none"); await settle();
    h.answer("verification_required", "unknown");
    h.flow.restore(); await settle();
    expect(h.state.restore?.state).toBe("failed");
    h.answer("purchased", "entitled");
    h.state.restore?.onAction?.(); await settle();
    expect(h.state.restore).toEqual({ state: "restored" });
  });

  it("shares no module with the free-period Restore wrapper (that would change shipped V3 chunks)", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "browser-pro.ts"), "utf8");
    const imports = source.split("\n").filter(line => /^\s*(import|export)\b.*from\s+"/.test(line) || /^\s*}\s*from\s+"/.test(line));
    expect(imports.join("\n")).not.toMatch(/browser-settings-restore|settings-restore/);
  });

  it("stop removes the page listener and ignores later results", async () => {
    const h = harness();
    h.observe("none"); await settle();
    h.flow.stop();
    expect(h.page.listeners.size).toBe(0);
    const published = h.states.length;
    h.flow.buy(); h.flow.restore(); await settle();
    expect(h.states.length).toBe(published);
  });
});
