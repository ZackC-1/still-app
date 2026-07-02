import { describe, it, expect, vi } from "vitest";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import {
  UiController,
  OTP_TTL_MS,
  PAYOFF_DURATION_MS,
  CHECKOUT_POLL_INTERVAL_MS,
  CHECKOUT_POLL_MAX,
  CHECKOUT_PENDING_TTL_MS,
  type AuthPersistence,
  type CheckoutPending,
  type CheckoutReconcileOutcome,
  type UiAuth,
  type UiCheckout,
  type UiHost,
} from "../controller.svelte.js";
import type { RequestCodeOutcome, VerifyCodeOutcome, WebCheckoutOutcome } from "../../sync/ports.js";
import { STRINGS } from "../strings.js";

function makeController(
  extra: {
    host?: Partial<UiHost>;
    auth?: UiAuth;
    persistence?: AuthPersistence;
    checkout?: UiCheckout;
    clock?: () => number;
  } = {},
) {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { now: () => Date.now() });
  const c = new UiController({
    cache,
    host: { canPurchase: true, currentHost: "youtube.com", ...extra.host },
    auth: extra.auth,
    persistence: extra.persistence,
    checkout: extra.checkout,
    clock: extra.clock,
  });
  return { c, cache };
}

/** An extension-shaped UiAuth: code capability, no magic link (plan U2/R1). */
function codeAuth(over: Partial<UiAuth> = {}): UiAuth {
  return {
    signOut: vi.fn(() => Promise.resolve()),
    requestCode: vi.fn(() => Promise.resolve<RequestCodeOutcome>({ kind: "sent" })),
    verifyCode: vi.fn(() =>
      Promise.resolve<VerifyCodeOutcome>({ kind: "verified", userId: "user-1" }),
    ),
    ...over,
  };
}

function mockPersistence() {
  return { setPendingOtp: vi.fn(), setPurchaseIntent: vi.fn() };
}

const CHECKOUT_URL = "https://pay.rev.cat/tok/user-uuid";

/** An in-memory UiCheckout seam (plan U4): `order` records the persist/open sequence so tests can
 * pin persisted-BEFORE-opened (the popup dies the moment the tab takes focus). */
