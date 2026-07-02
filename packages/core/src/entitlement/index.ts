export type {
  EntitlementAdapter,
  EntitlementCacheOptions,
  EntitlementRecord,
  EntitlementRecordStore,
} from "./cache.js";
export { EntitlementCache } from "./cache.js";
export { InMemoryEntitlementAdapter } from "./adapter.js";
export { ChromeEntitlementAdapter, ENTITLEMENT_CACHE_TTL_MS } from "./chrome-adapter.js";

