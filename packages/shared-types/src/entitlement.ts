// Entitlement state (spec §6.3). The canonical source is the Supabase `entitlements` row, written
// server-side by the RevenueCat webhook / reconcile functions (U14) — never by the client.

/**
 * The 3.x release line declares the paid tier on (Still Pro: optional extras sold once). Nothing is
 * sold until the server's remote `salesEnabled` also says so, because the evaluator ANDs the two.
 * Keep StillKit's MonetizationConfig.paidTierEnabled and version.json's paidTier equal to this; see
 * docs/monetization-design.md. Free blocking never requires an entitlement. Settings sync is free
 * on the modern settings path, which every 3.0 store build uses; on the legacy settings backend,
 * sync with this flag on still needs an entitlement (see packages/core/src/sync/service.ts).
 */
export const PAID_TIER_ENABLED = true;

/** How the entitlement row was last written, for audit/debug. */
export type EntitlementSource = "webhook" | "reconcile" | null;

export interface Entitlement {
  /** Supabase auth.users UUID — equals the RevenueCat app_user_id. */
  readonly userId: string;
  /** Historical entitlement projection matching the DB column and RevenueCat id `still_sync`.
   * Preserve this field for compatibility; free blocking and sync never depend on it.
   * The separate V3 catalog is documented in docs/monetization-design.md#purchase-identifiers. */
  readonly stillSync: boolean;
  readonly source: EntitlementSource;
  /** RevenueCat subscriber id, for server-side reconcile lookups. Not user-readable in raw form. */
  readonly revenueCatSubscriberId: string | null;
  /** Epoch milliseconds of the last server write. */
  readonly updatedAt: number;
}

/** The default for a signed-in user with no purchase: Pro locked. */
export const NO_ENTITLEMENT: Omit<Entitlement, "userId"> = {
  stillSync: false,
  source: null,
  revenueCatSubscriberId: null,
  updatedAt: 0,
};
