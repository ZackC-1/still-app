// The purchase machinery, exercised with the paid tier switched ON.
//
// These suites cover the paywall, the success payoff, and the hosted web checkout: state machines
// that only exist when there is something to buy. The shipped build has PAID_TIER_ENABLED false, so
// the controller refuses to open the paywall at all and this behaviour is unreachable there. Rather
// than let a few hundred lines of coverage go dark until the paid tier returns, this file replaces
// that one shared export before the controller is imported, so the machinery keeps being tested on
// every run. If any of it breaks, we find out now instead of on the day the switch flips back.
import { describe, it, expect, vi } from "vitest";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import {
  PAYOFF_DURATION_MS,
  CHECKOUT_POLL_INTERVAL_MS,
  CHECKOUT_POLL_MAX,
  CHECKOUT_PENDING_TTL_MS,
  type CheckoutReconcileOutcome,
} from "../controller.svelte.js";
import type { WebCheckoutOutcome } from "../../sync/ports.js";
import {
  makeController,
  codeAuth,
  mockPersistence,
  checkoutSeam,
  CHECKOUT_URL,
} from "./support/controller-fixtures.js";

describe("UiController — paywall and purchase state", () => {
  it("opening / dismissing the paywall resets the purchase flow", () => {
    const { c } = makeController();
    c.setPurchaseOutcome({ outcome: "failed", entitled: false, error: "x" });
    c.openPaywall();
    expect(c.purchaseFlow).toBe("idle");
    expect(c.purchaseError).toBeNull();
    c.setPurchaseOutcome({ outcome: "cancelled", entitled: false });
    c.dismissPaywall();
    expect(c.purchaseFlow).toBe("idle");
  });

  it("createAccountFromSuccess hands the success screen off to the sign-in sheet", () => {
    const { c } = makeController({ auth: codeAuth() });
    c.receiptEntitled = true; // the account-pitch state: receipt Pro, no session
    c.showPurchaseSuccess();
    expect(c.successScreen).toBe("account-pitch");
    c.createAccountFromSuccess();
    expect(c.successScreen).toBe("none");
    expect(c.paywallOpen).toBe(false);
    expect(c.signInOpen).toBe(true);
    expect(c.purchaseIntent).toBe(false); // they already own Pro — no purchase continuation
  });

  it("a rise resolving a PENDING purchase routes to the success screen, never the payoff", () => {
    const { c } = makeController({ auth: codeAuth() });
    c.userId = "u1";
    c.openPaywall();
    c.setPurchaseOutcome({ outcome: "pending", entitled: false });
    c.entitled = true; // the approval lands via the server lane first (race pin)
    expect(c.successScreen).toBe("synced");
    expect(c.justUnlocked).toBe(false);
    expect(c.paywallOpen).toBe(true);
  });
});

// ── success payoff (plan U3/R6): one transition rule drives every host ──────────────────────────

