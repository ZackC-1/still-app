import { extensionSupabaseConfig } from "@still/core/sync";

/** Public packaged inputs only. Modern cloud requires an explicitly supported target;
 * unconfigured builds retain atomic local blocking without constructing a client. */
export function modernSettingsRuntime(
  url: string | undefined,
  anonKey: string | undefined,
  modernSyncOptIn: string | undefined,
) {
  const supabase = extensionSupabaseConfig(url, anonKey);
  const modernCloud = supabase !== null && modernSyncOptIn === "true";
  return {
    supabase,
    atomicLocal: supabase === null || modernCloud,
    modernCloud,
  };
}
