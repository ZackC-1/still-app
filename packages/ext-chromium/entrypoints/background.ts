import { createClient } from "@supabase/supabase-js";
import { browser } from "wxt/browser";
import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import { ChromeEntitlementAdapter } from "@still/core/entitlement";
import {
  isServiceEnabledGlobally,
  createRuleSetRefresher,
} from "@still/core/rules";
import {
  SupabaseAuthPort,
  SupabaseBackendPort,
  SyncService,
  createExtensionSession,
  extensionSupabaseConfig,
  type ExtensionSession,
} from "@still/core/sync";
import { AUTH_STORAGE_KEY, clearExtensionAuthStorage, createAuthStorage } from "../lib/auth-storage.js";
import { createIdentityStore, createSessionStores } from "../lib/session-stores.js";
import {
  createSessionMessageRouter,
} from "../lib/session-messages.js";

// Chromium/Firefox background (Chrome MV3 service worker / Firefox MV3 event page). Three
// independent jobs:
//   • Signed rule-set refresh (parity with the Safari background): fetch → verify against this
//     build's trusted keys → cache for the NEXT page load, so a selector hotfix reaches
//     Chrome/Firefox over the air instead of waiting on a store re-review (KTD13). Skipped (no-op)
//     when no endpoint is configured, or on a production build before production keys are
//     published — in both cases the bundled seed keeps applying.
//   • The auth/purchase session spine (plan U5/U6, R2): this context is the ONE owner of the
//     Supabase session — popup/options are thin mirrors over the runtime-message router below.
//     The whole spine is gated by build-mode env (extensionSupabaseConfig, fail-safe): an
//     unconfigured build has no client and answers every session message with its structured
//     unavailable-style outcome — never a dev fallback.
//   • DNR gating (Chromium only): the static Shorts-redirect ruleset (KTD1) is enabled exactly
//     when the engine considers YouTube on globally — isServiceEnabledGlobally, the same predicate
//     isServiceActive composes (R2), so this gate can't drift from the content script's. The
//     Firefox build ships no DNR ruleset (it redirects via the content script), so that wiring
//     bails cleanly when the API is absent.
const RULESET_ID = "youtube-shorts-redirect";

export default defineBackground(() => {
  const refreshRuleSet = createRuleSetRefresher({
    prod: import.meta.env.PROD,
    url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
    area: chrome.storage.local,
  });

  // Refresh on cold start / service-worker wake.
  void refreshRuleSet();

  // ── Auth/purchase session spine (plan U6/R2) ───────────────────────────────────────────────────
  const cache = new SettingsCache(new ChromeStorageAdapter());
  cache.watch();
  const hydrated = cache.hydrate();
  const session = createSessionSpine(cache);

  // Content-script nudge — the ONLY handler a content-script sender may reach (plan KTD sender
  // rule; these scripts run inside instagram/tiktok/facebook/youtube pages). Fired at
  // document_start, which also wakes this worker: refresh the rule-set cache, and let the session
  // decide whether a reconcile is due (session + pending checkout or stale cache, R4/AE3 — the
  // staleness/throttle logic lives in core's onNudge).
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (message && typeof message === "object" && (message as { kind?: string }).kind === "reconcile") {
      void refreshRuleSet();
      void session?.onNudge();
    }
    return false;
  });

  // Privileged session router (plan KTD sender validation): getState/requestCode/verifyCode/
  // signOut/deleteAccount/reconcile/restore/createCheckout + the persistence setters dispatch ONLY
  // for extension-page senders — same extension id AND an extension-origin URL. The origin check is
  // strictly stronger than a `sender.tab === undefined` test: content scripts carry the page's URL
  // (never the extension origin) so they're still walled off to the nudge, while the EMBEDDED
  // options page (options_ui.open_in_tab:false) — which carries a sender.tab and would be wrongly
  // rejected by a tab check — is correctly allowed (F9). Anything else falls through unanswered (the
  // sender's closures settle to their structured fail-safe). Async responses use the sendResponse +
  // `return true` shape — the one contract both Chrome MV3 and Firefox's chrome-namespace listeners
  // honor; a promise-returning listener would break on Chrome, where the return value is only the
  // keep-alive flag.
  const extensionOrigin = chrome.runtime.getURL("");
  chrome.runtime.onMessage.addListener(createSessionMessageRouter(session, chrome.runtime.id, extensionOrigin));

  // Resume on EVERY background start (R2 hard rule): restart the sync write-through from the
  // CACHED entitlement — no network. A worker that wakes on a settings edit must not drop paid
  // sync, and must not burn a live RevenueCat query per wake; live reconcile stays on the R4
  // triggers (popup open, qualifying nudge).
  void hydrated.then(() => session?.resume());

  // ── DNR gating — Chromium only from here down. ───────────────────────────────────────────────
  if (!chrome.declarativeNetRequest?.updateEnabledRulesets) return;

  const syncRuleset = async (): Promise<void> => {
    // The engine's own URL-free gate (R2) — no re-derived inline predicate. Per-URL pauses don't
    // apply to a global DNR ruleset (and parseSettings normalizes stored pauses to [] anyway).
    const enabled = isServiceEnabledGlobally(cache.current(), "youtube");
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      enabled ? { enableRulesetIds: [RULESET_ID] } : { disableRulesetIds: [RULESET_ID] },
    );
  };

  cache.subscribe(() => void syncRuleset());
  void hydrated.then(syncRuleset);
});