describe("UiController — success payoff (plan U3/R6)", () => {
  it("entitled false→true with the paywall open shows the payoff inside the still-open sheet", () => {
    // AMENDED (purchase-first): the payoff remains the NON-purchase transition (e.g. a web-bought
    // account's entitlement landing while the paywall is open). A rise that resolves a PENDING
    // purchase routes to the success screen instead — pinned separately below.
    const { c } = makeController();
    c.userId = "u";
    c.openPaywall();
    c.entitled = true; // the entitlement store write landed (storage subscription / sync state)
    expect(c.justUnlocked).toBe(true);
    expect(c.paywallOpen).toBe(true); // payoff renders in place; controller dismisses later
    expect(c.purchaseFlow).toBe("idle"); // the payoff supersedes any outcome copy
    c.dismissPaywall(); // clear the payoff timer
  });

  it("entitled false→true with the paywall closed unlocks quietly — no payoff", () => {
    const { c } = makeController();
    c.entitled = true;
    expect(c.justUnlocked).toBe(false);
    expect(c.paywallOpen).toBe(false); // a quiet background unlock never pops a sheet
  });

  it("ordering pin: the payoff never renders while entitled is false", () => {
    const { c } = makeController();
    c.openPaywall();
    expect(c.justUnlocked).toBe(false); // nothing before the entitlement write lands
    c.entitled = true;
    expect(c.justUnlocked).toBe(true);
    c.entitled = false; // revocation / teardown mid-payoff
    expect(c.justUnlocked).toBe(false); // cleared immediately — never against a false entitlement
    c.dismissPaywall();
  });

  it("auto-dismisses the paywall after ~2.5s", () => {
    vi.useFakeTimers();
    try {
      const { c } = makeController();
      c.openPaywall();
      c.entitled = true;
      vi.advanceTimersByTime(PAYOFF_DURATION_MS - 1);
      expect(c.justUnlocked).toBe(true); // still celebrating
      expect(c.paywallOpen).toBe(true);
      vi.advanceTimersByTime(1);
      expect(c.justUnlocked).toBe(false);
      expect(c.paywallOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismisses early on tap/Escape, and the cleared timer never fires into a later paywall", () => {
    vi.useFakeTimers();
    try {
      const { c } = makeController();
      c.openPaywall();
      c.entitled = true;
      c.dismissPaywall(); // the sheet routes tap-on-payoff and Escape here
      expect(c.justUnlocked).toBe(false);
      expect(c.paywallOpen).toBe(false);
      c.openPaywall(); // a later, unrelated paywall session
      vi.advanceTimersByTime(PAYOFF_DURATION_MS * 2);
      expect(c.paywallOpen).toBe(true); // the stale auto-dismiss was cancelled with the payoff
    } finally {
      vi.useRealTimers();
    }
  });

  it("a repeated entitled=true (no false→true edge) never re-triggers the payoff", () => {
    const { c } = makeController();
    c.openPaywall();
    c.entitled = true;
    c.dismissPaywall();
    c.openPaywall();
    c.entitled = true; // same value again (e.g. another sync-state projection)
    expect(c.justUnlocked).toBe(false);
    c.dismissPaywall();
  });

  it("locked rows become live toggles the moment the transition lands, previously-on services on", () => {
    const { c } = makeController();
    c.openPaywall();
    expect(c.isLocked("instagram")).toBe(true);
    c.entitled = true;
    expect(c.isLocked("instagram")).toBe(false);
    expect(c.isLocked("tiktok")).toBe(false);
    expect(c.isLocked("facebook")).toBe(false);
    // Entitlement never mutated the settings themselves — the default-on services light up as-is.
    expect(c.settings.services.instagram).toBe(true);
    expect(c.settings.services.tiktok).toBe(true);
    expect(c.settings.services.facebook).toBe(true);
    c.dismissPaywall();
  });

  it("sign-out mid-payoff clears it with the rest of the session state", async () => {
    const { c } = makeController({ auth: codeAuth() });
    c.userId = "u";
    c.openPaywall();
    c.entitled = true;
    expect(c.justUnlocked).toBe(true);
    await c.signOut();
    expect(c.justUnlocked).toBe(false);
    expect(c.paywallOpen).toBe(false);
  });
});

// ── web checkout flow (plan U4/R3/R5) ─────────────────────────────────────────────────────────────

describe("UiController — web checkout flow (plan U4/R3/R5)", () => {
  it("canWebCheckout requires both a purchasable host and the injected seam (Safari stays free of it)", () => {
    expect(makeController().c.canWebCheckout).toBe(false); // no seam (default shared wiring)
    const { seam } = checkoutSeam();
    expect(makeController({ checkout: seam }).c.canWebCheckout).toBe(true);
    // A host without a purchase path never web-checkouts even if a seam were wired (R10 pin).
    expect(
      makeController({ checkout: seam, host: { canPurchase: false } }).c
        .canWebCheckout,
    ).toBe(false);
  });

  it("checkout-url: pending is persisted BEFORE the tab opens; the flow shows opening-checkout (R3)", async () => {
    const t = 500_000;
    const { seam, order } = checkoutSeam();
    const { c } = makeController({ checkout: seam, clock: () => t });
    c.userId = "u";
    c.openPaywall();
    const inFlight = c.startWebCheckout();
    expect(c.purchaseFlow).toBe("opening-checkout"); // the hand-off copy, not Apple's "purchasing"
    await inFlight;
    // The ordering pin: a flag persisted after tabs.create would die with the popup.
    expect(order.slice(0, 2)).toEqual([
      "persist-pending",
      `open:${CHECKOUT_URL}`,
    ]);
    expect(seam.setPending).toHaveBeenNthCalledWith(1, { startedAt: t });
    // Best-effort tabId enrichment once the opener resolves (popups usually die before this).
    expect(seam.setPending).toHaveBeenLastCalledWith({
      startedAt: t,
      tabId: 42,
    });
    // A surviving context (options page) rests in quiet-pending — poll windows start on reopen.
    expect(c.purchaseFlow).toBe("idle");
    expect(c.checkoutFlow).toBe("quiet-pending");
  });

  it("409 already-entitled → reconcile invoked → payoff after the entitled write; never an error (R5/AE4)", async () => {
    const reconcile = vi.fn(() =>
      Promise.resolve<CheckoutReconcileOutcome>("entitled"),
    );
    const { seam } = checkoutSeam({
      createCheckout: vi.fn(() =>
        Promise.resolve<WebCheckoutOutcome>({ kind: "already-entitled" }),
      ),
      reconcile,
    });
    const { c } = makeController({ checkout: seam });
    c.userId = "u";
    c.openPaywall();
    await c.startWebCheckout();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(c.purchaseFlow).not.toBe("failed"); // R5: the restore case is never an error state
    expect(c.purchaseError).toBeNull();
    // The reconcile's cache write lands → the entitlement subscription flips the controller:
    c.entitled = true;
    expect(c.justUnlocked).toBe(true); // payoff fires only after the write landed (R6 ordering)
    expect(c.purchaseFlow).toBe("idle");
    c.dismissPaywall();
  });

  it("unavailable → calm failure copy with the CTA re-enabled; nothing persisted (R3)", async () => {
    const { seam } = checkoutSeam({
      createCheckout: vi.fn(() =>
        Promise.resolve<WebCheckoutOutcome>({ kind: "unavailable" }),
      ),
    });
    const { c } = makeController({ checkout: seam });
    c.userId = "u";
    c.openPaywall();
    await c.startWebCheckout();
    expect(c.purchaseFlow).toBe("unavailable"); // STRINGS.paywall.unavailable renders in the sheet
    expect(c.purchaseBusy).toBe(false); // re-enabled — the user can retry
    expect(seam.setPending).not.toHaveBeenCalled(); // no tab, no phantom pending flag
    expect(c.checkoutFlow).toBe("none");
  });

  it("pending rehydration → checking → poll capped at 10 → quiet-pending; reopening starts a fresh window", async () => {
    vi.useFakeTimers();
    try {
      const t = 1_000_000;
      const reconcile = vi.fn(() =>
        Promise.resolve<CheckoutReconcileOutcome>("unknown"),
      );
      const { seam } = checkoutSeam({ reconcile });
      const { c } = makeController({ checkout: seam, clock: () => t });
      c.rehydrateCheckoutPending({ startedAt: t - 60_000 });
      expect(c.checkoutFlow).toBe("checking");
      expect(c.paywallOpen).toBe(true); // the pending presentation is a paywall surface (U3 rule)
      expect(reconcile).toHaveBeenCalledTimes(1); // the window checks immediately on rehydration
      await vi.advanceTimersByTimeAsync(
        CHECKOUT_POLL_INTERVAL_MS * (CHECKOUT_POLL_MAX - 1),
      );
      expect(reconcile).toHaveBeenCalledTimes(CHECKOUT_POLL_MAX);
      expect(c.checkoutFlow).toBe("quiet-pending"); // window exhausted → the calm resting copy
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS * 5);
      expect(reconcile).toHaveBeenCalledTimes(CHECKOUT_POLL_MAX); // capped — every poll costs an RC query
      // Reopening the popup rehydrates again → a fresh window (the reopen IS the retry gesture).
      c.rehydrateCheckoutPending({ startedAt: t - 60_000 });
      expect(c.checkoutFlow).toBe("checking");
      expect(reconcile).toHaveBeenCalledTimes(CHECKOUT_POLL_MAX + 1);
      c.abandonCheckout(); // stop the fresh window's timer before leaving fake timers
    } finally {
      vi.useRealTimers();
    }
  });

  it("pending older than 24h rehydrates as find-my-purchase — no polling, no infinite checking", () => {
    const t = 10_000_000_000;
    const { seam } = checkoutSeam();
    const { c } = makeController({ checkout: seam, clock: () => t });
    c.rehydrateCheckoutPending({ startedAt: t - CHECKOUT_PENDING_TTL_MS - 1 });
    expect(c.checkoutFlow).toBe("stale-pending");
    expect(c.paywallOpen).toBe(true);
    expect(seam.reconcile).not.toHaveBeenCalled();
  });

  it("garbage or missing startedAt reads as expired-pending — never NaN-comparison limbo", () => {
    const { seam } = checkoutSeam();
    for (const startedAt of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      "yesterday",
    ]) {
      const { c } = makeController({ checkout: seam, clock: () => 5_000 });
      c.rehydrateCheckoutPending({
        startedAt: startedAt as number | undefined,
      });
      expect(c.checkoutFlow, String(startedAt)).toBe("stale-pending");
      expect(seam.reconcile).not.toHaveBeenCalled();
    }
  });

  it("already entitled on rehydration (the background nudge won, AE3) → the moot flag is cleared quietly", () => {
    const { seam } = checkoutSeam();
    const { c } = makeController({ checkout: seam });
    c.entitled = true;
    c.rehydrateCheckoutPending({ startedAt: 1 });
    expect(seam.setPending).toHaveBeenLastCalledWith(null);
    expect(c.checkoutFlow).toBe("none");
    expect(c.paywallOpen).toBe(false); // quiet — no sheet pops for an already-done purchase
  });

  it("reconcile flipping entitled during polling → pending cleared, polling stopped, payoff exactly once", async () => {
    vi.useFakeTimers();
    try {
      const t = 1_000_000;
      const reconcile = vi.fn(() =>
        Promise.resolve<CheckoutReconcileOutcome>("unknown"),
      );
      const { seam } = checkoutSeam({ reconcile });
      const { c } = makeController({ checkout: seam, clock: () => t });
      c.rehydrateCheckoutPending({ startedAt: t - 5_000 });
      expect(c.checkoutFlow).toBe("checking");
      // The background reconcile wrote the cache; the entitlement subscription flips the controller:
      c.entitled = true;
      expect(c.justUnlocked).toBe(true); // the checking state counts as payoff-eligible (U3/U4)
      expect(c.paywallOpen).toBe(true);
      expect(seam.setPending).toHaveBeenLastCalledWith(null); // pending flag cleared on the flip
      expect(c.checkoutFlow).toBe("none");
      const polls = reconcile.mock.calls.length;
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS * 3);
      expect(reconcile.mock.calls.length).toBe(polls); // the poll window died with the pending flag
      // Exactly once: after the payoff runs its course, repeated entitled=true never re-fires it.
      vi.advanceTimersByTime(PAYOFF_DURATION_MS);
      expect(c.justUnlocked).toBe(false);
      c.entitled = true;
      expect(c.justUnlocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start-over clears pending immediately; a new checkout while pending REPLACES the flag (no 24h trap)", async () => {
    vi.useFakeTimers();
    try {
      const t = 2_000_000;
      const { seam } = checkoutSeam();
      const { c } = makeController({ checkout: seam, clock: () => t });
      c.rehydrateCheckoutPending({ startedAt: t - 10_000 });
      expect(c.checkoutFlow).toBe("checking");
      c.abandonCheckout(); // "I didn't finish checkout — start over"
      expect(seam.setPending).toHaveBeenLastCalledWith(null);
      expect(c.checkoutFlow).toBe("none");
      expect(c.purchaseFlow).toBe("idle"); // CTA usable right away
      // Re-invoking checkout while an (older) pending flag exists replaces it with a fresh stamp —
      // the server 409 stays the double-entitlement guard.
      c.rehydrateCheckoutPending({ startedAt: t - 10_000 });
      await c.startWebCheckout();
      expect(seam.setPending).toHaveBeenLastCalledWith({
        startedAt: t,
        tabId: 42,
      });
      expect(c.checkoutFlow).toBe("quiet-pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("auth-required from createCheckout → re-sign-in affordance; pending and cache untouched", async () => {
    const persistence = mockPersistence();
    const { seam } = checkoutSeam({
      createCheckout: vi.fn(() =>
        Promise.resolve<WebCheckoutOutcome>({ kind: "auth-required" }),
      ),
    });
    const { c } = makeController({
      checkout: seam,
      auth: codeAuth(),
      persistence,
    });
    c.userId = "u";
    c.openPaywall();
    await c.startWebCheckout();
    expect(c.checkoutFlow).toBe("auth-required");
    expect(c.purchaseBusy).toBe(false);
    expect(seam.setPending).not.toHaveBeenCalled(); // nothing cleared, nothing written
    expect(c.entitled).toBe(false); // never a downgrade write from an involuntary session death
    // The affordance: re-sign-in continues the flow instead of dead-ending.
    c.reSignInFromCheckout();
    expect(c.userId).toBeNull(); // the dead session is mirrored locally — WITHOUT teardown
    expect(c.signInOpen).toBe(true);
    expect(c.purchaseIntent).toBe(true); // sign-in success reopens the paywall (U2 continuation)
    c.dismissSignIn();
  });

  it("auth-required during polling → re-sign-in preserves pending; verify resumes the window", async () => {
    vi.useFakeTimers();
    try {
      const t = 3_000_000;
      const persistence = mockPersistence();
      const reconcile = vi
        .fn<() => Promise<CheckoutReconcileOutcome>>()
        .mockResolvedValueOnce("auth-required")
        .mockResolvedValue("unknown");
      const { seam } = checkoutSeam({ reconcile });
      const { c } = makeController({
        checkout: seam,
        auth: codeAuth(),
        persistence,
        clock: () => t,
      });
      c.userId = "u";
      c.rehydrateCheckoutPending({ startedAt: t - 5_000 });
      await vi.advanceTimersByTimeAsync(0); // flush the first poll's outcome
      expect(c.checkoutFlow).toBe("auth-required");
      expect(seam.setPending).not.toHaveBeenCalledWith(null); // pending preserved (KTD)
      expect(c.entitled).toBe(false); // cache untouched — rides out its TTL
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS * 3);
      expect(reconcile).toHaveBeenCalledTimes(1); // polls stopped — they'd only re-hit the 401
      // Re-sign-in → the pending presentation resumes with a fresh poll window.
      c.reSignInFromCheckout();
      await c.signIn("a@b.com");
      await c.verifyCode("123456");
      expect(c.userId).toBe("user-1");
      expect(c.paywallOpen).toBe(true);
      expect(c.checkoutFlow).toBe("checking");
      expect(reconcile).toHaveBeenCalledTimes(2);
      c.abandonCheckout(); // stop the window before leaving fake timers
    } finally {
      vi.useRealTimers();
    }
  });

  it("signed-out purchase tap still routes sign-in → paywall with the checkout seam present (AE1)", async () => {
    const persistence = mockPersistence();
    const { seam } = checkoutSeam();
    const { c } = makeController({
      checkout: seam,
      auth: codeAuth(),
      persistence,
    });
    c.lockedTap(); // signed out on a purchasable host → sign-in first, intent recorded
    expect(c.signInOpen).toBe(true);
    expect(c.paywallOpen).toBe(false);
    await c.signIn("a@b.com");
    await c.verifyCode("123456");
    expect(c.paywallOpen).toBe(true); // continues to the paywall — no dead-end at the popup root
    expect(c.purchaseFlow).toBe("idle"); // one confirming tap before money moves
    expect(seam.createCheckout).not.toHaveBeenCalled(); // never auto-invokes checkout
    expect(c.checkoutFlow).toBe("none"); // no pending → no phantom checking state
    c.dismissPaywall();
  });

  it("voluntary sign-out ends the checkout-pending lifecycle (unlike auth-required)", async () => {
    vi.useFakeTimers();
    try {
      const t = 4_000_000;
      const { seam } = checkoutSeam();
      const { c } = makeController({
        checkout: seam,
        auth: codeAuth(),
        clock: () => t,
      });
      c.userId = "u";
      c.rehydrateCheckoutPending({ startedAt: t - 1_000 });
      expect(c.checkoutFlow).toBe("checking");
      await c.signOut();
      expect(seam.setPending).toHaveBeenLastCalledWith(null); // R8 teardown clears the flag
      expect(c.checkoutFlow).toBe("none");
    } finally {
      vi.useRealTimers();
    }
  });
});