function checkoutSeam(over: Partial<UiCheckout> = {}) {
  const order: string[] = [];
  const seam = {
    createCheckout: vi.fn(() =>
      Promise.resolve<WebCheckoutOutcome>({ kind: "checkout-url", url: CHECKOUT_URL }),
    ),
    openCheckoutTab: vi.fn((url: string) => {
      order.push(`open:${url}`);
      return Promise.resolve<number | undefined>(42);
    }),
    setPending: vi.fn((pending: CheckoutPending | null) => {
      order.push(pending === null ? "clear-pending" : "persist-pending");
    }),
    reconcile: vi.fn(() => Promise.resolve<CheckoutReconcileOutcome>("unknown")),
    ...over,
  };
  return { seam, order };
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

  it("locks Pro services for un-entitled users and unlocks them when entitled", () => {
    const { c } = makeController();
    expect(c.isLocked("youtube")).toBe(false); // free service is never locked
    expect(c.isLocked("instagram")).toBe(true);
    expect(c.isLocked("tiktok")).toBe(true);
    expect(c.isLocked("facebook")).toBe(true);
    c.entitled = true;
    expect(c.isLocked("instagram")).toBe(false);
    expect(c.isLocked("tiktok")).toBe(false);
    expect(c.isLocked("facebook")).toBe(false);
  });

  it("locked tap routes signed-out purchasable users to sign-in first (principle 8)", () => {
    const { c } = makeController({
      auth: { signIn: vi.fn(() => Promise.resolve({})), signOut: vi.fn(() => Promise.resolve()) },
    });
    c.lockedTap();
    expect(c.signInOpen).toBe(true);
    expect(c.paywallOpen).toBe(false);
  });

  it("locked tap opens the paywall for signed-in users", () => {
    const { c } = makeController({
      auth: { signIn: vi.fn(() => Promise.resolve({})), signOut: vi.fn(() => Promise.resolve()) },
    });
    c.userId = "u";
    c.lockedTap();
    expect(c.paywallOpen).toBe(true);
    expect(c.signInOpen).toBe(false);
  });

  it("locked tap opens the (explanatory) paywall on hosts without a purchase path", () => {
    const { c } = makeController({ host: { canPurchase: false } }); // extension shape: no auth either
    c.lockedTap();
    expect(c.paywallOpen).toBe(true);
    expect(c.signInOpen).toBe(false);
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

  it("sign-in sheet opens and dismisses, resetting a terminal auth state (error or sent)", () => {
    const { c } = makeController();
    c.openSignIn();
    expect(c.signInOpen).toBe(true);
    c.authFlow = "error";
    c.authError = "nope";
    c.dismissSignIn();
    expect(c.signInOpen).toBe(false);
    expect(c.authFlow).toBe("idle");
    expect(c.authError).toBeNull();

    // A lingering "sent" must also reset, else reopening lands on a Resend with an empty email.
    c.openSignIn();
    c.authFlow = "sent";
    c.dismissSignIn();
    expect(c.authFlow).toBe("idle");
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

  // ── email-OTP code flow (plan U2/R1) ────────────────────────────────────────────────────────────

  it("requestCode success lands on code entry with the email retained and the pending OTP persisted", async () => {
    const t = 5_000;
    const persistence = mockPersistence();
    const auth = codeAuth();
    const { c } = makeController({ auth, persistence, clock: () => t });
    expect(c.canUseCode).toBe(true);
    await c.signIn("a@b.com");
    expect(auth.requestCode).toHaveBeenCalledWith("a@b.com");
    expect(c.authFlow).toBe("code-entry");
    expect(c.codeEmail).toBe("a@b.com");
    expect(persistence.setPendingOtp).toHaveBeenCalledWith({ email: "a@b.com", requestedAt: t });
    c.dismissSignIn(); // stop the cooldown ticker
  });

  it("requestCode failure shows the calm error state with no raw error text", async () => {
    const auth = codeAuth({
      requestCode: vi.fn(() => Promise.resolve<RequestCodeOutcome>({ kind: "send-failed" })),
    });
    const persistence = mockPersistence();
    const { c } = makeController({ auth, persistence });
    await c.signIn("a@b.com");
    expect(c.authFlow).toBe("error");
    expect(c.authError).toBeNull(); // the sheet shows its own code-flow copy, never backend text
    expect(c.codeEmail).toBeNull();
    expect(persistence.setPendingOtp).not.toHaveBeenCalled(); // nothing was sent → nothing pending
  });

  it("verifyCode success signs in, closes the sheet, and clears the pending OTP", async () => {
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth(), persistence });
    c.openSignIn();
    await c.signIn("a@b.com");
    await c.verifyCode("123456");
    expect(c.userId).toBe("user-1");
    expect(c.authFlow).toBe("idle");
    expect(c.signInOpen).toBe(false);
    expect(persistence.setPendingOtp).toHaveBeenLastCalledWith(null);
    expect(c.paywallOpen).toBe(false); // plain sign-in (no locked-row intent) → no paywall
  });

  it("a wrong code lands on code-error and a corrected retry still succeeds", async () => {
    const verifyCode = vi
      .fn()
      .mockResolvedValueOnce({ kind: "invalid-code" })
      .mockResolvedValueOnce({ kind: "verified", userId: "user-1" });
    const { c } = makeController({ auth: codeAuth({ verifyCode }) });
    await c.signIn("a@b.com");
    await c.verifyCode("000000");
    expect(c.authFlow).toBe("code-error");
    expect(c.codeErrorKind).toBe("wrong");
    expect(c.suggestNewCode).toBe(false);
    await c.verifyCode("123456"); // retry straight from code-error
    expect(c.userId).toBe("user-1");
    expect(c.authFlow).toBe("idle");
  });

  it("repeated invalid codes surface the request-a-new-code affordance", async () => {
    const verifyCode = vi.fn(() =>
      Promise.resolve<VerifyCodeOutcome>({ kind: "invalid-code" }),
    );
    const { c } = makeController({ auth: codeAuth({ verifyCode }) });
    await c.signIn("a@b.com");
    await c.verifyCode("111111");
    await c.verifyCode("222222");
    expect(c.suggestNewCode).toBe(false);
    await c.verifyCode("333333");
    expect(c.suggestNewCode).toBe(true);
    c.dismissSignIn();
  });

  it("a verify network failure is not an attempt — calm retry, no invalidation pressure", async () => {
    const verifyCode = vi.fn(() =>
      Promise.resolve<VerifyCodeOutcome>({ kind: "verify-failed" }),
    );
    const { c } = makeController({ auth: codeAuth({ verifyCode }) });
    await c.signIn("a@b.com");
    await c.verifyCode("123456");
    expect(c.authFlow).toBe("code-error");
    expect(c.codeErrorKind).toBe("check-failed");
    expect(c.codeAttempts).toBe(0); // the code may still be good
    c.dismissSignIn();
  });

  it("a failed verify past the OTP TTL reads as expired", async () => {
    let t = 1_000;
    const verifyCode = vi.fn(() =>
      Promise.resolve<VerifyCodeOutcome>({ kind: "invalid-code" }),
    );
    const { c } = makeController({ auth: codeAuth({ verifyCode }), clock: () => t });
    await c.signIn("a@b.com");
    t += OTP_TTL_MS + 1;
    await c.verifyCode("123456");
    expect(c.codeErrorKind).toBe("expired");
    c.dismissSignIn();
  });

  it("resend is blocked during the 60s cooldown with a visible countdown, then unblocks", async () => {
    vi.useFakeTimers();
    try {
      let t = 1_000_000;
      const auth = codeAuth();
      const { c } = makeController({ auth, clock: () => t });
      await c.signIn("a@b.com");
      expect(c.resendCooldown).toBe(60);
      await c.resendCode(); // blocked mid-cooldown → no network call
      expect(auth.requestCode).toHaveBeenCalledTimes(1);

      t += 15_000;
      vi.advanceTimersByTime(15_000);
      expect(c.resendCooldown).toBe(45); // countdown is visible and live

      t += 45_000;
      vi.advanceTimersByTime(45_000);
      expect(c.resendCooldown).toBe(0);
      await c.resendCode(); // cooldown over → resend goes through
      expect(auth.requestCode).toHaveBeenCalledTimes(2);
      expect(c.resendCooldown).toBe(60); // a fresh send restarts the countdown
      c.dismissSignIn();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismissing mid-verify drops the result — a cancelled verify does not sign in (F6)", async () => {
    let resolveVerify!: (v: VerifyCodeOutcome) => void;
    const verifyCode = vi.fn(
      () => new Promise<VerifyCodeOutcome>((resolve) => (resolveVerify = resolve)),
    );
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth({ verifyCode }), persistence });
    await c.signIn("a@b.com");
    const pending = c.verifyCode("123456"); // in flight
    c.dismissSignIn(); // user hits "Not now" before the network resolves
    resolveVerify({ kind: "verified", userId: "user-1" });
    await pending;
    expect(c.userId).toBeNull(); // the abandoned verify never signed them in
    expect(c.signInOpen).toBe(false);
  });

  it("dismissing mid-send drops the result — no pendingOtp persisted, no code entry (F6)", async () => {
    let resolveSend!: (v: RequestCodeOutcome) => void;
    const requestCode = vi.fn(
      () => new Promise<RequestCodeOutcome>((resolve) => (resolveSend = resolve)),
    );
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth({ requestCode }), persistence });
    const pending = c.signIn("a@b.com"); // enters "sending", awaits requestCode
    c.dismissSignIn();
    resolveSend({ kind: "sent" });
    await pending;
    expect(c.authFlow).not.toBe("code-entry");
    expect(c.codeEmail).toBeNull();
    expect(persistence.setPendingOtp).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: "a@b.com" }),
    );
  });

  it("a double-tapped resend fires exactly one request (synchronous in-flight guard, F7)", async () => {
    vi.useFakeTimers();
    try {
      let t = 1_000_000;
      let resolveResend!: (v: RequestCodeOutcome) => void;
      const requestCode = vi
        .fn()
        .mockResolvedValueOnce({ kind: "sent" }) // the initial signIn
        .mockImplementationOnce(
          () => new Promise<RequestCodeOutcome>((resolve) => (resolveResend = resolve)),
        );
      const { c } = makeController({ auth: codeAuth({ requestCode }), clock: () => t });
      await c.signIn("a@b.com");
      t += 60_000;
      vi.advanceTimersByTime(60_000); // cooldown elapsed → resend is enabled
      const first = c.resendCode();
      const second = c.resendCode(); // second tap before the first resolves
      resolveResend({ kind: "sent" });
      await Promise.all([first, second]);
      expect(requestCode).toHaveBeenCalledTimes(2); // 1 initial + 1 resend, never 3
      c.dismissSignIn();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rehydrateCodeEntry lands straight on code entry for the persisted email (AE2)", () => {
    const t = 100_000;
    const { c } = makeController({ auth: codeAuth(), clock: () => t });
    c.rehydrateCodeEntry({ email: "saved@b.com", requestedAt: t - 10_000, purchaseIntent: true });
    expect(c.authFlow).toBe("code-entry");
    expect(c.signInOpen).toBe(true);
    expect(c.codeEmail).toBe("saved@b.com");
    expect(c.resendCooldown).toBe(50); // countdown restored from the original request time
    expect(c.purchaseIntent).toBe(true);
    c.dismissSignIn();
  });

  it("an Apple-shaped UiAuth (no code capability) keeps the magic-link flow unchanged", async () => {
    const signIn = vi.fn(() => Promise.resolve({}));
    const { c } = makeController({ auth: { signIn, signOut: vi.fn(() => Promise.resolve()) } });
    expect(c.canUseCode).toBe(false);
    await c.signIn("a@b.com");
    expect(c.authFlow).toBe("sent"); // not code-entry
    expect(signIn).toHaveBeenCalledWith("a@b.com");
  });

  it("locked-row-tap sign-in continues to the paywall after verify (purchase intent, AE1)", async () => {
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth(), persistence });
    c.lockedTap(); // signed out on a purchasable host → sign-in first, intent recorded
    expect(c.signInOpen).toBe(true);
    expect(c.purchaseIntent).toBe(true);
    expect(persistence.setPurchaseIntent).toHaveBeenCalledWith(true);
    await c.signIn("a@b.com");
    await c.verifyCode("123456");
    expect(c.userId).toBe("user-1");
    expect(c.paywallOpen).toBe(true); // auto-OPENED — checkout still needs its own tap
    expect(c.purchaseFlow).toBe("idle"); // never auto-invokes checkout
    expect(c.purchaseIntent).toBe(false);
    expect(persistence.setPurchaseIntent).toHaveBeenLastCalledWith(false);
  });

  it("'Not now' mid-code-entry clears the pending OTP and the purchase intent", async () => {
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth(), persistence });
    c.lockedTap();
    await c.signIn("a@b.com");
    expect(c.authFlow).toBe("code-entry");
    c.dismissSignIn(); // deliberate exit — unlike popup death, this abandons the flow
    expect(persistence.setPendingOtp).toHaveBeenLastCalledWith(null);
    expect(persistence.setPurchaseIntent).toHaveBeenLastCalledWith(false);
    expect(c.authFlow).toBe("idle");
    expect(c.codeEmail).toBeNull();
    expect(c.purchaseIntent).toBe(false);
  });

  it("'use a different email' returns to the email field but keeps the purchase intent", async () => {
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth(), persistence });
    c.lockedTap();
    await c.signIn("typo@b.com");
    c.useDifferentEmail();
    expect(c.authFlow).toBe("idle");
    expect(c.codeEmail).toBeNull();
    expect(persistence.setPendingOtp).toHaveBeenLastCalledWith(null);
    expect(c.purchaseIntent).toBe(true); // still mid-unlock — only "Not now" abandons it
  });

  it("the opening-checkout hand-off counts as busy (duplicate-tap guard, U3→U4 hook)", () => {
    const { c } = makeController();
    c.purchaseFlow = "opening-checkout";
    expect(c.purchaseBusy).toBe(true);
    expect(c.beginPurchase()).toBe(false); // no second checkout while the tab is opening
  });
});

