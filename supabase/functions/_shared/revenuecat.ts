// Server-side RevenueCat subscriber lookup + entitlement derivation (KTD5). Webhooks are treated as
// invalidation triggers only — the entitlement is ALWAYS derived from the canonical subscriber
// state fetched here, so refund/transfer/cancel/re-purchase races collapse to the current truth.

// The RevenueCat entitlement id behind the user-facing "Still Pro". The VALUE stays `still_sync`
// forever: the RC dashboard entitlement, the ASC product id (immutable), and the DB column all use
// it — a mismatch here would derive pro=false for every paying user (monetization-design §5).
export const STILL_PRO_ENTITLEMENT = "still_sync";

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

/** Whether the canonical subscriber state currently grants Still Pro. */
export function stillProActive(subscriber: RcSubscriber | null, now: number = Date.now()): boolean {
  const entitlement = subscriber?.entitlements?.[STILL_PRO_ENTITLEMENT];
  if (!entitlement) return false;
  if (entitlement.expires_date == null) return true; // non-consumable never expires
  return new Date(entitlement.expires_date).getTime() > now;
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
    if (!res.ok) throw new Error(`RevenueCat lookup failed: ${res.status}`);
    const json = (await res.json()) as { subscriber: RcSubscriber };
    return json.subscriber;
  }
}
