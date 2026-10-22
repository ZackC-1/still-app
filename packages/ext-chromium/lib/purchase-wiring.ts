import { browser } from "wxt/browser";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import { extensionSupabaseConfig, readAccountDeletionResult, readBackendRouteProfile, type BackendRouteProfile } from "@still/core/sync";
import { STRINGS, type ExtensionPurchaseDeps, type UiController } from "@still/core/ui";
import { DATA_PERMISSION_COPY, type DataPermission } from "@still/core/ui/data-permission";
import { dataPermission } from "./data-permission.js";
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

/** The retired 2.x web price. It is NOT the Still Pro price (V3 Still Pro is $9.99 one-time, D514)
 * and no build may show it. It stays only so builds compiled with the paid tier off keep the
 * shipped 2.x bytes; those builds never mount the paywall that would read it. Builds compiled
 * with PAID_TIER_ENABLED on carry no browser price at all (see `displayPrice` below). Defined
 * HERE, never in shared core strings, so no web price string can reach an Apple-target bundle
 * (3.1.3 anti-steering). */
export const LEGACY_WEB_DISPLAY_PRICE = "$1.99";

/** Send one session message and settle to the structured fail-safe on ANY transport failure
 * (unreachable background, dead worker, undefined response) — never a throw into the UI. */
export type SessionSender = <A extends SessionAction>(
  request: Extract<SessionRequest, { action: A }>,
) => Promise<SessionResponses[A]>;

export interface SessionRuntime {
  sendMessage(request: SessionRequest): Promise<unknown>;
}

export function createSessionSender(runtime: SessionRuntime): SessionSender {
  return async function <A extends SessionAction>(
    request: Extract<SessionRequest, { action: A }>,
  ): Promise<SessionResponses[A]> {
    const action = request.action as A;
    try {
      const response = (await runtime.sendMessage(request)) as SessionResponses[A] | undefined | null;
      // Null is a definitive signed-out status. Transport failures use the registry's explicit
      // unavailable value; preserve other actions' existing null-as-unavailable behavior.
      return response === undefined || (response === null && action !== "getSyncStatus" && action !== "getVerifiedAccount")
        ? unavailableResponse(action)
        : response as SessionResponses[A];
    } catch {
      return unavailableResponse(action);
    }
  };
}

const send: SessionSender = (request) => createSessionSender(browser.runtime)(request);

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
  const routeProfile = readBackendRouteProfile(import.meta.env.VITE_BACKEND_ROUTE_PROFILE);
  if (!routeProfile) return undefined;
  const deps = createExtensionPurchaseDeps(send, routeProfile);
  // Firefox only (the flag folds this away elsewhere): the email address and the purchase status
  // are optional data-collection permissions there.
  return import.meta.env.FIREFOX && dataPermission ? withDataPermission(deps, dataPermission) : deps;
}

/**
 * Firefox: every closure that would send the email address or the Still Pro purchase status checks
 * Firefox's grant again right before it sends, and sends nothing without it. The asking itself
 * happens in the click (the controller and the settings flows call `ask` first); this is the check
 * before each send, so a grant withdrawn in about:addons after the click still stops the send. The
 * background's fetch guard (lib/firefox-data-guard.ts) refuses the same requests once more.
 */
export function withDataPermission(deps: ExtensionPurchaseDeps, permission: DataPermission): ExtensionPurchaseDeps {
  const has = (kind: "email" | "purchase") => permission.granted(kind).catch(() => false);
  return {
    ...deps,
    dataPermission: permission,
    auth: {
      ...deps.auth,
      requestCode: async (email) => ((await has("email")) ? deps.auth.requestCode!(email) : { kind: "send-failed" }),
      verifyCode: async (email, token) =>
        ((await has("email")) ? deps.auth.verifyCode!(email, token) : { kind: "verify-failed" }),
    },
    checkout: {
      ...deps.checkout,
      createCheckout: async () => ((await has("purchase")) ? deps.checkout.createCheckout() : { kind: "unavailable" }),
      // Also the page-open and poll re-checks, which no click starts: without the grant they are
      // simply not made ("unknown" changes nothing).
      reconcile: async () => ((await has("purchase")) ? deps.checkout.reconcile() : "unknown"),
    },
  };
}

