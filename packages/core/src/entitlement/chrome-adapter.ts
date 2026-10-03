import { mutateLocalProtection, type LocalProtectionMutation } from "./local-protection.js";
import type { EntitlementAdapter, EntitlementRecord, EntitlementRecordStore } from "./cache.js";
import { recordMatchesSession } from "./cache.js";
import { mutateAccessRecord, parseAccessCacheRecord, type AccessMutation, type AccessCacheRecord } from "./access-record.js";
import { isAccessUUID, type AccessTrust } from "./access-proof.js";
import type { ScopedAccessEvidence } from "./access-policy.js";

const STORAGE_KEY = "still:entitlement";
const NO_ACCESS_TRUST: AccessTrust = { environment: "production", keys: [] };
// One background writer per storage area. Distinct authority instances in that background share
// the same queue; popup/content instances must use the runtime broker instead of get/set CAS.
const queues = new WeakMap<object, Promise<unknown>>();

export interface EntitlementAuthorityOptions {
  readonly authority?: boolean;
  readonly trust?: AccessTrust;
}

/**
 * Offline TTL for a cached entitlement (monetization plan P1). A stored entitled flag is honored for
 * at most this long without a fresh server write; past it the cache is ignored and the user falls
 * back to free until the next successful reconcile. Bounds offline replay of a stale (or refunded)
 * Pro grant.
 */
export const ENTITLEMENT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * The ONE staleness predicate for a stored entitlement stamp, shared by every path that honors a
 * grant (hydrate read, live storage-change forwarding, the Safari App-Group pull). A missing,
 * garbage, or non-finite stamp counts as expired — never trust an unbounded grant.
 */
export function entitlementStampExpired(updatedAt: unknown, now: number): boolean {
  return (
    typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || now - updatedAt > ENTITLEMENT_CACHE_TTL_MS
  );
}

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
  constructor(private readonly now: () => number = Date.now, private readonly options: EntitlementAuthorityOptions = {}) {}

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
    if (!this.options.authority) {
      const reply: unknown = await chrome.runtime.sendMessage({ kind: "setEntitlementRecord", record });
      if (!reply || typeof reply !== "object" || (reply as { ok?: unknown }).ok !== true) throw new Error("Entitlement authority unavailable");
      return;
    }
    await this.serialize(async () => {
      const value: unknown = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Unreadable entitlement record");
      const stored = (value ?? {}) as Record<string, unknown>;
      let access = stored.access;
      if (access !== undefined) {
        const current = parseAccessCacheRecord(access); // corrupt stronger state never becomes fresh
        const accountId = isAccessUUID(record.userId) ? record.userId : null;
        if ((record.userId !== undefined || !record.entitled) && current.accountId !== accountId) {
          access = (await mutateAccessRecord(current, { kind: "account", accountId }, this.options.trust ?? NO_ACCESS_TRUST)).record;
        }
      }
      const { entitled, userId, updatedAt } = record;
      const next: Record<string, unknown> = { ...stored, entitled, updatedAt, ...(access === undefined ? {} : { access }) };
      if (userId === undefined) delete next.userId;
      else next.userId = userId;
      if (new TextEncoder().encode(JSON.stringify(next)).length > 131_072) throw new Error("Access record full");
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
    });
  }

  /** The background owns proof installation/association/revocation. No raw runtime message can
   * supply these commands, a trust bundle, issuer time, or a paid flag. */
  async mutateAccess(mutation: AccessMutation): Promise<{ readonly record: AccessCacheRecord; readonly evidence: readonly ScopedAccessEvidence[] }> {
    if (!this.options.authority) throw new Error("Entitlement write requires background authority");
    return this.serialize(async () => {
      const value: unknown = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Unreadable entitlement record");
      const stored = (value ?? {}) as Record<string, unknown>;
      const current = parseAccessCacheRecord(stored.access);
      const next = await mutateAccessRecord(current, mutation, this.options.trust ?? NO_ACCESS_TRUST);
      if (new TextEncoder().encode(JSON.stringify({ ...stored, access: next.record })).length > 131_072) throw new Error("Access record full");
      await chrome.storage.local.set({ [STORAGE_KEY]: { ...stored, access: next.record } });
      return next; // publish only after durable commit; storage failure leaves prior state authoritative
    });
  }

  /** Internal local host command only. The runtime router exposes no declaration or policy input. */
  async mutateLocalProtection(mutation: LocalProtectionMutation): Promise<AccessCacheRecord> {
    if (!this.options.authority) throw new Error("Entitlement write requires background authority");
    return this.serialize(async () => {
      const value: unknown = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Unreadable entitlement record");
      const stored = (value ?? {}) as Record<string, unknown>;
      const current = parseAccessCacheRecord(stored.access);
      const record = { ...current, localProtection: mutateLocalProtection(current.localProtection ?? null, mutation) };
      const next = { ...stored, access: record };
      if (new TextEncoder().encode(JSON.stringify(next)).length > 131_072) throw new Error("Access record full");
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      return record;
    });
  }

  async observeAccess(): Promise<AccessCacheRecord> {
    if (this.options.authority) return (await this.mutateAccess({ kind: "observe", observation: { wall: this.now() } })).record;
    const reply: unknown = await chrome.runtime.sendMessage({ kind: "observeAccess" });
    if (!reply || typeof reply !== "object" || (reply as { ok?: unknown }).ok !== true) throw new Error("Entitlement authority unavailable");
    return parseAccessCacheRecord((reply as { record?: unknown }).record);
  }

  private serialize<T>(body: () => Promise<T>): Promise<T> {
    const area = chrome.storage.local;
    const next = (queues.get(area) ?? Promise.resolve()).then(body);
    queues.set(area, next.catch(() => undefined));
    return next;
  }

  subscribe(listener: (entitled: boolean) => void): () => void {
    const handler = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== "local") return;
      const stored = changes[STORAGE_KEY]?.newValue as StoredEntitlement | undefined;
      if (typeof stored?.entitled !== "boolean") return;
      // Same TTL discipline as readFresh: a live storage write of an already-expired (or
      // unstamped) entitled:true record must not unlock Pro in subscribed pages until the next
      // hydrate corrects it. An entitled:false always forwards — free is the safe default.
      if (stored.entitled && entitlementStampExpired(stored.updatedAt, this.now())) return;
      listener(stored.entitled);
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
    if (entitlementStampExpired(stored.updatedAt, this.now())) return null;
    return {
      entitled: stored.entitled,
      updatedAt: stored.updatedAt as number,
      ...(typeof stored.userId === "string" ? { userId: stored.userId } : {}),
    };
  }
}
