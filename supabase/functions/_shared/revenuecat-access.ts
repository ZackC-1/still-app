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
        // 404/unknown account is ambiguous; only a successful complete list proves absence.
        if (!response.ok) return unavailable;
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
              product.type !== "one_time" || !object(product.one_time) || product.one_time.is_consumable !== false) { complete = false; continue; }
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
