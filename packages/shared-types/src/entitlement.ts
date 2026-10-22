// Entitlement state (spec §6.3). The canonical source is the Supabase `entitlements` row, written
// server-side by the RevenueCat webhook / reconcile functions (U14) — never by the client.

/**
 * The paid tier is declared on for the 3.x release line (Still Pro: optional extras sold once). The
 * four free protections and optional sync stay free; nothing is sold until the server's remote
 * `salesEnabled` also says so, because the evaluator ANDs the two. Setting this literal back to
 * `false` makes the paid tier dormant again in a rebuilt release.
 *
 * Every read path that decides what a user may block, or whether the purchase UI is reachable,
 * checks this before it reads an entitlement, so full access is answered synchronously and offline
 * with no network call of any kind. The Apple app has one counterpart, `MonetizationConfig
 * .paidTierEnabled` in StillKit, which governs the native purchase and restore actions; the two
 * must always hold the same value and a StillKit test fails if they drift.
 */
export const PAID_TIER_ENABLED = true;

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
