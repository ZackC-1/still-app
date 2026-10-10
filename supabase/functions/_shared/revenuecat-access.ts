import type { AccessEnvironment } from "@still/shared-types";
import type { ProviderRight } from "./access-issuer.ts";

export type ProviderAccess = { readonly status: "verified"; readonly rights: readonly ProviderRight[]; readonly complete?: boolean }
  | { readonly status: "unavailable" };
export interface RevenueCatAccessClient {
  getRights(holder: string, environment: AccessEnvironment): Promise<ProviderAccess>;
}
interface LegacyAccessProductMapping {
  readonly product_id: string;
  readonly app_id: string;
  readonly store_identifier: "still_pro_v3" | "still_sync";
  readonly entitlement_lookup_key: "still_pro_v3" | "still_sync";
  readonly store: "app_store" | "mac_app_store" | "rc_billing";
}
interface StripeAccessProductMapping {
  readonly product_id: string;
  readonly app_id: string;
  readonly store_identifier: string;
  readonly entitlement_lookup_key: "still_pro_v3";
  readonly store: "stripe";
  readonly benefit_product: "still_pro_v3";
}
export type AccessProductMapping = LegacyAccessProductMapping | StripeAccessProductMapping;
const ID = /^[A-Za-z0-9_-]{1,96}$/;
const STRIPE_STORE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// RevenueCat v2 reports App Store and RevenueCat Billing lifetime products as one_time or
// non_consumable, and both must state is_consumable false. RevenueCat cannot record that flag for a
// Stripe price (its Stripe apps allow only subscription or one_time, and the flag stays null), so
// for the one exact mapped Stripe price an unknown flag is accepted; an explicit consumable never
// grants. Repeat purchases are refused by checkout (already_entitled), not by the provider.
function lifetimeProduct(product: Record<string, unknown>, store: AccessProductMapping["store"]): boolean {
  if (!object(product.one_time)) return false;
  const consumable = product.one_time.is_consumable;
  if (store === "stripe") return product.type === "one_time" && (consumable === false || consumable === null);
  return (product.type === "one_time" || product.type === "non_consumable") && consumable === false;
}

export function parseAccessProductMappings(text: string): readonly AccessProductMapping[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) return null;
    for (const mapping of parsed) {
      if (!object(mapping) ||
          typeof mapping.product_id !== "string" || !ID.test(mapping.product_id) ||
          typeof mapping.app_id !== "string" || !ID.test(mapping.app_id)) return null;
      if (mapping.store === "stripe") {
        if (Object.keys(mapping).length !== 6 || typeof mapping.store_identifier !== "string" ||
            !STRIPE_STORE_ID.test(mapping.store_identifier) || mapping.entitlement_lookup_key !== "still_pro_v3" ||
            mapping.benefit_product !== "still_pro_v3") return null;
      } else if (Object.keys(mapping).length !== 5 ||
                 !["still_pro_v3", "still_sync"].includes(mapping.store_identifier as string) ||
                 mapping.entitlement_lookup_key !== mapping.store_identifier ||
                 !["app_store", "mac_app_store", "rc_billing"].includes(mapping.store as string)) return null;
    }
    if (new Set(parsed.map(mapping => mapping.product_id)).size !== parsed.length) return null;
    return parsed as AccessProductMapping[];
  } catch { return null; }
}

/** RevenueCat identifies an imported Stripe item by its price ID, so a Stripe mapping must name the
 * exact configured sandbox price; another price on the same Stripe product never grants. */
export function stripeMappingsBoundTo(mappings: readonly AccessProductMapping[] | null,
  priceId: string): readonly AccessProductMapping[] | null {
  return mappings?.every(mapping => mapping.store !== "stripe" || mapping.store_identifier === priceId) ? mappings : null;
}

/** RevenueCat v2's documented "customer not found": HTTP 404 whose error body has type
 * resource_missing (https://www.revenuecat.com/docs/api-v2#tag/Error-Handling). The request path is
 * built here from the fixed server project and the authenticated holder, and redirects are refused,
 * so the 404 can only be about this project's customer list for this account. RevenueCat documents
 * one resource_missing type for every missing ID, so the body cannot positively prove which ID was
 * missing; a body that names anything other than the customer (a `param` other than customer_id, or
 * a message mentioning the project) is refused. Residual risk: a misconfigured project ID that
 * RevenueCat answers with an indistinguishable resource_missing body would read as verified-none
 * for accounts with no recorded rights. That never grants or revokes anything (the reconciler only
 * answers "none" when the account's rights ledger is empty). The project ID is fixed server
 * configuration (a staged secret), never request input, and a wrong one already fails every
 * buyer's positive read, so it surfaces in the first purchase/restore test. */
async function customerNotFound(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  let body: unknown;
  try { body = await response.json(); } catch { return false; }
  if (!object(body) || body.type !== "resource_missing") return false;
  if (body.object !== undefined && body.object !== "error") return false;
  if (body.retryable === true) return false;
  if (body.param !== undefined && body.param !== null && body.param !== "customer_id") return false;
  if (body.message !== undefined && body.message !== null &&
      (typeof body.message !== "string" || /project/i.test(body.message))) return false;
  return true;
}

/** Unlike the legacy Boolean/V1 subscriber response, V2 purchases expose current owned/refunded
 * status, project/app/product mapping, environment, transaction identity and canonical revenue.
 * Only positive genuine payment is classified as paid; zero/unknown amount is recovery-required.
 * https://www.revenuecat.com/docs/api-v2/customer/resources
 * https://www.revenuecat.com/docs/api-v2/purchase */
export class HttpRevenueCatAccessClient implements RevenueCatAccessClient {
  constructor(private readonly secret: string, private readonly project: string,
    private readonly mappings: readonly AccessProductMapping[]) {}

