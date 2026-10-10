import { FEATURE_REGISTRY, type BenefitAccessSnapshot } from "@still/shared-types";
import type { AccessRecheck, UiCheckout, UiController } from "@still/core/ui";
import type { RestoreStatusCardProps } from "@still/core/ui/v3/extension-settings-presentation";

// The Chrome and Firefox settings page's Still Pro card in paid-tier builds (owner decisions,
// 10 October 2026): Buy without a price on this surface (the checkout page shows it), a working
// Restore, and an access re-check whenever the page is shown. Imported only by the lazily loaded
// InformationalProSettings wrapper, which only builds compiled with the paid tier on can load.
//
// Authority stays where it was: what the card shows as Still Pro comes from the committed access
// observation (`access.states`), never from a reconcile's own answer. Free blocking, free sync and
// the free controls never wait on anything here.
//
// Bundle note: this module takes no value from modules that only the free-period RestoreSettings
// wrapper uses (such as browser-settings-restore). Builds with the paid tier off still emit this
// card's chunk, unreferenced; sharing a module with RestoreSettings would split it into a new
// chunk and change the shipped V3 settings page. Restore therefore has its own small flow below,
// with the same rules and the same RestoreStatusCard states.

/** Equal to SESSION_MESSAGE_KIND and CHECKOUT_AVAILABLE_ACTION (pinned by test). Spelled here so
 * this page module takes no value from the background's message modules. */
export const BROWSER_PRO_SESSION_KIND = "still:session";
export const BROWSER_PRO_AVAILABLE_ACTION = "checkoutAvailable";

/**
 * A page shown again re-checks at most this often, and not at all while Still Pro shows as owned
 * (the page-open check and Restore still re-check an owner). Coming back from an open checkout
 * always re-checks: that return is when a purchase completes.
 */
export const VISIBLE_RECHECK_SPACING_MS = 30_000;
/**
 * While a visible page shows Buy, the short-lived "known none" evidence (about a minute) is
 * renewed shortly before it lapses, so the card does not fall back to "verify again" under a
 * person reading it. Bounded for the page's whole lifetime; after that, showing the page again
 * or Restore re-checks.
 */
export const KEEP_ALIVE_MS = 45_000;
export const KEEP_ALIVE_LIMIT = 10;

/** The card's reading of the access observation's twelve Still Pro rows. */
export type ProOwnership = "owned" | "verify" | "checking" | "none" | "hidden";

export function proOwnership(access: Pick<BenefitAccessSnapshot, "states">): ProOwnership {
  const states = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map((row) => access.states[row.id]);
  if (states.includes("purchased")) return "owned";
  // Protection that is not a purchase keeps the card out of the way, as before.
  if (states.includes("protected")) return "hidden";
  if (states.includes("verification_required")) return "verify";
  if (states.includes("checking")) return "checking";
  return states.includes("locked") ? "none" : "hidden";
}

export interface BrowserProRuntime {
  sendMessage(message: unknown): Promise<unknown>;
}

/** The same choice wxt's `browser` makes: Firefox's `browser`, else Chrome's `chrome`. */
export function extensionRuntime(): BrowserProRuntime {
  const scope = globalThis as unknown as {
    browser?: { runtime?: BrowserProRuntime & { id?: string } };
    chrome: { runtime: BrowserProRuntime };
  };
  return scope.browser?.runtime?.id ? scope.browser.runtime : scope.chrome.runtime;
}

/** Whether the background says Buy may be offered. Missing listener, torn worker or any reply
 * but `true` is "no". */
export async function askCheckoutAvailable(runtime: BrowserProRuntime = extensionRuntime()): Promise<boolean> {
  try {
    return (await runtime.sendMessage({ kind: BROWSER_PRO_SESSION_KIND, action: BROWSER_PRO_AVAILABLE_ACTION })) === true;
  } catch {
    return false;
  }
}

