import { describe, it, expect, vi } from "vitest";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import {
  UiController,
  OTP_TTL_MS,
  PAYOFF_DURATION_MS,
  type AuthPersistence,
  type UiAuth,
  type UiHost,
} from "../controller.svelte.js";
import type { RequestCodeOutcome, VerifyCodeOutcome } from "../../sync/ports.js";
import { STRINGS } from "../strings.js";

function makeController(
  extra: {
    host?: Partial<UiHost>;
    auth?: UiAuth;
    persistence?: AuthPersistence;
    clock?: () => number;
  } = {},
) {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { now: () => Date.now() });
  const c = new UiController({
    cache,
    host: { canPurchase: true, currentHost: "youtube.com", ...extra.host },
    auth: extra.auth,
    persistence: extra.persistence,
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