  async getRights(holder: string, environment: AccessEnvironment): Promise<ProviderAccess> {
    const unavailable = { status: "unavailable" } as const;
    if (!this.secret || !ID.test(this.project) || !this.mappings.length ||
        environment !== "sandbox" && this.mappings.some(mapping => mapping.store === "stripe")) return unavailable;
    const path = `/v2/projects/${this.project}/customers/${encodeURIComponent(holder)}/purchases`;
    let next = `${path}?environment=${environment}&limit=100`;
    const rights: ProviderRight[] = [];
    let complete = true;
    const visited = new Set<string>();
    // One deadline covers every page; incomplete pagination is never authoritative absence.
    const signal = AbortSignal.timeout(8_000);
    try {
      for (let page = 0; page < 4; page++) {
        if (visited.has(next)) return unavailable;
        visited.add(next);
        const response = await fetch(`https://api.revenuecat.com${next}`, {
          headers: { Authorization: `Bearer ${this.secret}` }, signal, redirect: "error",
        });
        // Owner decision 2026-10-10: RevenueCat creates a customer only when it first records an
        // event for that App User ID, so an account that never bought answers its purchases list
        // with 404 resource_missing ("customer not found"). On the FIRST page only, that exact
        // answer is a complete, empty list (verified-none, so clients may offer Buy). No customer
        // is created. Every other non-OK answer — another 404 type, an empty or malformed body, a
        // retryable error, 403/429/5xx, or a 404 on a later page — stays unavailable.
        if (!response.ok) {
          if (page === 0 && await customerNotFound(response)) return { status: "verified", rights: [], complete: true };
          return unavailable;
        }
        const list: unknown = await response.json();
        if (!object(list) || list.object !== "list" || !Array.isArray(list.items) || list.items.length > 100 ||
            !(list.next_page === null || typeof list.next_page === "string")) return unavailable;
        for (const purchase of list.items) {
          if (!object(purchase) || purchase.object !== "purchase" || purchase.customer_id !== holder ||
              purchase.environment !== environment || typeof purchase.product_id !== "string") return unavailable;
          const mapping = this.mappings.find(candidate => candidate.product_id === purchase.product_id);
          if (!mapping) continue;
          // The provider store identity is not the benefit written to Still's rights ledger.
          const benefit = mapping.store === "stripe" ? mapping.benefit_product : mapping.store_identifier;
          // Current Apple Pro has ONE canonical original-transaction ledger and explicit account link.
          // RevenueCat purchase.id is a second provider identifier, not proof of Apple's original ID.
          // Keep legacy purchased still_sync/web rights; do not mint duplicate current Apple rights.
          if (mapping.store_identifier === "still_pro_v3" &&
              (mapping.store === "app_store" || mapping.store === "mac_app_store")) continue;
          if (purchase.store !== mapping.store || typeof purchase.id !== "string" || !ID.test(purchase.id)) return unavailable;
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["revenuecat", this.project, environment, purchase.id])));
          const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
          if (purchase.status === "refunded") {
            // No new paid classification: this negative observation only revokes an existing
            // transaction. Revenue may be zero and entitlement/product listings may disappear
            // after refund; the ledger must restrict revocation to an already-known key/product.
            rights.push({ key, product: benefit, state: "revoked" });
            continue;
          }
          if (purchase.status !== "owned" || purchase.ownership !== "purchased" || purchase.store !== mapping.store ||
              typeof purchase.id !== "string" || !ID.test(purchase.id) ||
              !Number.isSafeInteger(purchase.purchased_at) || (purchase.purchased_at as number) < 0 ||
              !object(purchase.revenue_in_usd) || purchase.revenue_in_usd.currency !== "USD" ||
              typeof purchase.revenue_in_usd.gross !== "number" || !Number.isFinite(purchase.revenue_in_usd.gross) ||
              purchase.revenue_in_usd.gross <= 0 || !object(purchase.entitlements) ||
              purchase.entitlements.object !== "list" || !Array.isArray(purchase.entitlements.items) ||
              purchase.entitlements.next_page !== null) { complete = false; continue; }
          const entitlement = purchase.entitlements.items.find(candidate => object(candidate) &&
            candidate.state === "active" && candidate.object === "entitlement" && candidate.project_id === this.project &&
            candidate.lookup_key === mapping.entitlement_lookup_key);
          if (!object(entitlement) || !object(entitlement.products) || entitlement.products.object !== "list" ||
              entitlement.products.next_page !== null || !Array.isArray(entitlement.products.items)) { complete = false; continue; }
          const product = entitlement.products.items.find(candidate => object(candidate) && candidate.id === mapping.product_id);
          if (!object(product) || product.object !== "product" || product.state !== "active" ||
              product.app_id !== mapping.app_id || product.store_identifier !== mapping.store_identifier ||
              !lifetimeProduct(product, mapping.store)) { complete = false; continue; }
          rights.push({ key, product: benefit });
          if (rights.length > 16) return unavailable;
        }
        if (list.next_page === null) {
          if (rights.length > 16 || new Set(rights.map(right => right.key)).size !== rights.length) return unavailable;
          return { status: "verified", rights, complete };
        }
        // Provider pagination cannot redirect the secret to another host, project or account.
        const url = new URL(list.next_page as string, "https://api.revenuecat.com");
        if (url.origin !== "https://api.revenuecat.com" || url.pathname !== path ||
            url.searchParams.get("environment") !== environment || url.username || url.password || url.hash) return unavailable;
        next = url.pathname + url.search;
      }
    } catch { /* Canonical state unavailable; never infer refund/absence from failed transport. */ }
    return unavailable;
  }
}
