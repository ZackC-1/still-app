export interface WebCheckout {
  readonly checkout_url: string;
}

export interface WebBillingClient {
  createCheckout(appUserId: string): Promise<WebCheckout>;
}

// RevenueCat Web Billing exposes checkout as a hosted "Web Purchase Link" (https://pay.rev.cat/<token>),
// NOT a REST endpoint that mints a session. We derive the per-user checkout URL server-side by
// appending the (JWT-verified) app_user_id and the target package, then return it for the client to
// open:
//
//   https://pay.rev.cat/<token>/<app_user_id>?package_id=<package>
//
// This keeps the design's security contract (the SERVER assembles the URL from the verified JWT
// subject; the client never assembles it or supplies app_user_id) while matching how Web Billing
// actually works — no RevenueCat API call or secret key is needed; the link itself is the session.
//
// VERIFY-AT-LAUNCH: confirm against your live RC "Web Purchase Link" (Funnels → Purchase Links →
// Share URL). REVENUECAT_WEB_BILLING_CHECKOUT_URL must be the PRODUCTION base link (the pay.rev.cat
// token URL, without the trailing /<app_user_id> placeholder); REVENUECAT_WEB_PRODUCT_ID must match
// the PACKAGE identifier inside the offering (set the web package id to `still_sync_web` so they line
// up). Sandbox-test the full open→pay→entitlement flow before launch.
export class RevenueCatWebPurchaseLink implements WebBillingClient {
  constructor(
    private readonly purchaseLinkBaseUrl: string,
    private readonly packageId: string,
  ) {}

  // deno-lint-ignore require-await -- async for clean rejection semantics on the await-ing handler.
  async createCheckout(appUserId: string): Promise<WebCheckout> {
    if (!this.purchaseLinkBaseUrl || !this.packageId) {
      throw new Error("RevenueCat Web Billing is not configured");
    }
    const base = this.purchaseLinkBaseUrl.replace(/\/+$/, "");
    const checkout_url =
      `${base}/${encodeURIComponent(appUserId)}?package_id=${encodeURIComponent(this.packageId)}`;
    return { checkout_url };
  }
}
