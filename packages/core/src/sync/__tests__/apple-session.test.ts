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
// false→true transition with the paywall open shows the quieter-web success payoff and the
// controller dismisses after ~2.5s — this module never force-dismisses at those moments.

function makeBridge(over: Partial<AppleSessionBridge> = {}): AppleSessionBridge {
  return {
    available: true,
    signInWithApple: vi.fn(async () => ({ identityToken: "tok", nonce: "n" })),
    configurePurchases: vi.fn(async () => {}),
    purchaseStillPro: vi.fn(async () => ({ outcome: "purchased" as const, entitled: true })),
    restore: vi.fn(async () => false),
    receiptStatus: vi.fn(async () => "noSignal" as const),
    attachPurchases: vi.fn(async () => false),
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
        confirmed: true,
        ...opts.onSignedInState,
      });
    }),
    signOut: vi.fn(async () => {
      session.onSyncState({ userId: null, entitled: false, syncing: false, cloudReachable: true, confirmed: true });
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
    session.onSyncState({ userId: "u1", entitled: true, syncing: true, cloudReachable: true, confirmed: true });
    expect(bridge.setEntitlement).toHaveBeenCalledWith(true);
  });

  it("never mirrors an offline (non-server-confirmed) state — the 30-day TTL must keep running", () => {
    const { session, bridge } = harness();
    session.onSyncState({ userId: "u1", entitled: true, syncing: false, cloudReachable: false, confirmed: true });
    expect(bridge.setEntitlement).not.toHaveBeenCalled();
  });

  it("never mirrors onSignedIn's PROVISIONAL emit — a cold resume must not overwrite a cached Pro record", () => {
    const { session, bridge } = harness();
    // The provisional pre-reconcile state: cloudReachable true, entitled a cold-start guess (false),
    // confirmed false. Stamping this into the App Group would downgrade Safari before the server answers.
    session.onSyncState({ userId: "u1", entitled: false, syncing: false, cloudReachable: true, confirmed: false });
    expect(bridge.setEntitlement).not.toHaveBeenCalled();
  });

  it("mirrors the signed-out downgrade (entitled:false) so Safari re-locks", () => {
    const { session, bridge } = harness();
    session.onSyncState({ userId: null, entitled: false, syncing: false, cloudReachable: true, confirmed: true });
    expect(bridge.setEntitlement).toHaveBeenCalledWith(false);
  });

  it("an entitled sync state with the paywall CLOSED unlocks quietly — no payoff (U3/R6)", () => {
    const { session, controller } = harness();
    session.onSyncState({ userId: "u1", entitled: true, syncing: true, cloudReachable: true, confirmed: true });
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

  it("signed-in purchase success → SYNC-flavored success screen, receipt fed, no auto-dismiss", async () => {
    // AMENDED for purchase-first (plan 2026-07-15-001, R3/R5): the receipt is the device
    // authority now — a purchased outcome resolves to the success screen immediately, no longer
    // waiting on the webhook round-trip for the UI moment (previously: "pending" until the
    // server confirmed). The signed-in branch confirms sync and never pitches an account.
    vi.useFakeTimers();
    try {
      // No receipt until the purchase completes: the pre-purchase reconcile's attach evaluation
      // sees noSignal (otherwise the double-charge guard correctly resolves without purchasing —
      // the device already owns Pro).
      const receiptStatus = vi
        .fn<() => Promise<"noSignal" | "entitled">>()
        .mockResolvedValueOnce("noSignal");
      receiptStatus.mockResolvedValue("entitled");
      const { session, controller } = harness({ bridge: { receiptStatus } });
      controller.userId = "u1";
      controller.openPaywall();
      await session.onGet();
      expect(controller.successScreen).toBe("synced");
      expect(controller.paywallOpen).toBe(true);
      expect(controller.receiptEntitled).toBe(true);
      expect(controller.entitled).toBe(true);
      // NO auto-dismiss (the old 2.5s payoff was a one-liner; the success screen waits for an
      // explicit choice).
      vi.advanceTimersByTime(PAYOFF_DURATION_MS * 4);
      expect(controller.paywallOpen).toBe(true);
      expect(controller.justUnlocked).toBe(false); // the success screen suppresses the payoff
    } finally {
      vi.useRealTimers();
    }
  });

  it("signed-out purchase success → ACCOUNT-PITCH success screen (AE1)", async () => {
    const { session, controller, bridge } = harness({
      bridge: { receiptStatus: vi.fn(async () => "entitled" as const) },
    });
    controller.openPaywall();
    await session.onGet();
    // No session: no enterSession, no reconcile — purchase directly (R1).
    expect(bridge.configurePurchases).not.toHaveBeenCalled();
    expect(controller.successScreen).toBe("account-pitch");
    expect(controller.receiptEntitled).toBe(true);
    expect(controller.entitled).toBe(true);
    expect(controller.userId).toBeNull();
    // "Not now" leaves an entitled, account-free home screen — never a dead buy CTA.
    controller.dismissSuccess();
    expect(controller.popupState).toBe("pro-no-account");
  });

  it("staleIdentity outcome renders its retryable flow state (R15)", async () => {
    const { session, controller } = harness({
      bridge: {
        purchaseStillPro: vi.fn(async () => ({
          outcome: "staleIdentity" as const,
          entitled: false,
        })),
      },
    });
    controller.openPaywall();
    await session.onGet();
    expect(controller.purchaseFlow).toBe("stale-identity");
    expect(controller.paywallOpen).toBe(true);
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
  it("does not re-stamp a late confirmed entitlement after sign-out", async () => {
    const h = harness();
    let release!: () => void;
    const reconcile = new Promise<void>((resolve) => { release = resolve; });
    h.sync.onSignedIn.mockImplementation(async (userId: string) => {
      await reconcile;
      h.session.onSyncState({
        userId,
        entitled: true,
        syncing: true,
        cloudReachable: true,
        confirmed: true,
      });
    });

    const entering = h.session.enterSession("u1");
    await Promise.resolve();
    await h.session.signOutEverywhere();
    release();
    await entering;

    expect(h.bridge.setEntitlement).toHaveBeenLastCalledWith(false);
    expect(h.controller.userId).toBeNull();
    expect(h.controller.entitled).toBe(false);
  });

  it("does not re-stamp a late confirmed entitlement after account deletion", async () => {
    const h = harness();
    let release!: () => void;
    const reconcile = new Promise<void>((resolve) => { release = resolve; });
    h.sync.onSignedIn.mockImplementation(async (userId: string) => {
      await reconcile;
      h.session.onSyncState({ userId, entitled: true, syncing: true, cloudReachable: true, confirmed: true });
    });
    h.sync.deleteAccount.mockImplementation(async () => {
      h.session.onSyncState({ userId: null, entitled: false, syncing: false, cloudReachable: true, confirmed: true });
    });

    const entering = h.session.enterSession("u1");
    await Promise.resolve();
    await h.session.deleteAccountEverywhere();
    release();
    await entering;

    expect(h.bridge.setEntitlement).toHaveBeenLastCalledWith(false);
    expect(h.controller.userId).toBeNull();
    expect(h.controller.entitled).toBe(false);
  });

  it("does not let an earlier user reclaim a later sign-in after teardown", async () => {
    const h = harness();
    let releaseFirst!: () => void;
    const firstReconcile = new Promise<void>((resolve) => { releaseFirst = resolve; });
    h.sync.onSignedIn.mockImplementation(async (userId: string) => {
      if (userId === "u1") await firstReconcile;
      h.session.onSyncState({ userId, entitled: true, syncing: true, cloudReachable: true, confirmed: true });
    });

    const first = h.session.enterSession("u1");
    await Promise.resolve();
    await h.session.signOutEverywhere();
    await h.session.enterSession("u2");
    releaseFirst();
    await first;

    expect(h.controller.userId).toBe("u2");
    expect(h.controller.entitled).toBe(true);
    expect(h.bridge.setEntitlement).toHaveBeenCalledTimes(2); // signed-out false, then u2 true
    expect(h.bridge.setEntitlement).toHaveBeenLastCalledWith(true);
  });

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

describe("AppleSession — receipt lane (R6/R17/R18, plan 2026-07-15-001)", () => {
  it("receipt Pro SURVIVES sign-out: server lane clears, entitled stays true, no doomed mirror (AE2)", async () => {
    const { session, controller, bridge } = harness({
      bridge: { receiptStatus: vi.fn(async () => "entitled" as const) },
    });
    await session.refreshReceipt();
    expect(controller.receiptEntitled).toBe(true);
    await session.signOutEverywhere();
    // The server lane cleared; the device receipt keeps Pro (R6).
    expect(controller.userId).toBeNull();
    expect(controller.entitled).toBe(true);
    expect(controller.popupState).toBe("pro-no-account");
    // The doomed server-lane false proposal is skipped (the native policy would block it anyway).
    expect(bridge.setEntitlement).not.toHaveBeenCalledWith(false);
  });

  it("sign-out on a no-receipt device still proposes the downgrade (AE12 — shared-machine invariant)", async () => {
    const { session, bridge, controller } = harness(); // receiptStatus default: noSignal
    await session.refreshReceipt();
    await session.signOutEverywhere();
    expect(bridge.setEntitlement).toHaveBeenLastCalledWith(false);
    expect(controller.entitled).toBe(false);
  });

  it("attach evaluation: server not entitled + receipt entitled → attach → second reconcile (AE3 spine)", async () => {
    let serverEntitled = false;
    const h = harness({
      bridge: {
        receiptStatus: vi.fn(async () => "entitled" as const),
        attachPurchases: vi.fn(async () => {
          serverEntitled = true; // the sync/webhook records it; the next reconcile sees it
          return true;
        }),
      },
    });
    h.sync.onSignedIn.mockImplementation(async (userId: string) => {
      h.session.onSyncState({
        userId,
        entitled: serverEntitled,
        syncing: false,
        cloudReachable: true,
        confirmed: true,
      });
    });
    await h.session.enterSession("u1");
    expect(h.bridge.attachPurchases).toHaveBeenCalledTimes(1);
    expect(h.sync.onSignedIn).toHaveBeenCalledTimes(2); // reconcile → attach → reconcile again
    expect(h.controller.serverEntitled).toBe(true);
  });

  it("attach is idempotent: an already-entitled account never attaches", async () => {
    const h = harness({
      onSignedInState: { entitled: true },
      bridge: { receiptStatus: vi.fn(async () => "entitled" as const) },
    });
    await h.session.enterSession("u1");
    expect(h.bridge.attachPurchases).not.toHaveBeenCalled();
    expect(h.sync.onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("no receipt → no attach call (R8: server entitlement flows as today)", async () => {
    const h = harness(); // receiptStatus: noSignal
    await h.session.enterSession("u1");
    expect(h.bridge.attachPurchases).not.toHaveBeenCalled();
  });

  it("teardown mid-attach-evaluation aborts it: no transfer to the post-sign-out identity (AE13)", async () => {
    let releaseReceipt!: () => void;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const h = harness({
      bridge: {
        receiptStatus: vi.fn(async () => {
          await receiptGate;
          return "entitled" as const;
        }),
      },
    });
    const entering = h.session.enterSession("u1");
    await Promise.resolve(); // configure + first reconcile land; attach eval blocks on the receipt
    await h.session.signOutEverywhere();
    releaseReceipt();
    await entering;
    expect(h.bridge.attachPurchases).not.toHaveBeenCalled();
    expect(h.sync.onSignedIn).toHaveBeenCalledTimes(1); // no second reconcile for the departed user
  });

  it("signed-out restore resolves from the receipt (AE11/R4)", async () => {
    const { session, controller } = harness({
      bridge: {
        restore: vi.fn(async () => true),
        receiptStatus: vi.fn(async () => "entitled" as const),
      },
    });
    controller.openPaywall();
    await session.onRestore();
    expect(controller.receiptEntitled).toBe(true);
    expect(controller.purchaseFlow).toBe("idle"); // restored → resolved
    expect(controller.userId).toBeNull();
  });

  it("signed-out Ask-to-Buy approval resolves on foreground: pending → success screen (AE9/R18)", async () => {
    const { session, controller } = harness({
      bridge: { receiptStatus: vi.fn(async () => "entitled" as const) },
    });
    controller.openPaywall();
    controller.setPurchaseOutcome({ outcome: "pending", entitled: false });
    session.onVisibilityChange("visible");
    await vi.waitFor(() => expect(controller.successScreen).toBe("account-pitch"));
    expect(controller.receiptEntitled).toBe(true);
    expect(controller.paywallOpen).toBe(true);
  });

  it("a refund (verifiedNotEntitled) clears receipt Pro in the UI", async () => {
    const status = vi.fn(async () => "entitled" as const);
    const { session, controller } = harness({ bridge: { receiptStatus: status } });
    await session.refreshReceipt();
    expect(controller.entitled).toBe(true);
    status.mockResolvedValue("verifiedNotEntitled" as never);
    await session.refreshReceipt();
    expect(controller.receiptEntitled).toBe(false);
    expect(controller.entitled).toBe(false);
  });
});

describe("AppleSession — email-code sign-in entry (onCodeVerified)", () => {
  it("awaits the full session entry: RevenueCat keyed to the UUID (KTD5), reconcile projected, price loaded", async () => {
    const { session, controller, bridge, sync } = harness();
    await session.onCodeVerified("u7");
    expect(bridge.configurePurchases).toHaveBeenCalledWith("u7");
    expect(sync.onSignedIn).toHaveBeenCalledWith("u7");
    expect(controller.userId).toBe("u7");
    expect(controller.reconciling).toBe(false);
    await new Promise((r) => setTimeout(r, 0)); // price load is fire-and-forget by design
    expect(controller.paywallPrice).toBe("$1.99");
  });

  it("swallows bootstrap failures — the session exists; onGet/visibility re-entry self-heal (never throw at the sheet)", async () => {
    const { session, controller } = harness({
      bridge: {
        configurePurchases: vi.fn(async () => {
          throw new Error("native bridge down");
        }),
      },
    });
    await expect(session.onCodeVerified("u7")).resolves.toBeUndefined();
    expect(controller.reconciling).toBe(false); // the finally still clears the in-flight state
  });

  it("a sync bootstrap failure after RevenueCat config is also swallowed and clears reconciling", async () => {
    const h = harness();
    h.sync.onSignedIn.mockRejectedValueOnce(new Error("backend down"));
    await expect(h.session.onCodeVerified("u9")).resolves.toBeUndefined();
    expect(h.controller.reconciling).toBe(false);
    expect(h.controller.userId).toBeNull(); // onSyncState never ran — the signed-in projection waits for the self-heal
  });
});
