import { FEATURE_REGISTRY, type BenefitAccessSnapshot } from "@still/shared-types";
import type { AccessRecheck, UiCheckout, UiController } from "@still/core/ui";
import type { RestoreStatusCardProps } from "@still/core/ui/v3/extension-settings-presentation";
import {
  createBrowserSettingsRestore,
  type BrowserRestoreAnswer,
} from "@still/core/ui/v3/browser-settings-restore";

// The Chrome and Firefox settings page's Still Pro card in paid-tier builds (owner decisions,
// 10 October 2026): Buy without a price on this surface (the checkout page shows it), a working
// Restore, and an access re-check whenever the page is shown. Imported only by the lazily loaded
// InformationalProSettings wrapper, which only builds compiled with the paid tier on can load.
//
// Authority stays where it was: what the card shows as Still Pro comes from the committed access
// observation (`access.states`), never from a reconcile's own answer. Free blocking, free sync and
// the free controls never wait on anything here.

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

export type BrowserProController = Pick<
  UiController,
  "userId" | "signInOpen" | "canSignIn" | "openSignIn" | "recheckAccess"
>;

export interface BrowserProDeps {
  readonly controller: BrowserProController;
  /**
   * The existing background-backed checkout seam (lib/purchase-wiring.ts). `setPending` writes the
   * background's checkout-pending record: its tab is closed on sign-out or an account switch, and
   * the supported-site nudge reconciles while it exists. The background clears it on a confirmed
   * purchase or a finished checkout.
   */
  readonly checkout: Pick<UiCheckout, "createCheckout" | "openCheckoutTab" | "setPending">;
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
  // observation, so the shared restore card never claims what the authority does not show.
  const restoreFlow = createBrowserSettingsRestore({
    check: async (): Promise<BrowserRestoreAnswer> => {
      const result = await recheck();
      if (!result) return "unknown";
      const ownership = proOwnership(result.access);
      if (ownership === "owned") return "entitled";
      if (result.outcome === "not-entitled" && ownership === "none") return "not-entitled";
      return result.outcome === "auth-required" ? "auth-required" : "unknown";
    },
    openSignIn: () => deps.controller.openSignIn(),
    publish: (restore) => set({ restore }),
  });

  async function buy(): Promise<void> {
    if (stopped || state.channel !== "ready" || state.purchase === "opening" || state.purchase === "waiting") return;
    if (seen?.userId == null || seen.ownership !== "none") return;
    const ticket = generation;
    set({ purchase: "opening" });
    let outcome: Awaited<ReturnType<UiCheckout["createCheckout"]>>;
    try {
      outcome = await deps.checkout.createCheckout();
    } catch {
      outcome = { kind: "unavailable" };
    }
    if (stopped || ticket !== generation) return;
    if (outcome.kind === "checkout-url") {
      set({ purchase: "waiting" });
      // Recorded BEFORE the tab opens, then with its id: sign-out or another account signing in
      // closes that tab (it carries this account), and supported-site visits reconcile while it
      // exists, so a purchase unlocks even if this page is never shown again.
      const pending = { startedAt: now() };
      deps.checkout.setPending(pending);
      const tab = await deps.checkout.openCheckoutTab(outcome.url);
      if (ticket !== generation) return;
      if (tab === undefined) {
        // No tab opened: say so rather than wait for a return that cannot come. (set() replaced
        // `state` meanwhile, so read it afresh.)
        deps.checkout.setPending(null);
        if (current().purchase === "waiting") set({ purchase: "failed" });
        return;
      }
      deps.checkout.setPending({ ...pending, tabId: tab });
      return;
    }
    if (outcome.kind === "already-entitled") {
      // The background already reconciled before answering; read the access it recorded.
      set({ purchase: "idle" });
      void recheck();
      return;
    }
    if (outcome.kind === "auth-required") {
      // The session ended: the normal sign-in, which the page shows once the account reads as
      // signed out. Signing in again re-checks and offers Buy afresh.
      set({ purchase: "idle" });
      deps.controller.openSignIn();
      return;
    }
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
      restoreFlow.observe({ userId: next.userId, signInOpen: next.signInOpen });
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
      restoreFlow.request();
    },
    get state(): BrowserProState {
      return state;
    },
    stop(): void {
      stopped = true;
      clearKeepAlive();
      restoreFlow.stop();
      page.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
