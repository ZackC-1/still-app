import type { StillSettings } from "@still/shared-types";

// The two ports the sync layer depends on. Real implementations wrap @supabase/supabase-js
// (auth.ts, profile.ts); tests inject mocks. Keeping these abstract makes the coordination logic
// in SyncService unit-testable without a live backend.

export interface AuthPort {
  /** Send a magic link. Returns an error string on failure (e.g. rate limit), else nothing. */
  signInWithMagicLink(email: string): Promise<{ error?: string }>;
  signOut(): Promise<void>;
  /** The current session's user UUID, or null if signed out. */
  currentUserId(): Promise<string | null>;
}

export interface BackendPort {
  /** Invoke the reconcile-entitlement Edge Function for the signed-in user (self-heals webhooks). */
  reconcileEntitlement(): Promise<void>;
  /** Read the signed-in user's still_sync entitlement. */
  readEntitlement(): Promise<boolean>;
  /** Read the signed-in user's cloud settings, or null if none stored yet. */
  readProfile(): Promise<StillSettings | null>;
  /** Upsert the signed-in user's cloud settings. */
  writeProfile(settings: StillSettings): Promise<void>;
}
