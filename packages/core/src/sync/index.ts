// @still/core/sync — magic-link auth + entitlement-gated settings sync (R6/R7/R8).

export type { AuthPort, BackendPort } from "./ports.js";
export { SyncService, type SyncState } from "./service.js";
export { SupabaseAuthPort } from "./auth.js";
export { SupabaseBackendPort } from "./profile.js";
