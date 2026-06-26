import type { EntitlementAdapter } from "./cache.js";

const STORAGE_KEY = "still:entitlement";

/**
 * Offline TTL for a cached entitlement (monetization plan P1). A stored entitled flag is honored for
 * at most this long without a fresh server write; past it the cache is ignored and the user falls
 * back to free until the next successful reconcile. Bounds offline replay of a stale (or refunded)
 * Pro grant.
 */
export const ENTITLEMENT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface StoredEntitlement {
  readonly entitled?: unknown;
  readonly updatedAt?: unknown;
}

// NOTE (U10 follow-on): this cache is still soft client-side enforcement — an unsigned boolean a
// DevTools user can forge. The committed design replaces it with a server-signed asymmetric token
// (subject-bound + revocable) verified here against a bundled public key, plus clearing on
// sign-out / identity-switch / account-deletion. Until that writer ships, nothing writes this key in
// production, so the cache reads free by default; the TTL below is the first hardening increment.
export class ChromeEntitlementAdapter implements EntitlementAdapter {
  /** Clock injection point so tests can exercise TTL expiry deterministically. */
  constructor(private readonly now: () => number = Date.now) {}

  async get(): Promise<boolean | null> {
    const record = await chrome.storage.local.get(STORAGE_KEY);
    const stored = record[STORAGE_KEY] as StoredEntitlement | undefined;
    if (typeof stored?.entitled !== "boolean") return null;
    // Drop a stale cache past the TTL so an entitled flag can't unlock Pro forever offline. A cached
    // not-entitled also drops, which is harmless (free is the safe default). A missing/garbage
    // timestamp is treated as expired — never trust an unbounded grant.
    if (typeof stored.updatedAt !== "number" || this.now() - stored.updatedAt > ENTITLEMENT_CACHE_TTL_MS) {
      return null;
    }
    return stored.entitled;
  }

  async set(entitled: boolean): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: { entitled, updatedAt: this.now() } });
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

