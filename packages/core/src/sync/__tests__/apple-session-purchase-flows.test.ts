// The Apple money flows, exercised with the paid tier switched ON.
//
// Double-charge guard, offline guard, pending-versus-payoff after a purchase or restore, and the
// Ask-to-Buy foreground recheck. None of this can happen while the paid tier is dormant: the native
// bridge refuses purchase and restore outright, so the controller never reaches a success screen.
// The code is all still here and all still shipped, though, so it is tested here with the switch
// mocked on rather than left dark until the day it matters again.
import { describe, it, expect, vi } from "vitest";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { PAYOFF_DURATION_MS } from "../../ui/controller.svelte.js";
import { harness } from "./support/apple-session-harness.js";

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
    // "Not now" (wired to dismissPaywall — the one dismissal path) leaves an entitled,
    // account-free home screen — never a dead buy CTA.
    controller.dismissPaywall();
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
    // AMENDED (purchase-first): a rise that resolves a PENDING purchase is a purchase moment —
    // it routes to the success screen (no auto-dismiss), never the quiet payoff, regardless of
    // whether the reconcile or the receipt read delivers the flip first (adversarial review pin).
    await vi.waitFor(() => expect(controller.successScreen).toBe("synced"));
    expect(controller.justUnlocked).toBe(false);
    expect(controller.paywallOpen).toBe(true);
    expect(sync.onSignedIn).toHaveBeenCalledWith("u1");
    controller.dismissPaywall();
  });

  it("does nothing when the purchase isn't pending", () => {
    const { session, sync, controller } = harness();
    controller.userId = "u1";
    session.onVisibilityChange("visible");
    expect(sync.onSignedIn).not.toHaveBeenCalled();
  });
});

describe("AppleSession — receipt lane, purchase moments", () => {
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
});
