import type { EntitlementAdapter } from "./cache.js";

const STORAGE_KEY = "still:entitlement";

interface StoredEntitlement {
  readonly entitled?: unknown;
}

export class ChromeEntitlementAdapter implements EntitlementAdapter {
  async get(): Promise<boolean | null> {
    const record = await chrome.storage.local.get(STORAGE_KEY);
    const stored = record[STORAGE_KEY] as StoredEntitlement | undefined;
    return typeof stored?.entitled === "boolean" ? stored.entitled : null;
  }

  async set(entitled: boolean): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: { entitled, updatedAt: Date.now() } });
  }

  subscribe(listener: (entitled: boolean) => void): () => void {
    const handler = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== "local") return;
      const stored = changes[STORAGE_KEY]?.newValue as StoredEntitlement | undefined;
      if (typeof stored?.entitled === "boolean") listener(stored.entitled);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }
}

