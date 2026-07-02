import { browser } from "wxt/browser";
import type {
  ExtensionIdentityStore,
  ExtensionSessionStores,
  PersistedSlot,
} from "@still/core/sync";

// chrome.storage.local backings for the extension session's persisted slots (plan U5/U6), in the
// ChromeStorageAdapter style: thin get/set over one distinct key each, no parsing — `get` returns
// the RAW stored value because the session parses every record defensively (garbage reads as
// absent, never a boot throw). Distinct keys keep each record independently clearable and keep the
// settings/entitlement keys the content scripts read untouched.

const PENDING_OTP_KEY = "still:pending-otp";
const CHECKOUT_PENDING_KEY = "still:checkout-pending";
const NUDGE_STAMP_KEY = "still:nudge-stamp";
const LAST_IDENTITY_KEY = "still:last-identity";

function slot<T>(key: string): PersistedSlot<T> {
  return {
    async get(): Promise<unknown> {
      return (await browser.storage.local.get(key))[key] ?? null;
    },
    async set(value: T | null): Promise<void> {
      if (value === null) await browser.storage.local.remove(key);
      else await browser.storage.local.set({ [key]: value });
    },
  };
}

export function createSessionStores(): ExtensionSessionStores {
  return {
    pendingOtp: slot(PENDING_OTP_KEY),
    checkoutPending: slot(CHECKOUT_PENDING_KEY),
    nudgeStamp: slot(NUDGE_STAMP_KEY),
  };
}

/** The last-synced-identity seam (U1/R8/AE5): SyncService's seed guard and the session's
 * identity-switch purge both read it. A non-string read is "no identity ever recorded". */
export function createIdentityStore(): ExtensionIdentityStore {
  return {
    async get(): Promise<string | null> {
      const value = (await browser.storage.local.get(LAST_IDENTITY_KEY))[LAST_IDENTITY_KEY];
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    async set(userId: string): Promise<void> {
      await browser.storage.local.set({ [LAST_IDENTITY_KEY]: userId });
    },
    async clear(): Promise<void> {
      await browser.storage.local.remove(LAST_IDENTITY_KEY);
    },
  };
}
