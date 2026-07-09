import type { StorageAdapter, StoredSettingsRecord } from "./adapter.js";
import { parseStoredSettingsRecord } from "./settings-validation.js";

// chrome.storage.local implementation of the storage adapter — used in the Chromium and Safari
// WebExtension contexts (the popup, options page, and content script all share this one store).

const STORAGE_KEY = "still:settings";

export class ChromeStorageAdapter implements StorageAdapter {
  async get(): Promise<StoredSettingsRecord | null> {
    const record = await chrome.storage.local.get(STORAGE_KEY);
    return parseStoredSettingsRecord(record[STORAGE_KEY]);
  }

  async set(record: StoredSettingsRecord): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: record });
  }

  subscribe(listener: (record: StoredSettingsRecord) => void): () => void {
    const handler = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEY];
      const record = change ? parseStoredSettingsRecord(change.newValue) : null;
      if (record) listener(record);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }
}
