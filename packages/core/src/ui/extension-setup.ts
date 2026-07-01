import { SettingsCache, ChromeStorageAdapter } from "../storage/index.js";
import { EntitlementCache, ChromeEntitlementAdapter } from "../entitlement/index.js";
import { UiController } from "./controller.svelte.js";

// The ONE popup/options wiring every extension build shares (Safari maps the WebExtension storage
// API — Safari 16+ exposes the `chrome` namespace, so the Chrome adapters serve both). canPurchase
// is false on every extension host: the purchasable paywall lives in the native app's WKWebView UI
// (U19) on Apple, and desktop Chromium has no purchase path until the U10 auth spine lands — so the
// paywall renders its explanatory state (R19). The entitlement cache is written on Safari by the
// background's App-Group pull (the app mirrors its server-reconciled value) and has no Chromium
// writer yet; wiring it here means Pro rows unlock the moment a writer exists on that platform.
// Supabase auth/sync is layered on later by injecting a UiAuth + driving the SyncService events.
export function createExtensionUiController(currentHost?: string): UiController {
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
