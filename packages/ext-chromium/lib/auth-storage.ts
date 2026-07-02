import { browser } from "wxt/browser";
import type { SupportedStorage } from "@supabase/supabase-js";

// The chrome.storage.local-backed auth storage for the background's Supabase client (plan U6/R2).
// MV3 workers have no localStorage, and supabase-js would otherwise fall back to in-memory storage
// — a session that silently dies with every worker wake. The client is constructed with
// `storageKey: AUTH_STORAGE_KEY`, so the whole session record lives under this one distinct key
// (the trade-off — first-party content scripts could technically read it — is accepted and
// documented in the plan's KTD; page JS can never touch extension storage).

export const AUTH_STORAGE_KEY = "still:auth";

/** Adapter over browser.storage.local. Defensive on every call: Supabase auth must never throw
 * out of storage access (the app-webview safeStorage rule) — a torn read is a signed-out read. */
export function createAuthStorage(): SupportedStorage {
  return {
    async getItem(key: string): Promise<string | null> {
      try {
        const value = (await browser.storage.local.get(key))[key];
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    },
    async setItem(key: string, value: string): Promise<void> {
      try {
        await browser.storage.local.set({ [key]: value });
      } catch {
        /* a failed persist costs re-auth after the worker dies, never a crash */
      }
    },
    async removeItem(key: string): Promise<void> {
      try {
        await browser.storage.local.remove(key);
      } catch {
        /* best-effort — teardown also writes the signed-out state through the session */
      }
    },
  };
}

/** Drop the persisted Supabase session outright (plan U6, F1). Wired as the session's
 * `clearAuthStorage` so a voluntary sign-out is offline-proof: auth-js only removes the local
 * session AFTER a successful server revoke, so a failed/offline sign-out would otherwise leave the
 * session on disk and the next background wake would resurrect the signed-out user. Removes the
 * session record and its PKCE code-verifier sibling; best-effort, never throws. */
export async function clearExtensionAuthStorage(): Promise<void> {
  try {
    await browser.storage.local.remove([AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-code-verifier`]);
  } catch {
    /* best-effort — the SDK sign-out already attempted local removal too */
  }
}
