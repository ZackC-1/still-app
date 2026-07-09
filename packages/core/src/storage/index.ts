// @still/core/storage — settings model cache + storage adapters (KTD4, KTD6).

export type {
  SettingsSyncMetadata,
  StorageAdapter,
  StoredSettingsRecord,
  SyncedSettingsEnvelope,
} from "./adapter.js";
export { InMemoryStorageAdapter } from "./adapter.js";
export { ChromeStorageAdapter } from "./chrome-adapter.js";
export { WKWebViewStorageAdapter } from "./wkwebview-adapter.js";
export type { StillMessagePort, StillBridgeWindow, BridgeMessage } from "./wkwebview-adapter.js";
export { SettingsCache, type SettingsCacheOptions } from "./cache.js";
export {
  parseSettings,
  parseSettingsSyncMetadata,
  parseStoredSettingsRecord,
  parseSyncedSettingsEnvelope,
  safeParse,
} from "./settings-validation.js";
