import { describe, it, expect, vi } from "vitest";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { UiController, type UiAuth, type UiHost } from "../controller.svelte.js";

function makeController(extra: { host?: Partial<UiHost>; auth?: UiAuth } = {}) {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { now: () => Date.now() });
  const c = new UiController({
    cache,
    host: { canPurchase: true, currentHost: "youtube.com", ...extra.host },
    auth: extra.auth,
  });
  return { c, cache };
}

describe("UiController", () => {
  it("toggles a service through the cache", () => {
    const { c, cache } = makeController();
    const spy = vi.spyOn(cache, "setService");
    c.toggleService("youtube");
    expect(spy).toHaveBeenCalledWith("youtube", false); // default on → off
  });

  it("toggles the global switch through the cache", () => {
    const { c, cache } = makeController();
    const spy = vi.spyOn(cache, "setGlobalOn");
    c.toggleGlobal();
    expect(spy).toHaveBeenCalledWith(false);
  });

  it("pauses then resumes the current host", () => {
    const { c, cache } = makeController();
    const pause = vi.spyOn(cache, "pauseHost");
    c.togglePause();
    expect(pause).toHaveBeenCalledWith("youtube.com");
  });

  it("derives the full popup state matrix", () => {
    const { c } = makeController();
    expect(c.popupState).toBe("signed-out");
    c.userId = "u";
    c.reconciling = true;
    expect(c.popupState).toBe("entitlement-pending");
    c.reconciling = false;
    expect(c.popupState).toBe("not-entitled");
    c.entitled = true;
    expect(c.popupState).toBe("entitled-syncing");
    c.cloudReachable = false;
    expect(c.popupState).toBe("cloud-unreachable");
  });

  it("runs the magic-link flow idle → sending → sent", async () => {
    const signIn = vi.fn(() => Promise.resolve({}));
    const { c } = makeController({ auth: { signIn, signOut: vi.fn(() => Promise.resolve()) } });
    const pending = c.signIn("a@b.com");
    expect(c.authFlow).toBe("sending");
    await pending;
    expect(c.authFlow).toBe("sent");
    expect(signIn).toHaveBeenCalledWith("a@b.com");
  });

  it("surfaces an auth error", async () => {
    const { c } = makeController({
      auth: { signIn: () => Promise.resolve({ error: "rate limited" }), signOut: vi.fn(() => Promise.resolve()) },
    });
    await c.signIn("a@b.com");
    expect(c.authFlow).toBe("error");
    expect(c.authError).toBe("rate limited");
  });

  it("signOut clears local state and resets the purchase flow even when auth.signOut throws", async () => {
    const { c } = makeController({
      auth: { signIn: () => Promise.resolve({}), signOut: () => Promise.reject(new Error("network")) },
    });
    c.userId = "u";
    c.entitled = true;
    c.purchaseFlow = "pending";
    await c.signOut(); // must not throw
    expect(c.userId).toBeNull();
    expect(c.entitled).toBe(false);
    expect(c.purchaseFlow).toBe("idle");
    expect(c.popupState).toBe("signed-out");
  });

  it("sign-in sheet opens and dismisses, clearing a stale auth error", () => {
    const { c } = makeController();
    c.openSignIn();
    expect(c.signInOpen).toBe(true);
    c.authFlow = "error";
    c.authError = "nope";
    c.dismissSignIn();
    expect(c.signInOpen).toBe(false);
    expect(c.authFlow).toBe("idle");
    expect(c.authError).toBeNull();
  });

  // ── account deletion (App Store 5.1.1) ──────────────────────────────────────────────────────────

  const deletableAuth = (deleteAccount: () => Promise<void>): UiAuth => ({
    signIn: () => Promise.resolve({}),
    signOut: vi.fn(() => Promise.resolve()),
    deleteAccount,
  });

  it("canDeleteAccount reflects whether the host wired deletion", () => {
    const without = makeController({ auth: { signIn: () => Promise.resolve({}), signOut: vi.fn() } });
    expect(without.c.canDeleteAccount).toBe(false);
    const withDel = makeController({ auth: deletableAuth(vi.fn(() => Promise.resolve())) });
    expect(withDel.c.canDeleteAccount).toBe(true);
  });

  it("delete flow: request → confirming, cancel → idle", () => {
    const { c } = makeController({ auth: deletableAuth(vi.fn(() => Promise.resolve())) });
    c.requestDeleteAccount();
    expect(c.deleteFlow).toBe("confirming");
    c.cancelDeleteAccount();
    expect(c.deleteFlow).toBe("idle");
  });

  it("confirmDeleteAccount deletes then returns to signed-out", async () => {
    const del = vi.fn(() => Promise.resolve());
    const { c } = makeController({ auth: deletableAuth(del) });
    c.userId = "u";
    c.entitled = true;
    c.requestDeleteAccount();
    await c.confirmDeleteAccount();
    expect(del).toHaveBeenCalledOnce();
    expect(c.userId).toBeNull();
    expect(c.entitled).toBe(false);
    expect(c.deleteFlow).toBe("idle");
    expect(c.popupState).toBe("signed-out");
  });

  it("a failed delete surfaces an error and keeps the user signed in", async () => {
    const del = vi.fn(() => Promise.reject(new Error("boom")));
    const { c } = makeController({ auth: deletableAuth(del) });
    c.userId = "u";
    await c.confirmDeleteAccount();
    expect(c.deleteFlow).toBe("error");
    expect(c.deleteError).toBe("boom");
    expect(c.userId).toBe("u"); // still signed in
  });

  // ── purchase flow (P1 #5) ───────────────────────────────────────────────────────────────────────

  it("beginPurchase enters the purchasing state and guards duplicate taps", () => {
    const { c } = makeController();
    expect(c.beginPurchase()).toBe(true);
    expect(c.purchaseFlow).toBe("purchasing");
    expect(c.purchaseBusy).toBe(true);
    expect(c.beginPurchase()).toBe(false); // already busy → no-op
  });

  it("maps each purchase outcome to a visible state", () => {
    const { c } = makeController();
    c.setPurchaseOutcome({ outcome: "purchased", entitled: true });
    expect(c.purchaseFlow).toBe("idle");
    c.setPurchaseOutcome({ outcome: "pending", entitled: false });
    expect(c.purchaseFlow).toBe("pending");
    c.setPurchaseOutcome({ outcome: "cancelled", entitled: false });
    expect(c.purchaseFlow).toBe("cancelled");
    c.setPurchaseOutcome({ outcome: "failed", entitled: false, error: "network down" });
    expect(c.purchaseFlow).toBe("failed");
    expect(c.purchaseError).toBe("network down");
    c.setPurchaseOutcome({ outcome: "unavailable", entitled: false });
    expect(c.purchaseFlow).toBe("unavailable");
  });

  it("restore reports restored vs nothing-to-restore", () => {
    const { c } = makeController();
    expect(c.beginRestore()).toBe(true);
    expect(c.purchaseFlow).toBe("restoring");
    c.setRestoreOutcome(false);
    expect(c.purchaseFlow).toBe("restored-none");
    c.beginRestore();
    c.setRestoreOutcome(true);
    expect(c.purchaseFlow).toBe("idle");
  });

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
});
