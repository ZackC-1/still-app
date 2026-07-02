// @still/core/sync — passwordless email auth (magic link + OTP code) and entitlement-gated
// settings sync (R6/R7/R8, plan U2/R1).

export type {
  AuthPort,
  CodeAuthPort,
  RequestCodeOutcome,
  VerifyCodeOutcome,
  BackendPort,
  EntitlementRead,
} from "./ports.js";
export { SyncService, type SyncState, type LastSyncedIdentityStore } from "./service.js";
export { SupabaseAuthPort } from "./auth.js";
export { SupabaseBackendPort } from "./profile.js";
export {
  createAppleSession,
  type AppleSession,
  type AppleSessionBridge,
  type AppleSessionDeps,
} from "./apple-session.js";
