import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import { App, UiController } from "@still/core/ui";
import { SettingsCache, WKWebViewStorageAdapter } from "@still/core/storage";

// Entry for the Apple app's WKWebView-hosted settings screen (U17). It mounts the exact same shared
// Svelte UI the Chromium extension renders, but persists through the native App-Group bridge
// (WKWebViewStorageAdapter → Swift → UserDefaults(suiteName:) shared with the Safari extension).
//
// Like the extension's options page, this screen has no single "active site", so currentHost is
// omitted → the per-site pause control hides. canPurchase is true (Apple has a real purchase path,
// R19); the StoreKit/RevenueCat buy + Sign in with Apple actions are wired natively in U19.
const cache = new SettingsCache(new WKWebViewStorageAdapter());
cache.watch();
void cache.hydrate();

const controller = new UiController({ cache, host: { canPurchase: true } });

mount(App, {
  target: document.getElementById("app")!,
  props: { controller },
});
