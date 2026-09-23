import type { AnalyticsKeyValue } from "./identity.js";

// The "Share usage data" switch, per device and never synced: someone who turns it off on one
// computer has made that choice for that computer. Each host decides the default. Chrome and the
// Apple apps start on, with the setup notice and this switch as the off path; Firefox never reads
// this default, because its data-collection permission is the switch there (see the extension).

export const CONSENT_KEY = "still:analytics:enabled";

export interface AnalyticsConsent {
  get(): Promise<boolean>;
  set(enabled: boolean): Promise<void>;
}

export function createStoredConsent(store: AnalyticsKeyValue, defaultOn: boolean): AnalyticsConsent {
  return {
    async get() {
      try {
        const value = await store.get(CONSENT_KEY);
        return typeof value === "boolean" ? value : defaultOn;
      } catch {
        return false; // unreadable: fail closed rather than assume the default
      }
    },
    async set(enabled) {
      await store.set(CONSENT_KEY, enabled);
    },
  };
}
