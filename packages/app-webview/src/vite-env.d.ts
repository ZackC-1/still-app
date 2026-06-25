/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Hosted Supabase project URL (publishable). Absent → the screen stays local-only. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon/publishable key (client-side by design). */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
