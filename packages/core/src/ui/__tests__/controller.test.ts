import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OTP_TTL_MS, type UiAuth, type UiController } from "../controller.svelte.js";
import type {
  RequestCodeOutcome,
  VerifyCodeOutcome,
} from "../../sync/ports.js";
import { STRINGS } from "../strings.js";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import {
  makeController,
  codeAuth,
  mockPersistence,
  checkoutSeam,
} from "./support/controller-fixtures.js";

// The paid tier ships dormant, so the controller refuses to open the paywall and the tests that
// drive it cannot run here. `paidTierIt` is how those cases are held rather than deleted: they are
// skipped in this run and come back the moment the switch flips. The purchase machinery they used
// to share this file with now lives in paid-tier-purchase-flows.test.ts, which mocks the switch on
// so that coverage keeps running every day. Anything still marked `paidTierIt` below is genuinely
// dark until the flip.
const paidTierIt = it.runIf(PAID_TIER_ENABLED);
const includedAccessIt = it.runIf(!PAID_TIER_ENABLED);


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

  includedAccessIt("keeps all service rows unlocked and refuses the upgrade path while the paid tier is off", () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    const { c } = makeController({ auth: codeAuth(), checkout: checkoutSeam().seam });
    expect(c.isLocked("youtube")).toBe(false);
    expect(c.isLocked("instagram")).toBe(false);
    expect(c.isLocked("tiktok")).toBe(false);
    expect(c.isLocked("facebook")).toBe(false);

    c.startUpgrade();
    expect(c.paywallOpen).toBe(false);
    expect(c.signInOpen).toBe(false);
    expect(c.purchaseIntent).toBe(false);
  });

  includedAccessIt("still resolves an earlier purchaser's entitlement while the paid tier is off", () => {
    // Nothing about an existing purchase is revoked, migrated, or cleaned up by the switch: the
    // receipt lane and the server lane keep answering, so the account states the UI shows for a
    // buyer are exactly what they were.
    const { c } = makeController({ auth: codeAuth() });
    c.receiptEntitled = true;
    expect(c.entitled).toBe(true);
    expect(c.popupState).toBe("pro-no-account");

    c.userId = "u";
    c.entitled = true;
    expect(c.popupState).toBe("entitled-syncing");
    expect(c.isLocked("instagram")).toBe(false);
  });

  includedAccessIt("refuses every route into the paywall while the paid tier is dormant", () => {
    // Hiding the sheet is not enough. The routes that open it also start the machinery behind it,
    // so they are refused at the entry point rather than at the render.
    const { c } = makeController({ auth: codeAuth() });
    c.openPaywall();
    expect(c.paywallOpen).toBe(false);
    c.showPurchaseSuccess();
    expect(c.paywallOpen).toBe(false);
    expect(c.successScreen).toBe("none");
  });

  includedAccessIt("clears a leftover checkout-pending record instead of polling behind a hidden sheet", () => {
    // The defect this pins: a user who abandoned a checkout on an older build would otherwise
    // start a repeating entitlement check on every popup open, with no visible way to stop it,
    // for a purchase that can no longer complete.
    const { seam } = checkoutSeam();
    const now = 1_700_000_000_000;
    const { c } = makeController({ checkout: seam, clock: () => now });
    c.userId = "u";
    c.rehydrateCheckoutPending({ startedAt: now });
    expect(c.checkoutFlow).toBe("none");
    expect(c.paywallOpen).toBe(false);
    expect(seam.setPending).toHaveBeenCalledWith(null); // cleared for good, not just this session
    expect(seam.reconcile).not.toHaveBeenCalled(); // and no network call was made to notice it
  });

  includedAccessIt("an entitlement rise arms no payoff timer while the paid tier is dormant", () => {
    vi.useFakeTimers();
    try {
      const { seam } = checkoutSeam();
      const now = 1_700_000_000_000;
      const { c } = makeController({ checkout: seam, clock: () => now });
      c.userId = "u";
      c.rehydrateCheckoutPending({ startedAt: now }); // the old route to an armed payoff
      c.openPaywall();
      c.entitled = true;
      expect(c.justUnlocked).toBe(false);
      expect(vi.getTimerCount()).toBe(0); // nothing scheduled against UI nobody can see
    } finally {
      vi.useRealTimers();
    }
  });

  paidTierIt("locks Pro services for un-entitled users and unlocks them when entitled", () => {
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

  paidTierIt("locked tap routes signed-out WEB-checkout users to sign-in first (delivery identity)", () => {
    // Sign-in-first survives ONLY on web-checkout hosts, where the account is how the entitlement
    // reaches the extension. Native-purchase hosts go straight to the paywall (purchase-first,
    // Guideline 5.1.1(v)) — pinned separately below.
    const { c } = makeController({
      auth: {
        signIn: vi.fn(() => Promise.resolve({})),
        signOut: vi.fn(() => Promise.resolve()),
      },
      checkout: checkoutSeam().seam,
    });
    c.lockedTap();
    expect(c.signInOpen).toBe(true);
    expect(c.paywallOpen).toBe(false);
  });

  paidTierIt("locked tap opens the paywall directly on native-purchase hosts, signed out (R1)", () => {
    // The Apple shape: canPurchase with NO checkout seam. Purchase requires no account.
    const { c } = makeController({ auth: codeAuth() });
    c.lockedTap();
    expect(c.paywallOpen).toBe(true);
    expect(c.signInOpen).toBe(false);
    expect(c.purchaseIntent).toBe(false);
  });

  paidTierIt("locked tap opens the paywall for signed-in users", () => {
    const { c } = makeController({
      auth: {
        signIn: vi.fn(() => Promise.resolve({})),
        signOut: vi.fn(() => Promise.resolve()),
      },
    });
    c.userId = "u";
    c.lockedTap();
    expect(c.paywallOpen).toBe(true);
    expect(c.signInOpen).toBe(false);
  });

  paidTierIt("locked tap opens the (explanatory) paywall on hosts without a purchase path", () => {
    const { c } = makeController({ host: { canPurchase: false } }); // extension shape: no auth either
    c.lockedTap();
    expect(c.paywallOpen).toBe(true);
    expect(c.signInOpen).toBe(false);
  });

  paidTierIt("signed-out upgrade records purchase intent and opens sign-in (web-checkout host)", () => {
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth(), persistence, checkout: checkoutSeam().seam });
    c.startUpgrade();
    expect(c.purchaseIntent).toBe(true);
    expect(persistence.setPurchaseIntent).toHaveBeenCalledWith(true);
    expect(c.signInOpen).toBe(true);
    expect(c.paywallOpen).toBe(false);
  });

  paidTierIt("signed-in upgrade opens the paywall directly", () => {
    const { c } = makeController({ auth: codeAuth() });
    c.userId = "u";
    c.startUpgrade();
    expect(c.paywallOpen).toBe(true);
    expect(c.signInOpen).toBe(false);
    expect(c.purchaseIntent).toBe(false);
  });

  it("startUpgrade no-ops when already entitled (out-of-band callers)", () => {
    // The rendered CTAs are already gated off for Pro users; this pins the method's own guard
    // for callers that bypass the UI gating (scripts, future surfaces).
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth(), persistence });
    c.entitled = true;
    c.startUpgrade();
    expect(c.paywallOpen).toBe(false);
    expect(c.signInOpen).toBe(false);
    expect(c.purchaseIntent).toBe(false);
    expect(persistence.setPurchaseIntent).not.toHaveBeenCalled();
  });

  paidTierIt("upgrade continuation skips the buy sheet when sign-in already unlocked Pro", async () => {
    // A signed-out but already-Pro account taps Upgrade → sign-in. On the Apple host the awaited
    // verifyCode reconciles entitlement before returning, so the purchase-intent continuation
    // must not open a paywall the user has nothing to buy from.
    const persistence = mockPersistence();
    let ref: UiController | null = null;
    const auth = codeAuth({
      verifyCode: vi.fn(() => {
        ref!.entitled = true; // the host's reconcile landed inside the awaited verify
        return Promise.resolve<VerifyCodeOutcome>({
          kind: "verified",
          userId: "user-1",
        });
      }),
    });
    const { c } = makeController({ auth, persistence, checkout: checkoutSeam().seam });
    ref = c;
    c.startUpgrade(); // signed out on a purchasable host → intent + sign-in
    expect(c.signInOpen).toBe(true);
    await c.signIn("a@b.com");
    await c.verifyCode("123456");
    expect(c.userId).toBe("user-1");
    expect(c.paywallOpen).toBe(false); // already Pro — no buy sheet
    expect(c.purchaseIntent).toBe(false); // the intent was still consumed
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
    const { c } = makeController({
      auth: { signIn, signOut: vi.fn(() => Promise.resolve()) },
    });
    const pending = c.signIn("a@b.com");
    expect(c.authFlow).toBe("sending");
    await pending;
    expect(c.authFlow).toBe("sent");
    expect(signIn).toHaveBeenCalledWith("a@b.com");
  });

  it("ignores a syntactically invalid email without issuing a magic-link request", async () => {
    const signIn = vi.fn(() => Promise.resolve({}));
    const { c } = makeController({
      auth: { signIn, signOut: vi.fn(() => Promise.resolve()) },
    });
    for (const bad of ["", "  ", "nope", "a@b", "a@b.", "@b.com", "a b@c.com"]) {
      await c.signIn(bad);
    }
    expect(signIn).not.toHaveBeenCalled();
    expect(c.authFlow).toBe("idle");
    expect(c.authError).toBeNull();
  });

  it("ignores a syntactically invalid email without requesting a code (code host)", async () => {
    const auth = codeAuth();
    const { c } = makeController({ auth });
    await c.signIn("not-an-email");
    expect(auth.requestCode).not.toHaveBeenCalled();
    expect(c.authFlow).toBe("idle");
  });

  it("surfaces an auth error", async () => {
    const { c } = makeController({
      auth: {
        signIn: () => Promise.resolve({ error: "rate limited" }),
        signOut: vi.fn(() => Promise.resolve()),
      },
    });
    await c.signIn("a@b.com");
    expect(c.authFlow).toBe("error");
    expect(c.authError).toBe("rate limited");
  });

  it("signOut clears local state and resets the purchase flow even when auth.signOut throws", async () => {
    const { c } = makeController({
      auth: {
        signIn: () => Promise.resolve({}),
        signOut: () => Promise.reject(new Error("network")),
      },
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
    const without = makeController({
      auth: { signIn: () => Promise.resolve({}), signOut: vi.fn() },
    });
    expect(without.c.canDeleteAccount).toBe(false);
    const withDel = makeController({
      auth: deletableAuth(vi.fn(() => Promise.resolve())),
    });
    expect(withDel.c.canDeleteAccount).toBe(true);
  });

  it("delete flow: request → confirming, cancel → idle", () => {
    const { c } = makeController({
      auth: deletableAuth(vi.fn(() => Promise.resolve())),
    });
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
    c.setPurchaseOutcome({
      outcome: "failed",
      entitled: false,
      error: "network down",
    });
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
    expect(persistence.setPendingOtp).toHaveBeenCalledWith({
      email: "a@b.com",
      requestedAt: t,
    });
    c.dismissSignIn(); // stop the cooldown ticker
  });

  it("requestCode failure shows the calm error state with no raw error text", async () => {
    const auth = codeAuth({
      requestCode: vi.fn(() =>
        Promise.resolve<RequestCodeOutcome>({ kind: "send-failed" }),
      ),
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
    const { c } = makeController({
      auth: codeAuth({ verifyCode }),
      clock: () => t,
    });
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
      () =>
        new Promise<VerifyCodeOutcome>((resolve) => (resolveVerify = resolve)),
    );
    const persistence = mockPersistence();
    const { c } = makeController({
      auth: codeAuth({ verifyCode }),
      persistence,
    });
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
      () =>
        new Promise<RequestCodeOutcome>((resolve) => (resolveSend = resolve)),
    );
    const persistence = mockPersistence();
    const { c } = makeController({
      auth: codeAuth({ requestCode }),
      persistence,
    });
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
          () =>
            new Promise<RequestCodeOutcome>(
              (resolve) => (resolveResend = resolve),
            ),
        );
      const { c } = makeController({
        auth: codeAuth({ requestCode }),
        clock: () => t,
      });
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
    c.rehydrateCodeEntry({
      email: "saved@b.com",
      requestedAt: t - 10_000,
      purchaseIntent: true,
    });
    expect(c.authFlow).toBe("code-entry");
    expect(c.signInOpen).toBe(true);
    expect(c.codeEmail).toBe("saved@b.com");
    expect(c.resendCooldown).toBe(50); // countdown restored from the original request time
    expect(c.purchaseIntent).toBe(true);
    c.dismissSignIn();
  });

  it("an Apple-shaped UiAuth (no code capability) keeps the magic-link flow unchanged", async () => {
    const signIn = vi.fn(() => Promise.resolve({}));
    const { c } = makeController({
      auth: { signIn, signOut: vi.fn(() => Promise.resolve()) },
    });
    expect(c.canUseCode).toBe(false);
    await c.signIn("a@b.com");
    expect(c.authFlow).toBe("sent"); // not code-entry
    expect(signIn).toHaveBeenCalledWith("a@b.com");
  });

  paidTierIt("locked-row-tap sign-in continues to the paywall after verify (purchase intent, AE1)", async () => {
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth(), persistence, checkout: checkoutSeam().seam });
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

  paidTierIt("'Not now' mid-code-entry clears the pending OTP and the purchase intent", async () => {
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth(), persistence, checkout: checkoutSeam().seam });
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

  paidTierIt("'use a different email' returns to the email field but keeps the purchase intent", async () => {
    const persistence = mockPersistence();
    const { c } = makeController({ auth: codeAuth(), persistence, checkout: checkoutSeam().seam });
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


describe("code-flow copy (plan U2/R1)", () => {
  it("never says 'link' anywhere in the code path strings", () => {
    for (const [key, value] of Object.entries(STRINGS.codeAuth)) {
      expect(value.toLowerCase(), `codeAuth.${key}`).not.toContain("link");
    }
  });
});

describe("ratified paywall copy (plan U3/D6/R10)", () => {
  /** Every string leaf of a STRINGS subtree, flattened with its dotted path for failure output. */
  function stringLeaves(
    node: unknown,
    path = "STRINGS",
  ): Array<[string, string]> {
    if (typeof node === "string") return [[path, node]];
    if (node && typeof node === "object") {
      return Object.entries(node).flatMap(([k, v]) =>
        stringLeaves(v, `${path}.${k}`),
      );
    }
    return [];
  }

  it("carries the ratified lines verbatim (D6)", () => {
    expect(STRINGS.paywall.headline).toBe(
      "Make every supported browser feel this quiet",
    );
    expect(STRINGS.paywall.reassurance).toBe(
      "One purchase. No subscription.",
    );
    expect(STRINGS.paywall.unlocked).toBe("Your quieter web is ready.");
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
    for (const [path, value] of stringLeaves(
      STRINGS.paywall,
      "STRINGS.paywall",
    )) {
      expect(value.toLowerCase(), path).not.toMatch(/recommendation|comments/);
    }
  });
});


// Rate-limit wait states (plan 2026-07-15-002 U2, R2/R3/R4): a GoTrue 429 must render a truthful
// wait with the matching affordance LOCKED — the old collapse into generic "try again" copy
// invited hammering the very limit that fired (the leading suspects for the 2.1(a) rejection).

describe("rate-limited send/verify wait states (R2/R3/R4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a rate-limited FIRST send locks the email view for 60s, then unblocks clean (AE1)", async () => {
    let t = 1_000_000;
    const requestCode = vi.fn(() =>
      Promise.resolve<RequestCodeOutcome>({ kind: "send-rate-limited" }),
    );
    const { c } = makeController({ auth: codeAuth({ requestCode }), clock: () => t });
    await c.signIn("a@b.com");
    expect(c.authFlow).toBe("error");
    expect(c.sendBlockRemaining).toBe(60);

    await c.signIn("a@b.com"); // locked — no second network call (programmatic guard, R2)
    expect(requestCode).toHaveBeenCalledTimes(1);

    t += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(c.sendBlockRemaining).toBe(0);
    expect(c.authFlow).toBe("idle"); // the lock's elapse clears the wait presentation, not a stale error

    requestCode.mockResolvedValueOnce({ kind: "sent" });
    await c.signIn("a@b.com"); // re-enabled
    expect(requestCode).toHaveBeenCalledTimes(2);
    expect(c.authFlow).toBe("code-entry");
    c.dismissSignIn();
  });

  it("a rate-limited RESEND locks the resend affordance and never touches expiry state (AE2)", async () => {
    let t = 1_000_000;
    const auth = codeAuth();
    const persistence = mockPersistence();
    const { c } = makeController({ auth, persistence, clock: () => t });
    await c.signIn("a@b.com");
    const persistCalls = (persistence.setPendingOtp as ReturnType<typeof vi.fn>).mock.calls.length;

    t += 60_000;
    vi.advanceTimersByTime(60_000); // ordinary cooldown elapses
    (auth.requestCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: "send-rate-limited",
    });
    await c.resendCode();
    expect(c.codeErrorKind).toBe("resend-rate-limited");
    expect(c.sendBlockRemaining).toBe(60);
    expect(persistence.setPendingOtp).toHaveBeenCalledTimes(persistCalls); // pendingOtp untouched — expiry classification unaffected

    await c.resendCode(); // locked — no instant re-tap 429 (R4)
    expect(auth.requestCode).toHaveBeenCalledTimes(2);

    t += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(c.codeErrorKind).toBe(null); // the lock's elapse clears its own line
    await c.resendCode();
    expect(auth.requestCode).toHaveBeenCalledTimes(3);
    c.dismissSignIn();
  });

  it("a rate-limited verify is NOT an attempt, outranks suggestNewCode, and locks the button (AE3)", async () => {
    let t = 1_000_000;
    const verifyCode = vi.fn(() =>
      Promise.resolve<VerifyCodeOutcome>({ kind: "invalid-code" }),
    );
    const { c } = makeController({ auth: codeAuth({ verifyCode }), clock: () => t });
    await c.signIn("a@b.com");
    await c.verifyCode("111111");
    await c.verifyCode("222222");
    await c.verifyCode("333333");
    expect(c.suggestNewCode).toBe(true);

    verifyCode.mockResolvedValueOnce({ kind: "verify-rate-limited" });
    await c.verifyCode("444444");
    expect(c.codeErrorKind).toBe("verify-rate-limited"); // the sheet renders this ABOVE requestNew
    expect(c.codeAttempts).toBe(3); // not an attempt — the code was never judged
    expect(c.verifyBlockRemaining).toBe(60);

    await c.verifyCode("444444"); // locked — no network call
    expect(verifyCode).toHaveBeenCalledTimes(4);

    t += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(c.verifyBlockRemaining).toBe(0);
    expect(c.codeErrorKind).toBe(null); // self-clears into a retryable state
    c.dismissSignIn();
  });

  it("a transport-supplied retryAfterSeconds drives a genuine countdown (review path)", async () => {
    let t = 1_000_000;
    const verifyCode = vi.fn(() =>
      Promise.resolve<VerifyCodeOutcome>({ kind: "verify-rate-limited", retryAfterSeconds: 5 }),
    );
    const { c } = makeController({ auth: codeAuth({ verifyCode }), clock: () => t });
    await c.signIn("a@b.com");
    await c.verifyCode("123456");
    expect(c.verifyBlockRemaining).toBe(5);
    t += 5_000;
    vi.advanceTimersByTime(5_000);
    expect(c.verifyBlockRemaining).toBe(0);
    c.dismissSignIn();
  });

  it("dismissing during an ACTIVE verify lock clears the timer — no leak, no lingering countdown", async () => {
    let t = 1_000_000;
    const verifyCode = vi.fn(() =>
      Promise.resolve<VerifyCodeOutcome>({ kind: "verify-rate-limited", retryAfterSeconds: 60 }),
    );
    const { c } = makeController({ auth: codeAuth({ verifyCode }), clock: () => t });
    await c.signIn("a@b.com");
    await c.verifyCode("123456");
    expect(c.verifyBlockRemaining).toBe(60);
    c.dismissSignIn(); // mid-lock
    expect(c.verifyBlockRemaining).toBe(0);
    // The interval must be gone: advancing time cannot resurrect a countdown on a dismissed sheet.
    t += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(c.verifyBlockRemaining).toBe(0);
  });

  it("a fresh code delivered during a verify lock still shows the verify-lock reason (no silent disabled button)", async () => {
    // The verify lock is a server-side per-IP throttle a resend does NOT lift, so the verify button
    // stays disabled — but the sheet must keep explaining why even though a successful resend nulled
    // codeErrorKind. codeErrorKind is cleared; verifyBlockRemaining still drives the copy (sheet-side).
    let t = 1_000_000;
    const verifyCode = vi.fn(() =>
      Promise.resolve<VerifyCodeOutcome>({ kind: "verify-rate-limited", retryAfterSeconds: 60 }),
    );
    const { c } = makeController({ auth: codeAuth({ verifyCode }), clock: () => t });
    await c.signIn("a@b.com");
    t += 60_000;
    vi.advanceTimersByTime(60_000); // ordinary resend cooldown elapses (verify lock still ticking below)
    await c.verifyCode("123456");
    expect(c.verifyBlockRemaining).toBe(60);
    await c.resendCode(); // succeeds — a different bucket; nulls codeErrorKind
    expect(c.codeErrorKind).toBe(null);
    expect(c.verifyBlockRemaining).toBeGreaterThan(0); // the verify lock is untouched by the resend
    c.dismissSignIn();
  });

  it("a send lock resolving after a dismissal does not resurrect the sheet state (F6)", async () => {
    let resolveSend!: (v: RequestCodeOutcome) => void;
    const requestCode = vi.fn(
      () => new Promise<RequestCodeOutcome>((r) => (resolveSend = r)),
    );
    const { c } = makeController({ auth: codeAuth({ requestCode }) });
    const p = c.signIn("a@b.com");
    c.dismissSignIn();
    resolveSend({ kind: "send-rate-limited" });
    await p;
    // The generation guard drops the stale result entirely: no lock starts and no error state
    // lands (authFlow may legitimately still read "sending" — dismissal doesn't rewrite it).
    expect(c.sendBlockRemaining).toBe(0);
    expect(c.authFlow).not.toBe("error");
  });
});