/** The background's checkout-pending record, as the session protocol carries it. */
export interface CheckoutPendingLike {
  readonly startedAt?: number;
  readonly tabId?: number;
}

/**
 * The background's checkout-pending record, read and written through the session protocol and
 * awaited (unlike the popup's fire-and-forget setter), so a write has landed before the next read.
 * Its tab is closed on sign-out or an account switch, and supported-site visits reconcile while it
 * exists. The background clears it on a confirmed purchase or a checkout that finished unpaid.
 */
export interface CheckoutPendingStore {
  read(): Promise<CheckoutPendingLike | null>;
  write(pending: CheckoutPendingLike | null): Promise<void>;
}

export function sessionPendingStore(runtime: BrowserProRuntime = extensionRuntime()): CheckoutPendingStore {
  return {
    async read() {
      try {
        const state = (await runtime.sendMessage({ kind: BROWSER_PRO_SESSION_KIND, action: "getState" })) as
          { checkoutPending?: unknown } | null | undefined;
        const pending = state?.checkoutPending;
        return pending && typeof pending === "object" ? (pending as CheckoutPendingLike) : null;
      } catch {
        return null;
      }
    },
    async write(pending) {
      try {
        await runtime.sendMessage({ kind: BROWSER_PRO_SESSION_KIND, action: "setCheckoutPending", pending });
      } catch {
        /* the record is best effort; a lost write only costs the tab close or a visit reconcile */
      }
    },
  };
}

/**
 * The checkout tabs this card opens. A record's tab is trusted only when this browser session
 * remembers opening it for that very record: tab ids restart after a browser restart, so a stale
 * record could otherwise name someone else's tab.
 */
export interface CheckoutTabs {
  /** Bring the record's checkout tab forward. False when it is gone or not one this card opened. */
  focus(record: { readonly startedAt: number; readonly tabId: number }): Promise<boolean>;
  remember(record: { readonly startedAt: number; readonly tabId: number }): Promise<void>;
  close(tabId: number): Promise<void>;
}

export const CHECKOUT_TAB_MARK_KEY = "still:pro-checkout-tab";

