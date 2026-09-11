import { vi, type Mock } from "vitest";
import { SettingsCache } from "../../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../../storage/adapter.js";
import {
  UiController,
  type AuthPersistence,
  type CheckoutPending,
  type CheckoutReconcileOutcome,
  type UiAuth,
  type UiCheckout,
  type UiHost,
} from "../../controller.svelte.js";
import type {
  RequestCodeOutcome,
  VerifyCodeOutcome,
  WebCheckoutOutcome,
} from "../../../sync/ports.js";

// Controller fixtures shared by the two suites that drive UiController: the one that runs against
// the switch as shipped, and the one that runs the purchase machinery with the switch mocked on.
// They live here so the two cannot drift into testing subtly different controllers.

export function makeController(
  extra: {
    host?: Partial<UiHost>;
    auth?: UiAuth;
    persistence?: AuthPersistence;
    checkout?: UiCheckout;
    clock?: () => number;
  } = {},
) {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), {
    now: () => Date.now(),
  });
  const c = new UiController({
    cache,
    host: { canPurchase: true, ...extra.host },
    auth: extra.auth,
    persistence: extra.persistence,
    checkout: extra.checkout,
    clock: extra.clock,
  });
  return { c, cache };
}

/** An extension-shaped UiAuth: code capability, no magic link (plan U2/R1). */
export function codeAuth(over: Partial<UiAuth> = {}): UiAuth {
  return {
    signOut: vi.fn(() => Promise.resolve()),
    requestCode: vi.fn(() =>
      Promise.resolve<RequestCodeOutcome>({ kind: "sent" }),
    ),
    verifyCode: vi.fn(() =>
      Promise.resolve<VerifyCodeOutcome>({
        kind: "verified",
        userId: "user-1",
      }),
    ),
    ...over,
  };
}

export function mockPersistence(): {
  setPendingOtp: Mock<AuthPersistence["setPendingOtp"]>;
  setPurchaseIntent: Mock<AuthPersistence["setPurchaseIntent"]>;
} {
  return { setPendingOtp: vi.fn(), setPurchaseIntent: vi.fn() };
}

export const CHECKOUT_URL = "https://pay.rev.cat/tok/user-uuid";

/** An in-memory UiCheckout seam (plan U4): `order` records the persist/open sequence so tests can
 * pin persisted-BEFORE-opened (the popup dies the moment the tab takes focus). */
export function checkoutSeam(over: Partial<UiCheckout> = {}) {
  const order: string[] = [];
  const seam = {
    createCheckout: vi.fn(() =>
      Promise.resolve<WebCheckoutOutcome>({
        kind: "checkout-url",
        url: CHECKOUT_URL,
      }),
    ),
    openCheckoutTab: vi.fn((url: string) => {
      order.push(`open:${url}`);
      return Promise.resolve<number | undefined>(42);
    }),
    setPending: vi.fn((pending: CheckoutPending | null) => {
      order.push(pending === null ? "clear-pending" : "persist-pending");
    }),
    reconcile: vi.fn(() =>
      Promise.resolve<CheckoutReconcileOutcome>("unknown"),
    ),
    ...over,
  };
  return { seam, order };
}
