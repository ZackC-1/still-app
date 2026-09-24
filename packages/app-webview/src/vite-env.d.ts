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
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
