import type { UiController } from "../ui/controller.svelte.js";
import type { AppleCredential, PurchaseResult, ReceiptStatusValue } from "../native/bridge.js";
import type { SyncService, SyncState } from "./service.js";

// The Apple session orchestrator — the auth/purchase/entitlement spine of the WKWebView app,
// extracted from the app-webview entrypoint so every branch is unit-testable. The entrypoint stays
// thin wiring: build the deps, forward DOM/App events here.
//
// Purchase-first (plan 2026-07-15-001, Guideline 5.1.1(v)): purchase and restore work with NO
// session — the device's StoreKit receipt is a first-class entitlement authority alongside the
// server (ADR 0003). Sign-in is optional and attaches the receipt to the account for cross-surface
// Pro and settings sync.
//
// Money-flow invariants owned by this module:
//   • Double-charge guard (signed-in): before purchasing, re-enter the session (fresh online
//     reconcile); if the account is already entitled (e.g. bought on the web), never charge again.
//     Signed-out, the native layer's receipt pre-flight (R14) is the equivalent guard.
//   • Purchase success resolves to the SUCCESS SCREEN (R3): signed-out it pitches the optional
//     account; signed-in it confirms sync. The quieter 2.5s payoff remains for non-purchase
//     entitlement transitions (web-bought account signs in here, checkout unlocks on web hosts).
//   • Offline guard: a signed-in user whose entitlement can't be checked online must NOT reach the
//     native purchase — surface a calm retry message instead. (Signed-out purchase needs no server;
//     StoreKit itself fails offline with its own UI.)
//   • Receipt feed (R17): the controller's receiptEntitled is fed from the bridge's receipt reads
//     at boot, after purchase/restore, and on every foreground return (R18 — a signed-out
//     Ask-to-Buy approval resolves through this path).
//   • Attach evaluation (R7): at every session establishment and foreground re-entry — server says
//     not-entitled AND receipt says entitled → attachPurchases → reconcile again (idempotent).
//     Aborted when a teardown intervenes (AE13): the native identity guard is authoritative; the
//     generation snapshot here is defense in depth.
//   • Entitlement mirror: only server-confirmed sync states (state.confirmed) are PROPOSED into the
//     App Group (server lane; the native StampPolicy is the enforcement home, R13). A false
//     proposal is skipped when the last receipt read said entitled — a doomed write the policy
//     would block anyway.
//   • Teardown parity: sign-out and account deletion both reset the native RevenueCat identity,
//     best-effort, without ever stranding a live Supabase session. Receipt-derived Pro SURVIVES
//     teardown (R6): resetToSignedOut clears only the server lane in the controller, and the
//     native policy keeps the receipt-source stamp.

/** The slice of NativeBridge this orchestrator drives — a seam so tests inject a fake. */
export interface AppleSessionBridge {
  readonly available: boolean;
  signInWithApple(): Promise<AppleCredential>;
  configurePurchases(appUserID: string): Promise<void>;
  purchaseStillPro(): Promise<PurchaseResult>;
  restore(): Promise<boolean>;
  receiptStatus(): Promise<ReceiptStatusValue>;
  attachPurchases(): Promise<boolean>;
  price(): Promise<string | null>;
  signOut(): Promise<void>;
  setEntitlement(entitled: boolean): Promise<void>;
}

export interface AppleSessionDeps {
  readonly controller: UiController;
  readonly sync: Pick<SyncService, "onSignedIn" | "signOut" | "deleteAccount">;
  readonly bridge: AppleSessionBridge;
  /** Exchange the native Apple credential for a Supabase session (signInWithIdToken); returns the
   * Supabase user id, or the error message to surface. */
  readonly exchangeAppleCredential: (
    cred: AppleCredential,
  ) => Promise<{ userId: string } | { error: string }>;
}

