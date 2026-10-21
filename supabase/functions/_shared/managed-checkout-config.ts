import { ManagedCheckout, STRIPE_API_VERSION, type ManagedCheckoutConfig } from "./managed-checkout.ts";
import { parseAccessProductMappings, stripeMappingsBoundTo } from "./revenuecat-access.ts";
import type { CheckoutEnvironment } from "./purchase-operation-store.ts";

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Parse a server-selected secret namespace. No HTTP input chooses these bindings. */
export function readManagedCheckoutBindings(get: (suffix: string) => string, environment: CheckoutEnvironment) {
  try {
    const origin = new URL(get("WEB_RETURN_ORIGIN"));
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.pathname !== "/" || origin.search || origin.hash ||
      origin.origin !== get("WEB_RETURN_ORIGIN")) return null;
    const paths: unknown = JSON.parse(get("WEB_RETURN_PATHS_JSON"));
    if (!object(paths) || Object.keys(paths).length !== 2 || !Object.hasOwn(paths,"success") || !Object.hasOwn(paths,"cancel")) return null;
    for (const path of [paths.success,paths.cancel]) {
      if (typeof path !== "string" || path.length > 512 || !/^\/[A-Za-z0-9/_-]*$/.test(path) || path.includes("//") ||
        new URL(path,origin).pathname !== path) return null;
    }
    if (paths.success === paths.cancel || get("STRIPE_API_VERSION") !== STRIPE_API_VERSION) return null;
    const mappings = stripeMappingsBoundTo(parseAccessProductMappings(get("ACCESS_PROVIDER_PRODUCTS_JSON")), get("STRIPE_PRICE_ID"));
    const stripe = mappings?.filter(mapping => mapping.store === "stripe");
    if (!mappings || stripe?.length !== 1 || !/^[A-Za-z0-9_-]{1,96}$/.test(get("REVENUECAT_PROJECT_ID")) ||
      !/^[!-~]{1,1024}$/.test(get("REVENUECAT_ACCESS_SECRET_API_KEY"))) return null;
    const billing: ManagedCheckoutConfig = Object.freeze({ environment, stripeSecretKey: get("STRIPE_SECRET_API_KEY"), stripeAccountId: get("STRIPE_ACCOUNT_ID"),
      priceId: get("STRIPE_PRICE_ID"), productId: get("STRIPE_PRODUCT_ID"), revenueCatStripePublicKey: get("REVENUECAT_STRIPE_PUBLIC_API_KEY"),
      successUrl: origin.origin + paths.success, cancelUrl: origin.origin + paths.cancel });
    // Constructor is pure; validates the existing pinned managed contract, no provider requests.
    new ManagedCheckout(billing);
    return { billing, project: get("REVENUECAT_PROJECT_ID"), revenueCatSecret: get("REVENUECAT_ACCESS_SECRET_API_KEY"), mappings };
  } catch { return null; }
}