// ── success payoff (plan U3/R6): one transition rule drives every host ──────────────────────────

describe("UiController — success payoff (plan U3/R6)", () => {
  it("entitled false→true with the paywall open shows the payoff inside the still-open sheet", () => {
    const { c } = makeController();
    c.userId = "u";
    c.openPaywall();
    c.setPurchaseOutcome({ outcome: "pending", entitled: false }); // e.g. Ask-to-Buy just approved
    c.entitled = true; // the entitlement store write landed (storage subscription / sync state)
    expect(c.justUnlocked).toBe(true);
    expect(c.paywallOpen).toBe(true); // payoff renders in place; controller dismisses later
    expect(c.purchaseFlow).toBe("idle"); // the payoff supersedes any pending/outcome copy
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
    expect(makeController({ checkout: seam, host: { canPurchase: false } }).c.canWebCheckout).toBe(false);
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
    expect(order.slice(0, 2)).toEqual(["persist-pending", `open:${CHECKOUT_URL}`]);
    expect(seam.setPending).toHaveBeenNthCalledWith(1, { startedAt: t });
    // Best-effort tabId enrichment once the opener resolves (popups usually die before this).
    expect(seam.setPending).toHaveBeenLastCalledWith({ startedAt: t, tabId: 42 });
    // A surviving context (options page) rests in quiet-pending — poll windows start on reopen.
    expect(c.purchaseFlow).toBe("idle");
    expect(c.checkoutFlow).toBe("quiet-pending");
  });

  it("409 already-entitled → reconcile invoked → payoff after the entitled write; never an error (R5/AE4)", async () => {
    const reconcile = vi.fn(() => Promise.resolve<CheckoutReconcileOutcome>("entitled"));
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
      createCheckout: vi.fn(() => Promise.resolve<WebCheckoutOutcome>({ kind: "unavailable" })),
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
      const reconcile = vi.fn(() => Promise.resolve<CheckoutReconcileOutcome>("unknown"));
      const { seam } = checkoutSeam({ reconcile });
      const { c } = makeController({ checkout: seam, clock: () => t });
      c.rehydrateCheckoutPending({ startedAt: t - 60_000 });
      expect(c.checkoutFlow).toBe("checking");
      expect(c.paywallOpen).toBe(true); // the pending presentation is a paywall surface (U3 rule)
      expect(reconcile).toHaveBeenCalledTimes(1); // the window checks immediately on rehydration
      await vi.advanceTimersByTimeAsync(CHECKOUT_POLL_INTERVAL_MS * (CHECKOUT_POLL_MAX - 1));
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
    for (const startedAt of [Number.NaN, Number.POSITIVE_INFINITY, undefined, "yesterday"]) {
      const { c } = makeController({ checkout: seam, clock: () => 5_000 });
      c.rehydrateCheckoutPending({ startedAt: startedAt as number | undefined });
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
      const reconcile = vi.fn(() => Promise.resolve<CheckoutReconcileOutcome>("unknown"));
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
      expect(seam.setPending).toHaveBeenLastCalledWith({ startedAt: t, tabId: 42 });
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
    const { c } = makeController({ checkout: seam, auth: codeAuth(), persistence });
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
      const { c } = makeController({ checkout: seam, auth: codeAuth(), persistence, clock: () => t });
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
    const { c } = makeController({ checkout: seam, auth: codeAuth(), persistence });
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
      const { c } = makeController({ checkout: seam, auth: codeAuth(), clock: () => t });
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

describe("code-flow copy (plan U2/R1)", () => {
  it("never says 'link' anywhere in the code path strings", () => {
    for (const [key, value] of Object.entries(STRINGS.codeAuth)) {
      expect(value.toLowerCase(), `codeAuth.${key}`).not.toContain("link");
    }
  });
});

describe("ratified paywall copy (plan U3/D6/R10)", () => {
  /** Every string leaf of a STRINGS subtree, flattened with its dotted path for failure output. */
  function stringLeaves(node: unknown, path = "STRINGS"): Array<[string, string]> {
    if (typeof node === "string") return [[path, node]];
    if (node && typeof node === "object") {
      return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${path}.${k}`));
    }
    return [];
  }

  it("carries the ratified lines verbatim (D6)", () => {
    expect(STRINGS.paywall.headline).toBe("The rest of the noise, gone too");
    expect(STRINGS.paywall.reassurance).toBe("One payment. Yours forever.");
    expect(STRINGS.paywall.unlocked).toBe("Pro unlocked. Enjoy the quiet.");
    expect(STRINGS.paywall.openingCheckout).toBe("Opening checkout…");
  });

  it("names the three unlocks plainly and keeps sync a named benefit", () => {
    expect(STRINGS.paywall.body).toContain("Instagram Reels");
    expect(STRINGS.paywall.body).toContain("TikTok");
    expect(STRINGS.paywall.body).toContain("Facebook Reels");
    expect(STRINGS.paywall.body).toMatch(/synced/);
  });

  it("no 'on the way' promise survives anywhere — the web purchase path is real now", () => {
    for (const [path, value] of stringLeaves(STRINGS)) {
      expect(value.toLowerCase(), path).not.toContain("on the way");
    }
  });

  it("never ships a web price in the shared strings (3.1.3 — the display price is host-injected)", () => {
    for (const [path, value] of stringLeaves(STRINGS)) {
      expect(value, path).not.toMatch(/[$€£]\s?\d/);
      expect(value, path).not.toMatch(/\b\d+[.,]\d{2}\b/); // anything 1.99-shaped
    }
  });

  it("keeps the paywall launch-real: no YouTube recommendations/comments claims", () => {
    for (const [path, value] of stringLeaves(STRINGS.paywall, "STRINGS.paywall")) {
      expect(value.toLowerCase(), path).not.toMatch(/recommendation|comments/);
    }
  });
});
