/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project API key (public, send-only). Absent → no analytics. */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog ingestion host, e.g. https://us.i.posthog.com. */
  readonly VITE_POSTHOG_HOST?: string;
  /** Hosted Supabase project URL (publishable). Absent → the screen stays local-only. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon/publishable key (client-side by design). */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** The designated App Review sign-in address (plan 2026-07-15-002 R13) — APPLE BUILD ONLY.
   * The value never lives in the repo; absent → the review branch is unreachable (fail closed)
   * and every address gets normal OTP. Extension builds must never set this. */
  readonly VITE_REVIEW_SIGNIN_EMAIL?: string;
  /** Developer opt-in for the D04 settings screen over committed (atomic) App Group settings.
   * Only the exact value "true" in a build WITHOUT Supabase configuration selects it, and only
   * inside the native host. Converting the App Group record is one-way; never set this for a
   * store build. Absent → the legacy settings screen, byte-for-byte as before. */
  readonly VITE_APPLE_ATOMIC_SETTINGS?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
