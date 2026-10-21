// Keep QA composition sandbox-only even when shared transport gains production support.
import { ManagedCheckout, STRIPE_API_VERSION, type ManagedCheckoutConfig } from "./managed-checkout.ts";
export { STRIPE_API_VERSION as QA_STRIPE_API_VERSION };
export type {
  CheckoutOperation as QaCheckoutOperation, CheckoutCreated as QaCheckoutCreated,
  CheckoutRecovered as QaCheckoutRecovered, CheckoutUnknown as QaCheckoutUnknown,
  CheckoutRecovery as QaCheckoutRecovery, ChargeRefund as QaChargeRefund,
} from "./managed-checkout.ts";
export type QaManagedCheckoutConfig = Omit<ManagedCheckoutConfig, "environment" | "stripeSecretKey"> & { readonly stripeTestKey: string };

export class QaSandboxManagedCheckout extends ManagedCheckout {
  constructor(config: QaManagedCheckoutConfig, fetcher: typeof fetch = fetch, timeoutMs = 8000) {
    try {
      super({ ...config, environment: "sandbox", stripeSecretKey: config.stripeTestKey }, fetcher, timeoutMs);
    } catch { throw new Error("qa_checkout_unconfigured"); }
  }
}