export interface AppleSession {
  /** Wire as the SyncService onState callback: projects sync state into the controller and
   * proposes server-confirmed entitlement into the App Group for the Safari extension. */
  onSyncState(state: SyncState): void;
  /** Establish a session: RevenueCat re-keyed to the UUID, reconcile + mirror via SyncService, the
   * attach evaluation (R7), paywall price loaded — with the entitlement-pending state shown while
   * reconcile is in flight. */
  enterSession(userId: string): Promise<void>;
  /** Refresh the controller's receipt-entitlement input from the bridge (R17/R18). Boot wiring,
   * post-purchase/restore, and foreground returns call this; safe on hosts with no native port. */
  refreshReceipt(): Promise<ReceiptStatusValue>;
  onSignInWithApple(): Promise<void>;
  /** Email-code sign-in entry (the one live auth path since 2026-07-06): the host's
   * UiAuth.verifyCode closure calls this AFTER the code was exchanged for a Supabase session, and
   * AWAITS it — so the controller's post-verified continuations land on a configured RevenueCat
   * with entitlement + price settled. Side-effect failures are swallowed (extension-session
   * parity: the session exists; onGet / visibility-change re-entry self-heal) — never throw at
   * the sheet. */
  onCodeVerified(userId: string): Promise<void>;
  onGet(): Promise<void>;
  onRestore(): Promise<void>;
  /** Foreground return: refresh the receipt (R18 — resolves a signed-out Ask-to-Buy approval into
   * the success screen) and re-reconcile a signed-in pending purchase. */
  onVisibilityChange(visibility: DocumentVisibilityState): void;
  signOutEverywhere(): Promise<void>;
  deleteAccountEverywhere(): Promise<void>;
}

