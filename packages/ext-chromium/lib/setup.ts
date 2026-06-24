import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import { UiController } from "@still/core/ui";

// Wires the shared UI controller to chrome.storage for the popup + options page. canPurchase is
// false on desktop Chromium (no purchase path) → the paywall renders its explanatory state (R19).
// Supabase auth/sync is layered on later by injecting a UiAuth + driving the SyncService events.
export function createUiController(currentHost?: string): UiController {
  const cache = new SettingsCache(new ChromeStorageAdapter());
  void cache.hydrate();
  cache.watch();
  return new UiController({ cache, host: { canPurchase: false, currentHost } });
}
