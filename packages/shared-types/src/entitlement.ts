// Entitlement state (spec §6.3). The canonical source is the Supabase `entitlements` row, written
// server-side by the RevenueCat webhook / reconcile functions (U14) — never by the client.

/**
 * The paid tier is intentionally dormant while Still includes every supported blocking surface.
 * Keep the entitlement, purchase, and paywall paths healthy: changing this literal to `true` is
 * the single TypeScript switch that restores their authority in a rebuilt release.
 *
 * Every read path that decides what a user may block, or whether the purchase UI is reachable,
 * checks this before it reads an entitlement, so full access is answered synchronously and offline
 * with no network call of any kind. The Apple app has one counterpart, `MonetizationConfig
 * .paidTierEnabled` in StillKit, which governs the native purchase and restore actions; the two
 * must always hold the same value and a StillKit test fails if they drift.
 */
export const PAID_TIER_ENABLED = false;

/** How the entitlement row was last written, for audit/debug. */
export type EntitlementSource = "webhook" | "reconcile" | null;

export interface Entitlement {
  /** Supabase auth.users UUID — equals the RevenueCat app_user_id. */
  readonly userId: string;
  /** The single "Still Pro" non-consumable: unlocks Pro blocking (Instagram/TikTok/Facebook) +
   * cross-device settings sync. The field mirrors the deployed DB column / RevenueCat entitlement
   * id `still_sync` — the immutable internal id behind the "Still Pro" label (do NOT rename). */
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