describe("stale pending-OTP rehydration (R6)", () => {
  it("a record older than the OTP TTL rehydrates into the expired presentation (AE6)", () => {
    const t = 10_000_000;
    const { c } = makeController({ auth: codeAuth(), clock: () => t });
    c.rehydrateCodeEntry({ email: "a@b.com", requestedAt: t - OTP_TTL_MS - 1 });
    expect(c.authFlow).toBe("code-error");
    expect(c.codeErrorKind).toBe("expired");
    expect(c.resendCooldown).toBe(0); // the remedy is immediately available
    c.dismissSignIn();
  });

  it("a fresh record still lands on live code entry, and a missing requestedAt stays lenient", () => {
    const t = 10_000_000;
    const { c } = makeController({ auth: codeAuth(), clock: () => t });
    c.rehydrateCodeEntry({ email: "a@b.com", requestedAt: t - 1_000 });
    expect(c.authFlow).toBe("code-entry");
    expect(c.codeErrorKind).toBe(null);
    c.dismissSignIn();
    c.rehydrateCodeEntry({ email: "a@b.com" }); // no timestamp — email-only rehydrate, never "expired"
    expect(c.authFlow).toBe("code-entry");
    expect(c.codeErrorKind).toBe(null);
    c.dismissSignIn();
  });
});