interface TabsApi {
  storage: { session: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  tabs: {
    get(tabId: number): Promise<{ windowId?: number }>;
    update(tabId: number, properties: { active: boolean }): Promise<unknown>;
    remove(tabId: number): Promise<void>;
  };
  windows?: { update(windowId: number, properties: { focused: boolean }): Promise<unknown> };
}

export function extensionCheckoutTabs(api?: TabsApi): CheckoutTabs {
  const resolve = (): TabsApi => {
    if (api) return api;
    const scope = globalThis as unknown as { browser?: TabsApi & { runtime?: { id?: string } }; chrome: TabsApi };
    return scope.browser?.runtime?.id ? scope.browser : scope.chrome;
  };
  return {
    async focus(record) {
      try {
        const tabs = resolve();
        const mark = (await tabs.storage.session.get(CHECKOUT_TAB_MARK_KEY))[CHECKOUT_TAB_MARK_KEY] as
          { startedAt?: unknown; tabId?: unknown } | undefined;
        if (mark?.tabId !== record.tabId || mark?.startedAt !== record.startedAt) return false;
        const tab = await tabs.tabs.get(record.tabId);
        await tabs.tabs.update(record.tabId, { active: true });
        // Firefox for Android has no windows API; bringing the tab forward is enough there.
        if (typeof tab.windowId === "number") await tabs.windows?.update(tab.windowId, { focused: true }).catch(() => {});
        return true;
      } catch {
        return false;
      }
    },
    async remember(record) {
      try {
        await resolve().storage.session.set({ [CHECKOUT_TAB_MARK_KEY]: { startedAt: record.startedAt, tabId: record.tabId } });
      } catch {
        /* without the mark a later Buy opens a fresh tab, as before */
      }
    },
    async close(tabId) {
      try {
        await resolve().tabs.remove(tabId);
      } catch {
        /* already closed */
      }
    },
  };
}

export type BrowserProController = Pick<
  UiController,
  "userId" | "signInOpen" | "canSignIn" | "openSignIn" | "recheckAccess"
>;

export interface BrowserProDeps {
  readonly controller: BrowserProController;
  /** The existing background-backed checkout seam (lib/purchase-wiring.ts). */
  readonly checkout: Pick<UiCheckout, "createCheckout" | "openCheckoutTab">;
  /** Defaults to the session protocol's getState / setCheckoutPending. */
  readonly pending?: CheckoutPendingStore;
  /** Defaults to the extension's tabs, windows and session storage. */
  readonly tabs?: CheckoutTabs;
  /** Defaults to askCheckoutAvailable over the extension runtime. */
  readonly available?: () => Promise<boolean>;
  readonly page?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  readonly now?: () => number;
}

export interface BrowserProState {
  /** Whether Buy may be offered for the current account; "unknown" until asked. */
  readonly channel: "unknown" | "checking" | "ready" | "unavailable";
  readonly purchase: "idle" | "opening" | "waiting" | "failed";
  readonly restore: RestoreStatusCardProps | undefined;
}

export interface BrowserProObservation {
  readonly userId: string | null;
  readonly signInOpen: boolean;
  readonly ownership: ProOwnership;
}

export const INITIAL_BROWSER_PRO_STATE: BrowserProState = Object.freeze({
  channel: "unknown",
  purchase: "idle",
  restore: undefined,
});

/**
 * The card's host flow. Re-checks (the scoped reconcile plus a fresh access read, shared with the
 * page-open check) run when an account signs in here, when the page is shown again, on Restore,
 * after a checkout that the server says is already owned, and to renew a visible "known none".
 * Buy asks the background's existing createCheckout, which opens the hosted checkout; the
 * purchase completes on the next re-check (normally when this page is shown again). A result that
 * arrives after the account changed, or after `stop`, is dropped.
 */
export function createBrowserPro(deps: BrowserProDeps, publish: (state: BrowserProState) => void) {
  const now = deps.now ?? (() => Date.now());
  const available = deps.available ?? (() => askCheckoutAvailable());
  const page = deps.page ?? document;
  const pendingStore = deps.pending ?? sessionPendingStore();
  const tabs = deps.tabs ?? extensionCheckoutTabs();
  let state: BrowserProState = INITIAL_BROWSER_PRO_STATE;
  let seen: BrowserProObservation | null = null;
  let generation = 0;
  let stopped = false;
  let channelFlight = false;
  let lastRecheckAt = -Infinity;
  let keepAlive: ReturnType<typeof setTimeout> | null = null;
  let keepAliveCount = 0;

  function set(next: Partial<BrowserProState>): void {
    if (stopped) return;
    state = { ...state, ...next };
    publish(state);
  }
  const visible = () => page.visibilityState === "visible";
  const current = (): BrowserProState => state;

  function clearKeepAlive(): void {
    if (keepAlive !== null) clearTimeout(keepAlive);
    keepAlive = null;
  }
  function armKeepAlive(): void {
    if (stopped || keepAlive !== null || keepAliveCount >= KEEP_ALIVE_LIMIT || !visible() || seen?.userId == null) return;
    const ticket = generation;
    keepAlive = setTimeout(() => {
      keepAlive = null;
      if (stopped || ticket !== generation || !visible() || seen?.ownership !== "none") return;
      keepAliveCount += 1;
      void recheck();
    }, KEEP_ALIVE_MS);
  }

  /** `quiet` re-asks behind the current answer (no "checking" flash): a page shown again learns
   * that sales were switched off, or on, without the card blinking. */
  async function askChannel(quiet = false): Promise<void> {
    if (stopped || channelFlight || seen?.userId == null) return;
    channelFlight = true;
    const ticket = generation;
    if (!quiet || state.channel === "unknown") set({ channel: "checking" });
    let allowed: boolean;
    try {
      allowed = (await available()) === true;
    } catch {
      allowed = false;
    }
    if (ticket !== generation) return;
    channelFlight = false;
    set({ channel: allowed ? "ready" : "unavailable" });
  }

  async function recheck(refreshChannel = false): Promise<AccessRecheck | null> {
    const run = deps.controller.recheckAccess;
    if (stopped || !run || seen?.userId == null) return null;
    lastRecheckAt = now();
    const ticket = generation;
    const returning = state.purchase === "waiting";
    let result: AccessRecheck;
    try {
      result = await run();
    } catch {
      return null;
    }
    if (stopped || ticket !== generation) return null;
    // Back from the checkout tab: the purchase either shows through the access observation or
    // Buy is offered again (a second create resumes the same server-held checkout).
    if (returning && state.purchase === "waiting") set({ purchase: "idle" });
    if (proOwnership(result.access) === "none") {
      if (state.channel === "unknown" || refreshChannel) void askChannel(true);
      armKeepAlive();
    }
    return result;
  }

  // Restore is the scoped re-check. "Restored" and "nothing" are read from the fresh access
  // observation, so the restore card never claims what the authority does not show. Signed out,
  // the normal sign-in comes first and the check runs once it lands; closing the sheet drops the
  // request. One check at a time; an account change forgets a running or shown result.
  let restoreFlight = false;
  let restoreAwaitingSignIn = false;
  let restoreFor: string | null = null;
  async function runRestore(userId: string): Promise<void> {
    restoreFlight = true;
    restoreFor = userId;
    const ticket = generation;
    set({ restore: { state: "checking" } });
    const result = await recheck();
    if (stopped || ticket !== generation) return;
    restoreFlight = false;
    const ownership = result ? proOwnership(result.access) : null;
    if (ownership === "owned") set({ restore: { state: "restored" } });
    else if (result?.outcome === "not-entitled" && ownership === "none") set({ restore: { state: "nothing" } });
    else set({ restore: { state: "failed", onAction: () => requestRestore() } });
  }
  function requestRestore(): void {
    if (stopped || restoreFlight || restoreAwaitingSignIn) return;
    const userId = seen?.userId ?? null;
    if (userId !== null) {
      void runRestore(userId);
      return;
    }
    restoreAwaitingSignIn = true;
    deps.controller.openSignIn();
  }
  function observeRestore(previous: BrowserProObservation | null, next: BrowserProObservation): void {
    if (previous && previous.userId !== next.userId && restoreFor !== null && next.userId !== restoreFor) {
      restoreFlight = false;
      restoreFor = null;
      set({ restore: undefined });
    }
    if (!restoreAwaitingSignIn) return;
    if (next.userId !== null) {
      restoreAwaitingSignIn = false;
      void runRestore(next.userId);
    } else if (!next.signInOpen && previous?.signInOpen) restoreAwaitingSignIn = false;
  }

  async function buy(): Promise<void> {
    if (stopped || state.channel !== "ready" || state.purchase === "opening" || state.purchase === "waiting") return;
    if (seen?.userId == null || seen.ownership !== "none") return;
    const ticket = generation;
    const live = () => !stopped && ticket === generation;
    set({ purchase: "opening" });
    // A checkout tab from an earlier Buy (here or on another settings page) is brought forward
    // rather than joined by a second one, which a later sign-out would not know to close.
    const existing = await pendingStore.read();
    if (!live()) return;
    if (typeof existing?.startedAt === "number" && typeof existing.tabId === "number" &&
        await tabs.focus({ startedAt: existing.startedAt, tabId: existing.tabId })) {
      if (live()) set({ purchase: "waiting" });
      return;
    }
    if (!live()) return;
    let outcome: Awaited<ReturnType<UiCheckout["createCheckout"]>>;
    try {
      outcome = await deps.checkout.createCheckout();
    } catch {
      outcome = { kind: "unavailable" };
    }
    if (!live()) return;
    if (outcome.kind === "checkout-url") {
      set({ purchase: "waiting" });
      // Recorded BEFORE the tab opens, then with its id: sign-out or another account signing in
      // closes that tab (it carries this account), and supported-site visits reconcile while it
      // exists, so a purchase unlocks even if this page is never shown again.
      const startedAt = now();
      await pendingStore.write({ startedAt });
      const tab = await deps.checkout.openCheckoutTab(outcome.url);
      const latest = await pendingStore.read();
      const ours = latest?.startedAt === startedAt;
      if (tab === undefined) {
        // No tab opened: say so rather than wait for a return that cannot come, and end only the
        // record this Buy wrote. (set() replaced `state` meanwhile, so read it afresh.)
        if (ours) await pendingStore.write(null);
        if (live() && current().purchase === "waiting") set({ purchase: "failed" });
        return;
      }
      if (!ours || !live()) {
        // While the tab opened, a sign-out or account switch purged the record, or another
        // settings page replaced it: this tab must not outlive its account or go unrecorded.
        await tabs.close(tab);
        if (live() && current().purchase === "waiting") set({ purchase: "idle" });
        return;
      }
      await pendingStore.write({ startedAt, tabId: tab });
      await tabs.remember({ startedAt, tabId: tab });
      return;
    }
    if (outcome.kind === "already-entitled") {
      // The background already reconciled before answering; read the access it recorded.
      set({ purchase: "idle" });
      void recheck();
      return;
    }
    // Unavailable, or an ended session (auth-required) the page still reads as signed in: the
    // calm failure, whose Try again asks the background again. Opening sign-in here would show
    // nothing until the page noticed the sign-out, then pop up unasked. (A sign-out the page has
    // noticed changes the account, which already dropped this answer above; the signed-out card
    // offers sign-in itself.)
    set({ purchase: "failed" });
  }

  function onVisibility(): void {
    if (stopped) return;
    if (!visible()) {
      clearKeepAlive();
      return;
    }
    if (state.purchase === "waiting") void recheck(true);
    else if (seen?.ownership === "owned") return;
    else if (now() - lastRecheckAt >= VISIBLE_RECHECK_SPACING_MS) void recheck(true);
    else if (seen?.ownership === "none") armKeepAlive();
  }
  page.addEventListener("visibilitychange", onVisibility);

  return {
    /** Feed every account and access change; the card calls this from its reactive effect. */
    observe(next: BrowserProObservation): void {
      if (stopped) return;
      const previous = seen;
      seen = next;
      const switched = previous !== null && previous.userId !== next.userId;
      if (switched) {
        // Before anything runs for the new account, so its own checks are not fenced off.
        generation += 1;
        channelFlight = false;
        clearKeepAlive();
        set({ channel: "unknown", purchase: "idle" });
      }
      // A Restore waiting on this sign-in runs its re-check now (shared with the one below).
      observeRestore(previous, next);
      // Signed in on this page: the background's sign-in check may have recorded "none" without
      // changing storage, so read it now rather than waiting for the refresh timer.
      if (switched && next.userId !== null) void recheck();
      if (next.ownership === "owned" && state.purchase !== "idle") set({ purchase: "idle" });
      if (next.ownership === "none" && next.userId !== null) {
        if (state.channel === "unknown") void askChannel();
        armKeepAlive();
      } else clearKeepAlive();
    },
    buy(): void {
      void buy();
    },
    /** The failed state's "Try again": ask the background again, then Buy if it still may. */
    retry(): void {
      if (stopped || state.purchase !== "failed") return;
      set({ purchase: "idle", channel: "unknown" });
      void askChannel().then(() => {
        if (state.channel === "ready") void buy();
      });
    },
    restore(): void {
      requestRestore();
    },
    get state(): BrowserProState {
      return state;
    },
    stop(): void {
      stopped = true;
      clearKeepAlive();
      page.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
