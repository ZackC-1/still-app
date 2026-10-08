import { CONSENT_KEY, readAnalyticsPermission } from "./consent.js";
import type { AnalyticsKeyValue } from "./identity.js";
import { boundedNativeRead, type NativeBridge } from "../native/bridge.js";

/** Reuse createStoredConsent with the existing shared Apple App Group consent slot. */
export function createAppleConsentStore(
  bridge: Pick<
    NativeBridge,
    "observeAnalyticsPermission" | "commitAnalyticsPermission"
  >,
): AnalyticsKeyValue {
  const checkKey = (key: string) => {
    if (key !== CONSENT_KEY) throw new Error("Unsupported Apple consent key");
  };
  return {
    async get(key) {
      checkKey(key);
      const observation = await boundedNativeRead(
        () => bridge.observeAnalyticsPermission(),
        null,
      );
      if (!observation) throw new Error("Apple consent could not be read");
      return observation.permission;
    },
    async set(key, value) {
      checkKey(key);
      const permission =
        value === false ? false : readAnalyticsPermission(value);
      if (permission === null) throw new Error("Invalid combined permission");
      const committed = await boundedNativeRead(
        () => bridge.commitAnalyticsPermission(permission),
        false,
      );
      if (!committed) throw new Error("Apple consent could not be saved");
    },
  };
}
