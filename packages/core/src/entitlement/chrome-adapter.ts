import type { EntitlementAdapter, EntitlementRecord, EntitlementRecordStore } from "./cache.js";
import { recordMatchesSession } from "./cache.js";

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
  readonly userId?: unknown;
  readonly updatedAt?: unknown;
}

// NOTE (U10 follow-on): this cache is still soft client-side enforcement — an unsigned record a
// DevTools user can forge. The committed design replaces it with a server-signed asymmetric token
// (subject-bound + revocable) verified here against a bundled public key. The record IS now
// identity-bound (`userId`, R8) and cleared-by-explicit-false on sign-out / identity-switch /
// account-deletion, so multi-account leaks are closed; forging remains bounded by the TTL and by
// rows re-locking on the next reconcile. On Safari the App-Group pull (ext-safari background)
// writes this key from the app's server-reconciled record (no userId — there is no browser
// session); on Chromium the extension session writes it from an authenticated reconcile.
export class ChromeEntitlementAdapter implements EntitlementAdapter, EntitlementRecordStore {
  /** Clock injection point so tests can exercise TTL expiry deterministically. */
  constructor(private readonly now: () => number = Date.now) {}

  async get(): Promise<boolean | null> {
    return (await this.readFresh())?.entitled ?? null;
  }

  /** The stored record, TTL-checked; a `sessionUserId` mismatch with a bound record is "no cache". */
  async getRecord(sessionUserId?: string): Promise<EntitlementRecord | null> {
    const record = await this.readFresh();
    if (!record || !recordMatchesSession(record, sessionUserId)) return null;
    return record;
  }

  async set(entitled: boolean, updatedAt: number = this.now()): Promise<void> {
    await this.setRecord({ entitled, updatedAt }); // no userId: the Safari pull has no session
  }

  /** Writes the record verbatim — always restamping `updatedAt`, so an unchanged `entitled: true`
   * rewrite from a reconcile still refreshes the TTL (R7), and an explicit `entitled: false`
   * write reaches subscribers via storage-change events (teardown never removes the key). */
  async setRecord(record: EntitlementRecord): Promise<void> {
    const { entitled, userId, updatedAt } = record;
    await chrome.storage.local.set({
      [STORAGE_KEY]: userId === undefined ? { entitled, updatedAt } : { entitled, userId, updatedAt },
    });
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

  /** Validate + TTL-check the raw stored value. Drops a stale cache past the TTL so an entitled
   * flag can't unlock Pro forever offline. A cached not-entitled also drops, which is harmless
   * (free is the safe default). A missing/garbage/non-finite timestamp is treated as expired —
   * never trust an unbounded grant. A garbage userId reads as an unbound record. */
  private async readFresh(): Promise<EntitlementRecord | null> {
    const record = await chrome.storage.local.get(STORAGE_KEY);
    const stored = record[STORAGE_KEY] as StoredEntitlement | undefined;
    if (typeof stored?.entitled !== "boolean") return null;
    if (
      typeof stored.updatedAt !== "number" ||
      !Number.isFinite(stored.updatedAt) ||
      this.now() - stored.updatedAt > ENTITLEMENT_CACHE_TTL_MS
    ) {
      return null;
    }
    return {
      entitled: stored.entitled,
      updatedAt: stored.updatedAt,
      ...(typeof stored.userId === "string" ? { userId: stored.userId } : {}),
    };
  }
}
