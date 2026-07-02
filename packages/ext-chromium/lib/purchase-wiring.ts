import { browser } from "wxt/browser";
import { extensionSupabaseConfig } from "@still/core/sync";
import { STRINGS, type ExtensionPurchaseDeps, type UiController } from "@still/core/ui";
import {
  SESSION_MESSAGE_KIND,
  unavailableResponse,
  type SessionAction,
  type SessionRequest,
  type SessionResponses,
} from "./session-messages.js";

// The popup/options side of the purchase spine (plan U6): builds the ExtensionPurchaseDeps
// injection for createExtensionUiController out of runtime-message closures — the UI contexts are
// thin mirrors, the background owns the Supabase session (R2). Gated by the same build-mode env
// gate as the background's client (fail-safe: no config → no injection → the popup renders the
// explanatory Safari-shaped state, AE7 semantics on an unconfigured build).

/** The web display price for the paywall CTA. Defined HERE, never in shared core strings, so no
 * web price string can reach an Apple-target bundle (3.1.3 anti-steering). Display-only: the real
 * charge amount is fixed server-side by the RevenueCat Web Billing product ($1.99 one-time —
 * docs/monetization-design.md §5); keep the two in step when either changes. */
export const WEB_DISPLAY_PRICE = "$1.99";

/** Send one session message and settle to the structured fail-safe on ANY transport failure
 * (unreachable background, dead worker, undefined response) — never a throw into the UI. */
async function send<A extends SessionAction>(
  request: Extract<SessionRequest, { action: A }>,
): Promise<SessionResponses[A]> {
  const action = request.action as A;
  try {
    const response = (await browser.runtime.sendMessage(request)) as
      | SessionResponses[A]
      | undefined
      | null;
    return response ?? unavailableResponse(action);
  } catch {
    return unavailableResponse(action);
  }
}

/**
 * The ext-chromium injection (undefined when the build has no Supabase config — the plan's
 * fail-safe rule; the pure gate itself is tested in core's extension-setup suite).
 */
export function extensionPurchaseDeps(): ExtensionPurchaseDeps | undefined {
  const config = extensionSupabaseConfig(
    import.meta.env.VITE_SUPABASE_URL as string | undefined,
    import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  );
  if (config === null) return undefined;
  return {
    displayPrice: WEB_DISPLAY_PRICE,
    getState: () => send({ kind: SESSION_MESSAGE_KIND, action: "getState" }),
    auth: {
      requestCode: (email) => send({ kind: SESSION_MESSAGE_KIND, action: "requestCode", email }),
      verifyCode: (email, token) =>
        send({ kind: SESSION_MESSAGE_KIND, action: "verifyCode", email, token }),
      signOut: async () => {
        await send({ kind: SESSION_MESSAGE_KIND, action: "signOut" });
      },
      deleteAccount: async () => {
        const outcome = await send({ kind: SESSION_MESSAGE_KIND, action: "deleteAccount" });
        // Server-first (R8): a failed delete keeps the session, and the UI surfaces the calm
        // shared line — never raw backend text.
        if (outcome !== "deleted") throw new Error(STRINGS.account.deleteError);
      },
    },
    persistence: {
      // Fire-and-forget: chrome.storage queues the write even as the popup dies (U2's
      // "synchronously-enough" contract); the background is the single writer of the records.
      setPendingOtp: (pending) =>
        void send({ kind: SESSION_MESSAGE_KIND, action: "setPendingOtp", pending }),
      setPurchaseIntent: (active) =>
        void send({ kind: SESSION_MESSAGE_KIND, action: "setPurchaseIntent", active }),
    },
    checkout: {
      createCheckout: () => send({ kind: SESSION_MESSAGE_KIND, action: "createCheckout" }),
      openCheckoutTab: async (url) => {
        try {
          const tab = await browser.tabs.create({ url });
          return tab.id ?? undefined;
        } catch {
          return undefined; // the pending flag is already persisted; reopening rehydrates (U4)
        }
      },
      setPending: (pending) =>
        void send({ kind: SESSION_MESSAGE_KIND, action: "setCheckoutPending", pending }),
      reconcile: async () => {
        const outcome = await send({ kind: SESSION_MESSAGE_KIND, action: "reconcile" });
        // The background's no-session answer maps into the controller's re-sign-in vocabulary
        // (a dead session mid-checkout is the U4 auth-required path, never a teardown).
        return outcome === "signed-out" ? "auth-required" : outcome;
      },
    },
  };
}

/**
 * App's `onRestore` prop on web hosts: a web "restore" IS a fresh authenticated reconcile
 * (plan U5 — Web Billing has no store-side restore). An entitled answer needs no handling here:
 * the background's cache write reaches the controller through the entitlement storage watch and
 * fires the payoff (R6 ordering) — this closure only settles the restore button otherwise.
 */
export function restoreHandler(controller: UiController): () => void {
  return () => {
    void send({ kind: SESSION_MESSAGE_KIND, action: "restore" }).then((outcome) => {
      if (outcome === "entitled") return;
      if (outcome === "not-entitled") {
        controller.setRestoreOutcome(false); // honest: nothing to restore on this account
      } else if (outcome === "auth-required" || outcome === "signed-out") {
        controller.reSignInFromCheckout(); // session died: re-sign-in, never teardown (KTD)
      } else {
        // unknown (offline / spine absent): one calm retry line, CTA re-enabled.
        controller.setPurchaseOutcome({ outcome: "unavailable", entitled: false });
      }
    });
  };
}
