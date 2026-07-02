import { SettingsCache, ChromeStorageAdapter } from "../storage/index.js";
import { EntitlementCache, ChromeEntitlementAdapter } from "../entitlement/index.js";
import type { ExtensionSessionState } from "../sync/extension-session.js";
import {
  UiController,
  type AuthPersistence,
  type UiAuth,
  type UiCheckout,
} from "./controller.svelte.js";

// The ONE popup/options wiring every extension build shares (Safari maps the WebExtension storage
// API — Safari 16+ exposes the `chrome` namespace, so the Chrome adapters serve both). The optional
// `purchase` injection (plan U6/R10) is passed ONLY by the ext-chromium entrypoints, carrying the
// email-OTP auth closures, the persistence/checkout seams (backed by runtime messages to the
// background-owned extension session, U5), the host display price, and the background's mount
// snapshot. With NO injection — the Safari build — behavior is unchanged (AE7/3.1.1 pin):
// `canPurchase: false`, no auth, no checkout, no price; the paywall renders its explanatory state.
// The entitlement cache is written on Safari by the background's App-Group pull and on Chromium by
// the background session's authenticated reconcile; both reach the UI through the same storage
// watch below.

/** The ext-chromium injection (plan U6): every capability is a message-closure over the
 * background-owned session — the popup/options page never touches Supabase directly (R2). */
export interface ExtensionPurchaseDeps {
  /** Code-flow auth closures (requestCode/verifyCode → the controller's canSignIn/canUseCode
   * capabilities) plus signOut and deleteAccount. */
  readonly auth: UiAuth;
  /** pendingOtp + purchase-intent persistence (survives popup death, AE2/AE1). */
  readonly persistence: AuthPersistence;
  /** create-checkout / open-tab / pending-flag / reconcile seam (plan U4/R3). */
  readonly checkout: UiCheckout;
  /** Host display price for the paywall CTA (e.g. "$1.99") — defined in ext-chromium, NEVER in
   * shared strings, so no web price can reach an Apple-target bundle (3.1.3). */
  readonly displayPrice: string;
  /** The background's mount snapshot (`getState` message): userId and the persisted pending
   * records have no storage-watch mirror, so the popup asks once on mount. */
  readonly getState: () => Promise<ExtensionSessionState>;
}

export function createExtensionUiController(
  currentHost?: string,
  purchase?: ExtensionPurchaseDeps,
): UiController {
  const cache = new SettingsCache(new ChromeStorageAdapter());
  void cache.hydrate();
  cache.watch();
  const controller = new UiController({
    cache,
    host: { canPurchase: purchase !== undefined, currentHost },
    auth: purchase?.auth,
    persistence: purchase?.persistence,
    checkout: purchase?.checkout,
  });
  if (purchase) controller.paywallPrice = purchase.displayPrice;

  const entitlement = new EntitlementCache(new ChromeEntitlementAdapter());
  entitlement.subscribe((entitled) => {
    controller.entitled = entitled;
  });
  void entitlement.hydrate().then((entitled) => {
    controller.entitled = entitled;
  });
  entitlement.watch();

  if (purchase) {
    void purchase
      .getState()
      .then((state) => {
        controller.userId = state.userId;
        // Rehydrate the cross-popup-death flows (the popup dies on every focus loss — rehydration
        // is the design): a pending OTP lands straight on code entry (AE2), a pending checkout on
        // its checking/stale presentation (U4/R3). Both no-op when moot (signed in / entitled).
        if (state.pendingOtp) controller.rehydrateCodeEntry(state.pendingOtp);
        if (state.checkoutPending) controller.rehydrateCheckoutPending(state.checkoutPending);
        // R4: reconcile on every popup open with a session, so a paid-elsewhere user unlocks and a
        // refund revokes without ritual. The checkout-pending rehydration above starts its own
        // fast-poll (which reconciles immediately), so only the no-pending open fires here. The
        // entitled flip arrives through the entitlement storage watch — never this return value.
        if (state.userId !== null && state.checkoutPending === null) {
          void purchase.checkout.reconcile();
        }
      })
      .catch(() => {
        /* unreachable background reads as signed-out; settings/entitlement still mirror via the
           storage watches above */
      });
  }

  return controller;
}
