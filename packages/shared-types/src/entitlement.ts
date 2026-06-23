// Entitlement state (spec §6.3). The canonical source is the Supabase `entitlements` row, written
// server-side by the RevenueCat webhook / reconcile functions (U14) — never by the client.

/** How the entitlement row was last written, for audit/debug. */
export type EntitlementSource = "webhook" | "reconcile" | null;

export interface Entitlement {
  /** Supabase auth.users UUID — equals the RevenueCat app_user_id. */
  readonly userId: string;
  /** The single "Still Sync" non-consumable: unlocks cross-device settings sync. */
  readonly stillSync: boolean;
  readonly source: EntitlementSource;
  /** RevenueCat subscriber id, for server-side reconcile lookups. Not user-readable in raw form. */
  readonly revenueCatSubscriberId: string | null;
  /** Epoch milliseconds of the last server write. */
  readonly updatedAt: number;
}

/** The default for a signed-in user with no purchase: sync locked. */
export const NO_ENTITLEMENT: Omit<Entitlement, "userId"> = {
  stillSync: false,
  source: null,
  revenueCatSubscriberId: null,
  updatedAt: 0,
};
