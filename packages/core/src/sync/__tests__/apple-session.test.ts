import { describe, expect, it, vi } from "vitest";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { PAYOFF_DURATION_MS, UiController } from "../../ui/controller.svelte.js";
import { createAppleSession, type AppleSessionBridge, type AppleSessionDeps } from "../apple-session.js";
import type { SyncState } from "../service.js";

// The money-flow branches that used to live untested in the app-webview entrypoint: double-charge
// guard, offline guard, pending-vs-payoff after purchase/restore, rejected-native recovery,
// Ask-to-Buy foreground recheck, entitlement mirroring, and teardown parity.
//
// Server-confirmed unlocks resolve through the controller's payoff (U3/R6): the entitled
// false→true transition with the paywall open shows "Pro unlocked. Enjoy the quiet." and the
// controller dismisses after ~2.5s — this module never force-dismisses at those moments.

function makeBridge(over: Partial<AppleSessionBridge> = {}): AppleSessionBridge {
  return {
    available: true,
    signInWithApple: vi.fn(async () => ({ identityToken: "tok", nonce: "n" })),
    configurePurchases: vi.fn(async () => {}),
    purchaseStillPro: vi.fn(async () => ({ outcome: "purchased" as const, entitled: true })),
    restore: vi.fn(async () => false),
    price: vi.fn(async () => "$1.99"),
    signOut: vi.fn(async () => {}),
    setEntitlement: vi.fn(async () => {}),
    ...over,
  };
}

function harness(opts: {
  bridge?: Partial<AppleSessionBridge>;
  /** What the (fake) reconcile lands in the controller when enterSession runs. */
  onSignedInState?: Partial<SyncState>;
  exchange?: AppleSessionDeps["exchangeAppleCredential"];
} = {}) {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { now: () => Date.now() });
  const controller = new UiController({ cache, host: { canPurchase: true } });
  const bridge = makeBridge(opts.bridge);
  // A fake SyncService: onSignedIn projects the configured post-reconcile state through the same
  // onSyncState path the real service drives.
  const sync = {
    onSignedIn: vi.fn(async (userId: string) => {
      session.onSyncState({
        userId,
        entitled: false,
        syncing: false,
        cloudReachable: true,
        ...opts.onSignedInState,
      });
    }),
    signOut: vi.fn(async () => {
      session.onSyncState({ userId: null, entitled: false, syncing: false, cloudReachable: true });
    }),
    deleteAccount: vi.fn(async () => {}),
  };
  const session = createAppleSession({
    controller,
    sync,
    bridge,
    exchangeAppleCredential: opts.exchange ?? (async () => ({ userId: "u1" })),
  });
  return { session, controller, bridge, sync };
}

describe("AppleSession — sync-state projection + entitlement mirror", () => {
  it("mirrors server-confirmed entitlement into the App Group", () => {
    const { session, bridge } = harness();
    session.onSyncState({ userId: "u1", entitled: true, syncing: true, cloudReachable: true });
    expect(bridge.setEntitlement).toHaveBeenCalledWith(true);
  });

  it("never mirrors an offline (non-server-confirmed) state — the 30-day TTL must keep running", () => {
    const { session, bridge } = harness();
    session.onSyncState({ userId: "u1", entitled: true, syncing: false, cloudReachable: false });
    expect(bridge.setEntitlement).not.toHaveBeenCalled();
  });

  it("mirrors the signed-out downgrade (entitled:false) so Safari re-locks", () => {
    const { session, bridge } = harness();
    session.onSyncState({ userId: null, entitled: false, syncing: false, cloudReachable: true });
    expect(bridge.setEntitlement).toHaveBeenCalledWith(false);
  });

  it("an entitled sync state with the paywall CLOSED unlocks quietly — no payoff (U3/R6)", () => {
    const { session, controller } = harness();
    session.onSyncState({ userId: "u1", entitled: true, syncing: true, cloudReachable: true });
    expect(controller.entitled).toBe(true);
    expect(controller.justUnlocked).toBe(false);
    expect(controller.paywallOpen).toBe(false);
  });
});