export function createAppleSession(deps: AppleSessionDeps): AppleSession {
  const { controller, sync, bridge } = deps;
  // A reconcile begun before voluntary teardown may finish after SyncService has emitted its
  // definitive signed-out state. Keep that stale confirmed callback from re-stamping Pro into the
  // App Group — and keep an in-flight attach evaluation from firing after sign-out (AE13); the
  // next enterSession adopts the new generation normally.
  let teardownGeneration = 0;
  let activeSessionGeneration = 0;
  let activeSessionUserId: string | null = null;
  // The last receipt verdict this session observed — the mirror-skip input (a doomed server-lane
  // false is not proposed when the device provably owns Pro).
  let lastReceiptStatus: ReceiptStatusValue = "noSignal";

  const refreshReceipt = async (): Promise<ReceiptStatusValue> => {
    if (!bridge.available) return "noSignal";
    try {
      const status = await bridge.receiptStatus();
      lastReceiptStatus = status;
      if (status === "entitled") {
        if (controller.purchaseFlow === "pending") {
          // A pending (Ask-to-Buy) purchase resolved out-of-band — session or not (R18/AE9).
          // Route to the success screen BEFORE the entitled flip so the payoff stays suppressed.
          controller.showPurchaseSuccess();
        }
        controller.receiptEntitled = true;
      } else if (status === "verifiedNotEntitled") {
        // Only an AFFIRMATIVE revocation clears the receipt lane. A resolved noSignal (deadline,
        // unverifiable, malformed reply) is ambiguity and never downgrades — the tri-state
        // contract (ReceiptStatus.swift, bridge.ts, R6); this mirrors the catch path below.
        controller.receiptEntitled = false;
      }
      return status;
    } catch {
      // A rejected read is ambiguity: keep the last UI state (never downgrade on noise).
      return "noSignal";
    }
  };

  const enterSession = async (userId: string): Promise<void> => {
    const generationAtEntry = teardownGeneration; // AE13: abort side effects if teardown intervenes
    activeSessionGeneration = teardownGeneration;
    activeSessionUserId = userId;
    controller.reconciling = true;
    try {
      if (bridge.available) await bridge.configurePurchases(userId);
      await sync.onSignedIn(userId);
      // Attach evaluation (R7): the account lacks the entitlement but this device's receipt proves
      // it → attach (RevenueCat syncPurchases, natively gated) → reconcile again so the webhook-
      // written server truth lands in-session. Idempotent: a second pass finds the server entitled.
      if (
        bridge.available &&
        !controller.serverEntitled &&
        teardownGeneration === generationAtEntry
      ) {
        const receipt = await refreshReceipt();
        if (receipt === "entitled" && teardownGeneration === generationAtEntry) {
          const attached = await bridge.attachPurchases();
          if (attached && teardownGeneration === generationAtEntry) {
            await sync.onSignedIn(userId);
          }
        }
      }
      // Load the localized store price for the paywall CTA (fire-and-forget). The signed-out
      // paywall's price is loaded at boot wiring (main.ts) — this refresh covers re-keying.
      if (bridge.available) {
        void bridge
          .price()
          .then((p) => (controller.paywallPrice = p))
          .catch(() => {
            /* price stays at its last value — the CTA renders without a suffix */
          });
      }
    } finally {
      controller.reconciling = false;
    }
  };

  return {
    onSyncState(state: SyncState): void {
      if (
        teardownGeneration !== 0 &&
        state.userId !== null &&
        (activeSessionGeneration !== teardownGeneration || state.userId !== activeSessionUserId)
      ) return;
      controller.userId = state.userId;
      controller.entitled = state.entitled;
      controller.cloudReachable = state.cloudReachable;
      // Propose the entitlement into the App Group so the Safari extension's content scripts gate
      // Pro blocking on it. Only server-CONFIRMED states are proposed: onSignedIn's provisional
      // emit has cloudReachable true but entitled still a cold-resume guess (false), which must not
      // overwrite a valid cached Pro record before the reconcile answers. And an offline cached
      // value must not refresh the App-Group stamp, or the 30-day offline TTL never runs.
      // A false proposal over a receipt-entitled device is skipped here (defense in depth) — the
      // native StampPolicy (the R13 enforcement home) would block it and restamp receipt-true.
      if (bridge.available && state.confirmed && state.cloudReachable) {
        if (state.entitled || lastReceiptStatus !== "entitled") {
          void bridge.setEntitlement(state.entitled).catch(() => {
            /* best-effort — the next sync state change retries */
          });
        }
      }
    },

    enterSession,
    refreshReceipt,

    async onCodeVerified(userId: string): Promise<void> {
      try {
        await enterSession(userId);
      } catch {
        // The Supabase session is real even when a bootstrap side effect (configurePurchases /
        // reconcile / mirror) failed; onGet and onVisibilityChange re-enter the session, so the
        // next purchase tap or foreground return self-heals. Extension-session verifyCode makes
        // the same call ("never throw at the popup").
      }
    },

    async onSignInWithApple(): Promise<void> {
      controller.authFlow = "sending";
      controller.authError = null;
      try {
        const cred = await bridge.signInWithApple();
        const outcome = await deps.exchangeAppleCredential(cred);
        if ("error" in outcome) {
          controller.authFlow = "error";
          controller.authError = outcome.error;
          return;
        }
        controller.authFlow = "idle";
        await enterSession(outcome.userId);
      } catch (e) {
        controller.authFlow = "error";
        controller.authError = e instanceof Error ? e.message : String(e);
      }
    },

    async onGet(): Promise<void> {
      try {
        if (controller.userId) {
          await enterSession(controller.userId);
          if (controller.entitled) {
            // Already unlocked (e.g. bought on the web, or the attach evaluation just landed it) —
            // never charge a second time. The entitled false→true transition inside enterSession
            // showed the payoff with the paywall open; the controller owns its dismissal.
            return;
          }
          if (!controller.cloudReachable) {
            controller.setPurchaseOutcome({
              outcome: "failed",
              entitled: false,
              error: "Couldn't check your account online. Try again when connected.",
            });
            return;
          }
        }
        // Signed out, this proceeds directly (purchase-first, R1): the native layer pre-flights
        // the receipt (R14) and verifies the anonymous identity (R15).
        const result = await bridge.purchaseStillPro();
        if (result.outcome === "purchased") {
          // The receipt is the device authority (R5): success resolves NOW — signed-out to the
          // account pitch, signed-in to the sync confirmation (R3). The receipt refresh feeds the
          // entitled state and the native side already restamped the App Group.
          controller.showPurchaseSuccess();
          await refreshReceipt();
          if (controller.userId) {
            // Attach + server confirmation for the signed-in buyer (fire the spine; the success
            // screen is already up and does not depend on the webhook landing).
            await enterSession(controller.userId);
          }
          return;
        }
        // Surface every other outcome (cancelled/pending/staleIdentity/failed/no-offering) in the
        // still-open paywall.
        controller.setPurchaseOutcome(result);
      } catch (e) {
        // A rejected native call must resolve the flow to a visible failed state — never leave the
        // CTA stuck disabled in "purchasing".
        controller.setPurchaseOutcome({
          outcome: "failed",
          entitled: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },

    async onRestore(): Promise<void> {
      try {
        const restored = await bridge.restore();
        if (!controller.userId) {
          // Signed-out restore (R4/AE11): the native pre-flight answered from the receipt when the
          // device owns Pro (no RevenueCat transfer risk); feed the receipt state and resolve.
          await refreshReceipt();
          controller.setRestoreOutcome(restored);
          return;
        }
        controller.setRestoreOutcome(restored);
        if (restored) {
          await enterSession(controller.userId);
          if (!controller.entitled) {
            controller.setPurchaseOutcome({ outcome: "pending", entitled: false });
          }
          // else: the entitled transition showed the payoff — controller-owned dismissal.
        }
      } catch {
        controller.setRestoreOutcome(false); // a rejected restore unsticks the CTA
      }
    },

    onVisibilityChange(visibility: DocumentVisibilityState): void {
      if (visibility !== "visible") return;
      // Always refresh the receipt on foreground (R18): a signed-out Ask-to-Buy approval or a
      // refund that landed while backgrounded is observed here; refreshReceipt itself resolves a
      // pending flow into the success screen.
      if (bridge.available) {
        void refreshReceipt().then((receipt) => {
          // Attach self-heal on foreground (R7, review finding): a signed-in account that lacks
          // the entitlement this device's receipt proves retries the attach here — otherwise one
          // failed syncPurchases at sign-in strands account Pro on every other surface until a
          // relaunch. Condition is deliberately narrow (receipt-entitled + signed-in +
          // server-not-entitled) so ordinary foregrounds never burn a rate-limited reconcile.
          if (
            receipt === "entitled" &&
            controller.userId &&
            !controller.serverEntitled &&
            !controller.reconciling
          ) {
            void enterSession(controller.userId).catch(() => {
              /* transient — the next foreground or purchase tap retries */
            });
          }
        });
      }
      if (controller.purchaseFlow === "pending" && controller.userId && !controller.reconciling) {
        // A landed approval resolves through the purchase-success rule (a rise while the flow is
        // pending routes to the success screen — controller.applyEntitlementInput).
        void enterSession(controller.userId).catch(() => {
          /* transient — the next foreground retries */
        });
      }
    },

    // Sign-out resets the native RevenueCat identity, but the Supabase session must clear
    // regardless — the native reset is best-effort so a rejected bridge call can't strand a live
    // session. Receipt-derived Pro survives (R6): the native StampPolicy refuses the App-Group
    // downgrade on a receipt-entitled device, and the controller keeps receiptEntitled.
    async signOutEverywhere(): Promise<void> {
      teardownGeneration++;
      if (bridge.available) {
        try {
          await bridge.signOut();
        } catch {
          /* native reset failed — still clear the Supabase session below */
        }
      }
      await sync.signOut();
    },

    // Account deletion deletes server-side + clears the Supabase session first (throws on backend
    // failure → UI surfaces it, session intact), then resets the native RevenueCat identity so the
    // deleted user's app_user_id isn't left configured. Receipt-derived Pro survives deletion too —
    // the purchase belongs to the Apple Account, not the Still account.
    async deleteAccountEverywhere(): Promise<void> {
      await sync.deleteAccount();
      teardownGeneration++;
      if (bridge.available) {
        try {
          await bridge.signOut();
        } catch {
          /* account already deleted + session cleared; native reset is best-effort */
        }
      }
    },
  };
}