/** Build the UI capability injection from a session sender; exported for seam-level translation pins. */
export function createExtensionPurchaseDeps(sendMessage: SessionSender, routeProfile: BackendRouteProfile = "production"): ExtensionPurchaseDeps {
  return {
    // Owner decision (10 October 2026): Chrome and Firefox offer Still Pro with no price; the
    // checkout page shows it. Paid builds therefore pass no price, so the paywall's buy button
    // reads "Get Still Pro" alone and no compiled price reaches them. With the paid tier off this
    // folds to the original expression, keeping the shipped bytes (that build never shows it).
    displayPrice: PAID_TIER_ENABLED
      ? null
      : routeProfile === "shared-hosted-sandbox" ? "$9.99" : LEGACY_WEB_DISPLAY_PRICE,
    getState: () => sendMessage({ kind: SESSION_MESSAGE_KIND, action: "getState" }),
    readAccountStatus: async () => {
      const status = await sendMessage({ kind: SESSION_MESSAGE_KIND, action: "getSyncStatus" });
      if (status === "unavailable") throw new Error("Account sync status is unavailable");
      return status;
    },
    retrySync: async () => {
      const result = await sendMessage({ kind: SESSION_MESSAGE_KIND, action: "retrySync" });
      if (result !== "ok") throw new Error("Sync retry is unavailable");
    },
    auth: {
      currentVerifiedAccount: async () => {
        const account = await sendMessage({ kind: SESSION_MESSAGE_KIND, action: "getVerifiedAccount" });
        if (account === "unavailable") throw new Error("Account confirmation unavailable");
        return account;
      },
      requestCode: (email) => sendMessage({ kind: SESSION_MESSAGE_KIND, action: "requestCode", email }),
      verifyCode: (email, token) =>
        sendMessage({ kind: SESSION_MESSAGE_KIND, action: "verifyCode", email, token }),
      signOut: async () => {
        await sendMessage({ kind: SESSION_MESSAGE_KIND, action: "signOut" });
      },
      deleteAccount: async () => {
        const outcome = await sendMessage({ kind: SESSION_MESSAGE_KIND, action: "deleteAccountWithOutcome" });
        // Server-first (R8): a failed delete keeps the session, and the UI surfaces the calm
        // shared line — never raw backend text.
        const result = readAccountDeletionResult(outcome);
        if (!result) throw new Error(STRINGS.account.deleteError);
        return result;
      },
    },
    persistence: {
      // Fire-and-forget: chrome.storage queues the write even as the popup dies (U2's
      // "synchronously-enough" contract); the background is the single writer of the records.
      setPendingOtp: (pending) =>
        void sendMessage({ kind: SESSION_MESSAGE_KIND, action: "setPendingOtp", pending }),
      setPurchaseIntent: (active) =>
        void sendMessage({ kind: SESSION_MESSAGE_KIND, action: "setPurchaseIntent", active }),
    },
    checkout: {
      createCheckout: () => sendMessage({ kind: SESSION_MESSAGE_KIND, action: "createCheckout" }),
      openCheckoutTab: async (url) => {
        try {
          const tab = await browser.tabs.create({ url });
          return tab.id ?? undefined;
        } catch {
          return undefined; // the pending flag is already persisted; reopening rehydrates (U4)
        }
      },
      setPending: (pending) =>
        void sendMessage({ kind: SESSION_MESSAGE_KIND, action: "setCheckoutPending", pending }),
      reconcile: async () => {
        const outcome = await sendMessage({ kind: SESSION_MESSAGE_KIND, action: "reconcile" });
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
export function restoreHandler(
  controller: UiController,
  sendMessage: SessionSender = send,
  permission: DataPermission | undefined = dataPermission,
): () => void {
  return () => {
    // Firefox: the restore reads the purchase status, so ask inside this tap, before anything else.
    const asked = permission?.ask("purchase");
    void (async () => {
      if (asked && !(await asked.catch(() => false))) {
        // Declined: nothing is sent; the paywall's line says why.
        controller.setPurchaseOutcome({ outcome: "failed", entitled: false, error: DATA_PERMISSION_COPY.purchase });
        return;
      }
      const outcome = await sendMessage({ kind: SESSION_MESSAGE_KIND, action: "restore" });
      if (outcome === "entitled") return;
      if (outcome === "not-entitled") {
        controller.setRestoreOutcome(false); // honest: nothing to restore on this account
      } else if (outcome === "auth-required" || outcome === "signed-out") {
        controller.reSignInFromCheckout(); // session died: re-sign-in, never teardown (KTD)
      } else {
        // unknown (offline / spine absent): one calm retry line, CTA re-enabled.
        controller.setPurchaseOutcome({ outcome: "unavailable", entitled: false });
      }
    })();
  };
}
