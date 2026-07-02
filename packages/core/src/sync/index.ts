// @still/core/sync — magic-link auth + entitlement-gated settings sync (R6/R7/R8).

export type { AuthPort, BackendPort, EntitlementRead } from "./ports.js";
export { SyncService, type SyncState, type LastSyncedIdentityStore } from "./service.js";
export { SupabaseAuthPort } from "./auth.js";
export { SupabaseBackendPort } from "./profile.js";
export {
  createAppleSession,
  type AppleSession,
  type AppleSessionBridge,
  type AppleSessionDeps,
} from "./apple-session.js";
