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

// ── Email-OTP code flow (plan U2/R1) ──────────────────────────────────────────────────────────────
// A separate capability interface, not extra methods on AuthPort: hosts advertise capabilities
// (Apple keeps the magic link; the extension popup can't receive a redirect, so it verifies a
// 6-digit emailed code), and the Apple-shaped wiring + existing AuthPort mocks compile unchanged.
// Outcomes are structured unions — the UI branches on `kind` and shows its own calm copy; raw
// backend error text never reaches a surface (docs/solutions: structured-outcome-over-string).

/** Outcome of asking the backend to email a 6-digit sign-in code. */
export type RequestCodeOutcome =
  | { readonly kind: "sent" }
  /** Rate limit, offline, or any backend failure — the UI shows one calm retry line. */
  | { readonly kind: "send-failed" };

/** Outcome of verifying an entered code. */
export type VerifyCodeOutcome =
  | { readonly kind: "verified"; readonly userId: string }
  /** Wrong or expired token — the server reports both as one error, so they share a kind. */
  | { readonly kind: "invalid-code" }
  /** Offline / unexpected failure: the code may still be good, so this is not an attempt. */
  | { readonly kind: "verify-failed" };

export interface CodeAuthPort {
  /** Email a 6-digit one-time code (no redirect — the code IS the completion step). */
  requestCode(email: string): Promise<RequestCodeOutcome>;
  /** Exchange the emailed code for a session. */
  verifyCode(email: string, token: string): Promise<VerifyCodeOutcome>;
}

export type EntitlementRead = "entitled" | "not-entitled" | "unknown";

export interface BackendPort {
  /** Invoke the reconcile-entitlement Edge Function for the signed-in user (self-heals webhooks). */
  reconcileEntitlement(): Promise<void>;
  /** Read the signed-in user's Still Pro entitlement (DB column `still_sync`). Offline/error
   * returns unknown. */
  readEntitlement(): Promise<EntitlementRead>;
  /** Read the signed-in user's cloud settings, or null if none stored yet. */
  readProfile(): Promise<StillSettings | null>;
  /** Upsert the signed-in user's cloud settings. */
  writeProfile(settings: StillSettings): Promise<void>;
  /** Delete the signed-in user's account (App Store Guideline 5.1.1 / GDPR). The subject is derived
   * from the verified session JWT server-side; cascades profile + entitlement. Throws on failure. */
  deleteAccount(): Promise<void>;
}