/**
 * Build the background-owned session (plan U5 deps ← U6 wiring), or null when the build carries no
 * Supabase config (the fail-safe: the routers above then answer with structured unavailable-style
 * outcomes). Client config per the extension-session contract: ONE client, `persistSession: true`,
 * `detectSessionInUrl: false`, `autoRefreshToken: false` (refresh is lazy — getSession() on wake),
 * over the chrome.storage.local auth adapter under its distinct storageKey.
 */
function createSessionSpine(cache: SettingsCache): ExtensionSession | null {
  const config = extensionSupabaseConfig(
    import.meta.env.VITE_SUPABASE_URL as string | undefined,
    import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  );
  if (config === null) return null;

  const client = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: createAuthStorage(),
      storageKey: AUTH_STORAGE_KEY,
    },
  });

  const port = new SupabaseAuthPort(client);
  const auth = {
    signInWithMagicLink: (email: string) => port.signInWithMagicLink(email),
    requestCode: (email: string) => port.requestCode(email),
    verifyCode: (email: string, token: string) => port.verifyCode(email, token),
    signOut: () => port.signOut(),
    // Local session read with lazy refresh (the R2 contract): getSession() reads the persisted
    // session and refreshes an expired token. The port's own getUser() is a network round-trip
    // that reads signed-out when offline — it would drop paid sync on every offline wake and
    // break AE6's cached-entitlement guarantee, so it is deliberately not used here.
    currentUserId: async (): Promise<string | null> => {
      const { data } = await client.auth.getSession();
      return data.session?.user.id ?? null;
    },
  };
  const backend = new SupabaseBackendPort(client);
  const identity = createIdentityStore();

  return createExtensionSession({
    auth,
    backend,
    records: new ChromeEntitlementAdapter(),
    sync: new SyncService(cache, auth, backend, undefined, identity),
    identity,
    stores: createSessionStores(),
    // Best-effort teardown of a recorded checkout tab (it still carries the old identity); the
    // session already guards the call, so a missing tab just rejects quietly.
    closeTab: async (tabId: number) => {
      await browser.tabs.remove(tabId);
    },
    // Offline-proof sign-out (F1): drop the persisted session so a failed remote revoke can't leave
    // it on disk for the next wake to resurrect.
    clearAuthStorage: clearExtensionAuthStorage,
  });
}
