import { CodedError } from "./coded-error.ts";
// Server-side RevenueCat subscriber lookup + entitlement derivation (KTD5). Webhooks are treated as
// invalidation triggers only — the entitlement is ALWAYS derived from the canonical subscriber
// state fetched here, so refund/transfer/cancel/re-purchase races collapse to the current truth.

// The RevenueCat entitlement id behind the user-facing "Still Pro". The VALUE stays `still_sync`
// forever: the RC dashboard entitlement, the ASC product id (immutable), and the DB column all use
// it — a mismatch here would derive pro=false for every paying user (monetization-design §5).
export const STILL_PRO_ENTITLEMENT = "still_sync";

// The current offer's entitlement (U16-W2): every new purchase grants `still_pro_v3`, while past
// buyers keep the historical `still_sync` above. Both ids mean lifetime Pro — the server ORs them
// into the existing entitlement boolean, so there is no migration, no new client field, and no
// new DB column (reconcile/webhook shapes stay `{ still_sync: … }`).
export const STILL_PRO_V3_ENTITLEMENT = "still_pro_v3";

/** Every RevenueCat entitlement id that grants lifetime Still Pro, current offer first. */
export const PRO_ENTITLEMENT_IDS: readonly string[] = [
  STILL_PRO_V3_ENTITLEMENT,
  STILL_PRO_ENTITLEMENT,
];

export interface RcEntitlement {
  readonly expires_date: string | null; // null = lifetime / non-consumable
  readonly product_identifier?: string;
}

export interface RcSubscriber {
  readonly entitlements: Record<string, RcEntitlement>;
  readonly original_app_user_id?: string;
}

export interface RevenueCatClient {
  getSubscriber(appUserId: string): Promise<RcSubscriber | null>;
}

/** Whether one RevenueCat entitlement currently grants Still Pro. */
function entitlementActive(
  entitlement: RcEntitlement | undefined,
  now: number,
): boolean {
  if (!entitlement) return false;
  if (entitlement.expires_date == null) return true; // non-consumable never expires
  return new Date(entitlement.expires_date).getTime() > now;
}

/** Whether the canonical subscriber state currently grants Still Pro. */
export function stillProActive(subscriber: RcSubscriber | null, now: number = Date.now()): boolean {
  const entitlements = subscriber?.entitlements;
  if (!entitlements) return false;
  return PRO_ENTITLEMENT_IDS.some((id) => entitlementActive(entitlements[id], now));
}

/** Real client: GET /subscribers/{id} with the secret API key. */
export class HttpRevenueCatClient implements RevenueCatClient {
  constructor(
    private readonly secretKey: string,
    private readonly base = "https://api.revenuecat.com/v1",
  ) {}

  async getSubscriber(appUserId: string): Promise<RcSubscriber | null> {
    // Deno's fetch has no default timeout. This path runs both inside the webhook reconcile loop and
    // synchronously during sign-in (reconcile-entitlement); a hung RevenueCat response would stall the
    // invocation to its wall-clock limit and leave the sign-in UI indeterminate. Fail fast.
    const res = await fetch(`${this.base}/subscribers/${encodeURIComponent(appUserId)}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new CodedError("revenuecat_lookup_failed", `RevenueCat lookup failed: ${res.status}`, res.status);
    const json = (await res.json()) as { subscriber: RcSubscriber };
    return json.subscriber;
  }
}