describe("AppleSession — enterSession", () => {
  it("configures RevenueCat for the UUID, reconciles, loads the price, clears reconciling", async () => {
    const { session, controller, bridge, sync } = harness();
    await session.enterSession("u1");
    expect(bridge.configurePurchases).toHaveBeenCalledWith("u1");
    expect(sync.onSignedIn).toHaveBeenCalledWith("u1");
    expect(controller.reconciling).toBe(false);
    await Promise.resolve(); // fire-and-forget price load lands
    expect(controller.paywallPrice).toBe("$1.99");
  });

  it("clears reconciling even when reconcile throws", async () => {
    const { session, controller, sync } = harness();
    sync.onSignedIn.mockRejectedValueOnce(new Error("net"));
    await expect(session.enterSession("u1")).rejects.toThrow("net");
    expect(controller.reconciling).toBe(false);
  });
});

describe("AppleSession — onGet (the purchase flow)", () => {
  it("double-charge guard: already entitled after the fresh online check → payoff, never purchase (AE4)", async () => {
    vi.useFakeTimers();
    try {
      const { session, controller, bridge } = harness({ onSignedInState: { entitled: true } });
      controller.userId = "u1";
      controller.openPaywall();
      await session.onGet();
      expect(bridge.purchaseStillPro).not.toHaveBeenCalled();
      // The cross-device restore case reads as success, not a silent dismiss: the entitled
      // transition shows the payoff, then the controller dismisses on its own (U3/R6).
      expect(controller.justUnlocked).toBe(true);
      expect(controller.paywallOpen).toBe(true);
      vi.advanceTimersByTime(PAYOFF_DURATION_MS);
      expect(controller.paywallOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offline guard: signed-in but unreachable → calm failure, never purchase", async () => {
    const { session, controller, bridge } = harness({ onSignedInState: { cloudReachable: false } });
    controller.userId = "u1";
    controller.openPaywall();
    await session.onGet();
    expect(bridge.purchaseStillPro).not.toHaveBeenCalled();
    expect(controller.purchaseFlow).toBe("failed");
    expect(controller.purchaseError).toMatch(/Try again when connected/);
  });

  it("local success but webhook not landed → pending, paywall stays open", async () => {
    // Reconcile keeps reporting not entitled (the webhook write hasn't landed yet).
    const { session, controller } = harness();
    controller.userId = "u1";
    controller.openPaywall();
    await session.onGet();
    expect(controller.purchaseFlow).toBe("pending");
    expect(controller.paywallOpen).toBe(true);
  });

  it("server-confirmed success → payoff, then the controller dismisses into Pro", async () => {
    vi.useFakeTimers();
    try {
      let reconciled = false;
      const h = harness({ onSignedInState: {} });
      h.sync.onSignedIn.mockImplementation(async (userId: string) => {
        h.session.onSyncState({
          userId,
          entitled: reconciled, // second reconcile (after purchase) sees the webhook's write
          syncing: false,
          cloudReachable: true,
        });
        reconciled = true;
      });
      h.controller.userId = "u1";
      h.controller.openPaywall();
      await h.session.onGet();
      expect(h.controller.entitled).toBe(true);
      // Payoff shown (never while entitled was still false), no instant force-dismiss (U3/R6)…
      expect(h.controller.justUnlocked).toBe(true);
      expect(h.controller.paywallOpen).toBe(true);
      expect(h.controller.purchaseFlow).toBe("idle"); // the payoff superseded "pending"/outcome copy
      // …then the controller auto-dismisses after the payoff.
      vi.advanceTimersByTime(PAYOFF_DURATION_MS);
      expect(h.controller.paywallOpen).toBe(false);
      expect(h.controller.justUnlocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejected native purchase resolves to a visible failed state (CTA never stuck)", async () => {
    const { session, controller } = harness({
      bridge: { purchaseStillPro: vi.fn(async () => Promise.reject(new Error("boom"))) },
    });
    controller.openPaywall();
    controller.beginPurchase();
    await session.onGet();
    expect(controller.purchaseFlow).toBe("failed");
    expect(controller.purchaseError).toBe("boom");
  });
});

describe("AppleSession — onRestore", () => {
  it("nothing to restore → restored-none note, sheet stays open", async () => {
    const { session, controller } = harness();
    controller.openPaywall();
    await session.onRestore();
    expect(controller.purchaseFlow).toBe("restored-none");
    expect(controller.paywallOpen).toBe(true);
  });

  it("restored + server-confirmed → payoff, then the controller dismisses into Pro", async () => {
    vi.useFakeTimers();
    try {
      const { session, controller } = harness({
        bridge: { restore: vi.fn(async () => true) },
        onSignedInState: { entitled: true },
      });
      controller.userId = "u1";
      controller.openPaywall();
      await session.onRestore();
      expect(controller.justUnlocked).toBe(true); // payoff instead of an instant dismiss (U3/R6)
      expect(controller.paywallOpen).toBe(true);
      vi.advanceTimersByTime(PAYOFF_DURATION_MS);
      expect(controller.paywallOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejected restore unsticks the CTA", async () => {
    const { session, controller } = harness({
      bridge: { restore: vi.fn(async () => Promise.reject(new Error("no"))) },
    });
    controller.openPaywall();
    controller.beginRestore();
    await session.onRestore();
    expect(controller.purchaseFlow).toBe("restored-none");
  });
});

describe("AppleSession — Ask-to-Buy foreground recheck", () => {
  it("re-enters the session only when visible + pending + signed-in + not reconciling", async () => {
    const { session, controller, sync } = harness({ onSignedInState: { entitled: true } });
    controller.userId = "u1";
    controller.openPaywall();
    controller.setPurchaseOutcome({ outcome: "pending", entitled: false });

    session.onVisibilityChange("hidden");
    expect(sync.onSignedIn).not.toHaveBeenCalled();

    session.onVisibilityChange("visible");
    // The rehydrated pending state counts as paywall-open: the landed approval shows the payoff
    // (controller-owned dismissal thereafter, pinned in the controller suite) — no force-dismiss.
    await vi.waitFor(() => expect(controller.justUnlocked).toBe(true));
    expect(controller.paywallOpen).toBe(true);
    expect(sync.onSignedIn).toHaveBeenCalledWith("u1");
    controller.dismissPaywall(); // clear the payoff timer so nothing fires after the test
  });

  it("does nothing when the purchase isn't pending", () => {
    const { session, sync, controller } = harness();
    controller.userId = "u1";
    session.onVisibilityChange("visible");
    expect(sync.onSignedIn).not.toHaveBeenCalled();
  });
});

describe("AppleSession — teardown parity (KTD5)", () => {
  it("sign-out clears the Supabase session even when the native RevenueCat reset rejects", async () => {
    const h = harness({ bridge: { signOut: vi.fn(async () => Promise.reject(new Error("native"))) } });
    await h.session.signOutEverywhere();
    expect(h.sync.signOut).toHaveBeenCalled();
  });

  it("account deletion is server-first: a backend failure keeps the session and skips the native reset", async () => {
    const h = harness();
    h.sync.deleteAccount.mockRejectedValueOnce(new Error("backend"));
    await expect(h.session.deleteAccountEverywhere()).rejects.toThrow("backend");
    expect(h.bridge.signOut).not.toHaveBeenCalled();
  });

  it("successful deletion resets the native identity afterwards", async () => {
    const h = harness();
    await h.session.deleteAccountEverywhere();
    expect(h.bridge.signOut).toHaveBeenCalled();
  });
});
