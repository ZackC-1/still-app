import type { StillSettings } from "@still/shared-types";
import type { StorageAdapter } from "./adapter.js";

// chrome.storage.local implementation of the storage adapter — used in the Chromium and Safari
// WebExtension contexts (the popup, options page, and content script all share this one store).

const STORAGE_KEY = "still:settings";

export class ChromeStorageAdapter implements StorageAdapter {
  async get(): Promise<StillSettings | null> {
    const record = await chrome.storage.local.get(STORAGE_KEY);
    return (record[STORAGE_KEY] as StillSettings | undefined) ?? null;
  }

  async set(settings: StillSettings): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  }

  subscribe(listener: (settings: StillSettings) => void): () => void {
    const handler = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEY];
      if (change && change.newValue) listener(change.newValue as StillSettings);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }
}
