import type { AccessRightStore } from "../_shared/access-issuer.ts";
import type { AppleAccountAccessRefresher } from "../_shared/apple-account-access.ts";
import type { RevenueCatAccessClient } from "../_shared/revenuecat-access.ts";

export interface ProductionWebhookAccess {
  readonly rights: AccessRightStore;
  readonly provider: RevenueCatAccessClient;
  readonly apple: AppleAccountAccessRefresher;
}

/** A webhook invalidates our cache; only current provider reads change rights. No proofs are
 * issued and no Apple transaction is linked here. The Apple refresher visits existing links only.
 * Persist independently verified observations before returning a retry for an unavailable source.
 */
export async function refreshProductionWebhookAccess(holder: string, access: ProductionWebhookAccess): Promise<boolean> {
  const token = await access.rights.begin(holder, "production");
  const [provider, apple] = await Promise.all([
    access.provider.getRights(holder, "production").catch(() => ({ status: "unavailable" as const })),
    access.apple.refresh(holder, "production").catch(() => false),
  ]);
  const appleReady = typeof apple === "boolean" ? apple : apple.ready;
  if (provider.status !== "verified") return false;
  const committed = await access.rights.commit(holder, "production", token, provider.rights);
  // Partial/absent provider evidence and a superseded observation must remain retryable. Absence
  // is never a refund: the store removes only explicit canonical revoked transaction keys.
  return appleReady && provider.complete !== false && !provider.customerMissing &&
    committed.status !== "stale" && await access.rights.confirm(holder, "production", token);
}
