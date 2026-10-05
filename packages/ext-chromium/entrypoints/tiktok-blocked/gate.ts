/** The packaged build inputs (`import.meta.env`); only the three Supabase/sync names are read. */
export type TiktokBlockedPageBuildEnv = Readonly<Record<string, unknown>>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The one gate for the TikTok blocked page, shared by the content script and the background.
 * It is the same release rule as the V3 popup and settings (lib/modern-settings-runtime.ts
 * `atomicLocal`): unconfigured builds, or configured builds that opted into modern sync. A
 * configured 2.x build (Supabase set, modern sync not opted in) keeps the in-page block.
 * Deliberately import-free: a content script must never reach the sync module graph, which
 * reaches analytics. lib/__tests__/tiktok-blocked-gate.test.ts pins it to `atomicLocal`.
 */
export function tiktokBlockedPageEnabled(env: TiktokBlockedPageBuildEnv): boolean {
  const configured =
    text(env.VITE_SUPABASE_URL).trim().length > 0 && text(env.VITE_SUPABASE_ANON_KEY).trim().length > 0;
  return !configured || env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true";
}
