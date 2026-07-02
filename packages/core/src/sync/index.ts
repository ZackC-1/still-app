// @still/core/sync — passwordless email auth (magic link + OTP code) and entitlement-gated
// settings sync (R6/R7/R8, plan U2/R1).

export type {
  AuthPort,
  CodeAuthPort,
  RequestCodeOutcome,
  VerifyCodeOutcome,
  BackendPort,
  EntitlementRead,
  WebCheckoutOutcome,
  WebCheckoutPort,
  ReconcileCallOutcome,
  CheckedReconcilePort,
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
export {
  createExtensionSession,
  extensionSupabaseConfig,
  NUDGE_STALENESS_MS,
  NUDGE_THROTTLE_MS,
  type ExtensionSupabaseConfig,
  type ExtensionSession,
  type ExtensionSessionDeps,
  type ExtensionSessionState,
  type ExtensionSessionStores,
  type ExtensionSessionSync,
  type ExtensionIdentityStore,
  type PersistedSlot,
  type PendingOtpRecord,
  type CheckoutPendingRecord,
  type SessionReconcileOutcome,
  type NudgeOutcome,
  type ResumeOutcome,
  type SignOutSessionOutcome,
  type DeleteAccountSessionOutcome,
} from "./extension-session.js";
