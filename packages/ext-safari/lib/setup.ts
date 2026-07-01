import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import { EntitlementCache, ChromeEntitlementAdapter } from "@still/core/entitlement";
import { UiController } from "@still/core/ui";

// Wires the shared UI controller to the WebExtension store (browser.storage, via ChromeStorageAdapter
// — Safari 16+ exposes the `chrome` namespace) for the Safari popup + options page. canPurchase is
// false here: the purchasable paywall lives in the native app's WKWebView UI (U19), so the in-Safari
// surfaces render the explanatory state (R19). The entitlement cache is written by the background's
// App-Group pull (the app mirrors its server-reconciled value), so the popup's Pro rows unlock after
// a purchase in the app. Supabase auth/sync is layered on later.
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
