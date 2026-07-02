import type { UiController } from "../ui/controller.svelte.js";
import type { AppleCredential, PurchaseResult } from "../native/bridge.js";
import type { SyncService, SyncState } from "./service.js";

// The Apple session orchestrator — the auth/purchase/entitlement spine of the WKWebView app,
// extracted from the app-webview entrypoint so every branch is unit-testable (it used to live as
// closures over module scope, reachable only by running the app). The entrypoint stays thin
// wiring: build the deps, forward DOM/App events here.
//
// Money-flow invariants owned by this module:
//   • Double-charge guard: before purchasing, re-enter the session (fresh online reconcile); if the
//     account is already entitled (e.g. bought on the web), never charge again.
//   • Unlock payoff, not force-dismiss (U3/R6): every server-confirmed unlock lands here as the
//     controller's `entitled` flipping false→true inside enterSession — with the paywall open,
//     that transition shows "Pro unlocked. Enjoy the quiet." and the controller owns the dismissal.
//     This module no longer calls dismissPaywall() at its entitled call sites.
//   • Offline guard: a signed-in user whose entitlement can't be checked online must NOT reach the
//     native purchase — surface a calm retry message instead.
//   • Local purchase success is feedback, not authority: Pro UI requires the webhook→Supabase→
//     reconcile round-trip; until it lands the paywall shows "pending".
//   • Entitlement mirror: only server-confirmed sync states (cloudReachable) are mirrored into the
//     App Group — an offline cached value must not refresh the Safari extension's 30-day TTL stamp.
//   • Teardown parity: sign-out and account deletion both reset the native RevenueCat identity,
//     best-effort, without ever stranding a live Supabase session (KTD5).

/** The slice of NativeBridge this orchestrator drives — a seam so tests inject a fake. */
export interface AppleSessionBridge {
  readonly available: boolean;
  signInWithApple(): Promise<AppleCredential>;
  configurePurchases(appUserID: string): Promise<void>;
  purchaseStillPro(): Promise<PurchaseResult>;
  restore(): Promise<boolean>;
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
  /** Wire as the SyncService onState callback: projects sync state into the controller and mirrors
   * server-confirmed entitlement into the App Group for the Safari extension. */
  onSyncState(state: SyncState): void;
  /** Establish a session: RevenueCat keyed to the UUID (KTD5), reconcile + mirror via SyncService,
   * paywall price loaded — with the entitlement-pending state shown while reconcile is in flight. */
  enterSession(userId: string): Promise<void>;
  onSignInWithApple(): Promise<void>;
  onGet(): Promise<void>;
  onRestore(): Promise<void>;
  /** Ask-to-Buy: a "pending" purchase is approved out-of-band; re-reconcile on return to the
   * foreground so the entitlement lands in-session, not only on relaunch. */
  onVisibilityChange(visibility: DocumentVisibilityState): void;
  signOutEverywhere(): Promise<void>;
  deleteAccountEverywhere(): Promise<void>;
}

export function createAppleSession(deps: AppleSessionDeps): AppleSession {
  const { controller, sync, bridge } = deps;

  const enterSession = async (userId: string): Promise<void> => {
    controller.reconciling = true;
    try {
      if (bridge.available) await bridge.configurePurchases(userId);
      await sync.onSignedIn(userId);
      // Load the localized store price for the paywall CTA (fire-and-forget — RevenueCat is
      // configured now, so the offering price is available; the CTA shows it instead of a guess).
      if (bridge.available) void bridge.price().then((p) => (controller.paywallPrice = p));
    } finally {
      controller.reconciling = false;
    }
  };

  return {
    onSyncState(state: SyncState): void {
      controller.userId = state.userId;
      controller.entitled = state.entitled;
      controller.cloudReachable = state.cloudReachable;
      // Mirror the entitlement into the App Group so the Safari extension's content scripts gate
      // Pro blocking on it. Only server-confirmed states are mirrored (cloudReachable): an offline
      // cached value must not refresh the App-Group stamp, or the 30-day offline TTL never runs.
      if (bridge.available && state.cloudReachable) {
        void bridge.setEntitlement(state.entitled).catch(() => {
          /* best-effort — the next sync state change retries */
        });
      }
    },

    enterSession,

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
            // Already unlocked (e.g. bought on the web, AE4) — never charge a second time. The
            // entitled false→true transition inside enterSession showed the payoff with the
            // paywall open; the controller owns its dismissal (U3/R6) — no force-dismiss here.
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
        const result = await bridge.purchaseStillPro();
        // Surface every outcome (cancelled/pending/failed/no-offering) in the still-open paywall.
        controller.setPurchaseOutcome(result);
        // The webhook writes the Supabase entitlement; re-reconcile before unlocking into Pro.
        // Local RevenueCat CustomerInfo is immediate feedback, not authority for Pro gating.
        if (result.entitled && controller.userId) {
          await enterSession(controller.userId);
          if (!controller.entitled) {
            controller.setPurchaseOutcome({ outcome: "pending", entitled: false });
          }
          // else: the server-confirmed transition showed the payoff; the controller dismisses
          // after it (U3/R6) — no force-dismiss here.
        }
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
        controller.setRestoreOutcome(restored);
        if (restored && controller.userId) {
          await enterSession(controller.userId);
          if (!controller.entitled) {
            controller.setPurchaseOutcome({ outcome: "pending", entitled: false });
          }
          // else: the entitled transition showed the payoff — controller-owned dismissal (U3/R6).
        }
      } catch {
        controller.setRestoreOutcome(false); // a rejected restore unsticks the CTA
      }
    },

    onVisibilityChange(visibility: DocumentVisibilityState): void {
      if (
        visibility === "visible" &&
        controller.purchaseFlow === "pending" &&
        controller.userId &&
        !controller.reconciling
      ) {
        // A landed approval flips controller.entitled inside enterSession — the false→true
        // transition with the (pending) paywall open shows the payoff and the controller
        // dismisses after it (U3/R6); no dismissPaywall() here.
        void enterSession(controller.userId);
      }
    },

    // Sign-out resets the native RevenueCat identity, but the Supabase session must clear
    // regardless — the native reset is best-effort so a rejected bridge call can't strand a live
    // session (KTD5).
    async signOutEverywhere(): Promise<void> {
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
    // deleted user's app_user_id isn't left configured.
    async deleteAccountEverywhere(): Promise<void> {
      await sync.deleteAccount();
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
