import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import { EntitlementCache, ChromeEntitlementAdapter } from "@still/core/entitlement";
import { UiController } from "@still/core/ui";

// Wires the shared UI controller to chrome.storage for the popup + options page. canPurchase is
// false on desktop Chromium (no purchase path) → the paywall renders its explanatory state (R19).
// The entitlement cache has no writer on Chromium until the U10 auth spine lands, so Pro rows stay
// locked here; wiring it now means they unlock the moment that writer ships. Supabase auth/sync is
// layered on later by injecting a UiAuth + driving the SyncService events.
export function createUiController(currentHost?: string): UiController {
  const cache = new SettingsCache(new ChromeStorageAdapter());
  void cache.hydrate();
  cache.watch();
  const controller = new UiController({ cache, host: { canPurchase: false, currentHost } });

  const entitlement = new EntitlementCache(new ChromeEntitlementAdapter());
  entitlement.subscribe((entitled) => {
    controller.entitled = entitled;
  });
  void entitlement.hydrate().then((entitled) => {
    controller.entitled = entitled;
  });
  entitlement.watch();

  return controller;
}
