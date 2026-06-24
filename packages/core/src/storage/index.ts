// @still/core/storage — settings model cache + storage adapters (KTD4, KTD6).

export type { StorageAdapter } from "./adapter.js";
export { InMemoryStorageAdapter } from "./adapter.js";
export { ChromeStorageAdapter } from "./chrome-adapter.js";
export { WKWebViewStorageAdapter } from "./wkwebview-adapter.js";
export type { StillMessagePort, StillBridgeWindow, BridgeMessage } from "./wkwebview-adapter.js";
export { SettingsCache, type SettingsCacheOptions } from "./cache.js";
