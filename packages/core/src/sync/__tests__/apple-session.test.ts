import { describe, expect, it, vi } from "vitest";
import { harness } from "./support/apple-session-harness.js";

// The money-flow branches that used to live untested in the app-webview entrypoint: double-charge
// guard, offline guard, pending-vs-payoff after purchase/restore, rejected-native recovery,
// Ask-to-Buy foreground recheck, entitlement mirroring, and teardown parity.
//
// Server-confirmed unlocks resolve through the controller's payoff (U3/R6): the entitled
// false→true transition with the paywall open shows the quieter-web success payoff and the
// controller dismisses after ~2.5s — this module never force-dismisses at those moments.

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

  it("a resolved noSignal never downgrades receipt Pro (tri-state contract)", async () => {
    const status = vi.fn(async () => "entitled" as const);
    const { session, controller } = harness({ bridge: { receiptStatus: status } });
    await session.refreshReceipt();
    expect(controller.receiptEntitled).toBe(true);
    status.mockResolvedValue("noSignal" as never); // deadline / unverifiable read — ambiguity
    await session.refreshReceipt();
    expect(controller.receiptEntitled).toBe(true); // only an affirmative revocation clears it
  });

  it("a rejected receipt read resolves to noSignal and keeps UI state (never throws)", async () => {
    const { session, controller } = harness({
      bridge: { receiptStatus: vi.fn(async () => Promise.reject(new Error("port died"))) },
    });
    controller.receiptEntitled = true;
    await expect(session.refreshReceipt()).resolves.toBe("noSignal");
    expect(controller.receiptEntitled).toBe(true);
  });

  it("foreground retries a failed attach: signed-in + receipt Pro + server not entitled (R7 self-heal)", async () => {
    const h = harness({
      bridge: { receiptStatus: vi.fn(async () => "entitled" as const) },
    });
    h.controller.userId = "u1";
    await h.session.refreshReceipt(); // receipt lane known-entitled; server lane still false
    expect(h.controller.serverEntitled).toBe(false);
    h.session.onVisibilityChange("visible");
    await vi.waitFor(() => expect(h.sync.onSignedIn).toHaveBeenCalledWith("u1"));
  });

  it("foreground does NOT reconcile for a free signed-in user (rate-limit guard)", async () => {
    const h = harness(); // receipt noSignal
    h.controller.userId = "u1";
    h.session.onVisibilityChange("visible");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sync.onSignedIn).not.toHaveBeenCalled();
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
