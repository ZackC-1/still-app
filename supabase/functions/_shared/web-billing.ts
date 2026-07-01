export interface WebCheckout {
  readonly checkout_url: string;
}

export interface WebBillingClient {
  createCheckout(appUserId: string): Promise<WebCheckout>;
}

// RevenueCat Web Billing exposes checkout as a hosted "Web Purchase Link" (https://pay.rev.cat/<token>),
// NOT a REST endpoint that mints a session. We derive the per-user checkout URL server-side by
// appending the (JWT-verified) app_user_id, then return it for the client to open:
//
//   https://pay.rev.cat/<token>/<app_user_id>
//
// The link's offering is configured in the RevenueCat dashboard (Funnels → Purchase Links); RevenueCat
// presents that offering's package(s) for the given app_user_id. A single-package offering goes straight
// to that product — verified live to render the $1.99 Still Pro product. We deliberately do NOT append
// a `?package_id=` selector: it isn't needed for a single-package offering, and RevenueCat selects by
// the *package* identifier (e.g. `$rc_lifetime`), not the product id, so a product-id value would be a
// misleading no-op. If the offering ever gains multiple packages, either the customer picks on the
// hosted page, or add a verified `?package_id=<package-identifier>` here.
//
// This keeps the design's security contract: the SERVER assembles the URL from the verified JWT subject;
// the client never assembles it or supplies app_user_id. No RevenueCat API call or secret key is needed.
//
// REVENUECAT_WEB_BILLING_CHECKOUT_URL must be the PRODUCTION base link (the pay.rev.cat token URL).
export class RevenueCatWebPurchaseLink implements WebBillingClient {
  constructor(private readonly purchaseLinkBaseUrl: string) {}

  // deno-lint-ignore require-await -- async for clean rejection semantics on the await-ing handler.
  async createCheckout(appUserId: string): Promise<WebCheckout> {
    if (!this.purchaseLinkBaseUrl) {
      throw new Error("RevenueCat Web Billing is not configured");
    }
    const base = this.purchaseLinkBaseUrl.replace(/\/+$/, "");
    return { checkout_url: `${base}/${encodeURIComponent(appUserId)}` };
  }
}
