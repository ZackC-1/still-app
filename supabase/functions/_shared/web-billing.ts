export interface WebCheckout {
  readonly checkout_url: string;
}

export interface WebBillingClient {
  createCheckout(appUserId: string): Promise<WebCheckout>;
}

export class HttpRevenueCatWebBillingClient implements WebBillingClient {
  constructor(
    private readonly secretKey: string,
    private readonly checkoutUrl: string,
    private readonly productId: string,
  ) {}

  async createCheckout(appUserId: string): Promise<WebCheckout> {
    if (!this.secretKey || !this.checkoutUrl || !this.productId) {
      throw new Error("RevenueCat Web Billing is not configured");
    }

    const res = await fetch(this.checkoutUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        app_user_id: appUserId,
        product_id: this.productId,
      }),
      // Deno's fetch has no default timeout; without this a hung RevenueCat response holds the edge
      // function open to its wall-clock limit (~150s) on the critical checkout path, stacking
      // invocations. Fail fast so the client can surface a retry.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`RevenueCat Web Billing checkout failed: ${res.status}`);

    const body = (await res.json()) as { checkout_url?: unknown; url?: unknown };
    const checkoutUrl = typeof body.checkout_url === "string" ? body.checkout_url : body.url;
    if (typeof checkoutUrl !== "string" || checkoutUrl.length === 0) {
      throw new Error("RevenueCat Web Billing response did not include a checkout URL");
    }
    return { checkout_url: checkoutUrl };
  }
}
