import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import { UiController } from "@still/core/ui";

// Wires the shared UI controller to the WebExtension store (browser.storage, via ChromeStorageAdapter
// — Safari 16+ exposes the `chrome` namespace) for the Safari popup + options page. canPurchase is
// false here: the purchasable paywall lives in the native app's WKWebView UI (U19), so the in-Safari
// surfaces render the explanatory state (R19). Supabase auth/sync is layered on later.
export function createUiController(currentHost?: string): UiController {
  const cache = new SettingsCache(new ChromeStorageAdapter());
  void cache.hydrate();
  cache.watch();
  return new UiController({ cache, host: { canPurchase: false, currentHost } });
}
