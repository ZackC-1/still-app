import { createClient } from "@supabase/supabase-js";
import { browser } from "wxt/browser";
import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import { ChromeEntitlementAdapter } from "@still/core/entitlement";
import { refreshRuleSetCache, ruleSetFetchConfig, type RuleSetEndpoint } from "@still/core/rules";
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
  isSessionRequest,
  unavailableResponse,
  type SessionRequest,
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
//   • DNR gating (Chromium only): the static Shorts-redirect ruleset (KTD1) is enabled only when
//     YouTube is on globally and youtube.com isn't paused. The Firefox build ships no DNR ruleset
//     (it redirects via the content script), so that wiring bails cleanly when the API is absent.
const RULESET_ID = "youtube-shorts-redirect";

/** The signed rule-set RPC endpoint, from the gitignored build-time .env. Absent in CI/dev → null,
 * so the fetch is skipped and the content script applies the bundled seed. */
function ruleSetEndpointFromEnv(): RuleSetEndpoint | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return url && anonKey ? { url, anonKey } : null;
}

export default defineBackground(() => {
  const ruleSetCfg = ruleSetFetchConfig({
    prod: import.meta.env.PROD,
    endpoint: ruleSetEndpointFromEnv(),
  });

  // Refresh on cold start / service-worker wake.
  void refreshRuleSetCache(ruleSetCfg, chrome.storage.local);

  // ── Auth/purchase session spine (plan U6/R2) ───────────────────────────────────────────────────
  const cache = new SettingsCache(new ChromeStorageAdapter());
  const session = createSessionSpine(cache);

  // Content-script nudge — the ONLY handler a content-script sender may reach (plan KTD sender
  // rule; these scripts run inside instagram/tiktok/facebook/youtube pages). Fired at
  // document_start, which also wakes this worker: refresh the rule-set cache, and let the session
  // decide whether a reconcile is due (session + pending checkout or stale cache, R4/AE3 — the
  // staleness/throttle logic lives in core's onNudge).
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (message && typeof message === "object" && (message as { kind?: string }).kind === "reconcile") {
      void refreshRuleSetCache(ruleSetCfg, chrome.storage.local);
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
  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean => {
      if (!isSessionRequest(message)) return false;
      const fromExtensionPage =
        sender.id === chrome.runtime.id &&
        typeof sender.url === "string" &&
        sender.url.startsWith(extensionOrigin);
      if (!fromExtensionPage) return false;
      // .catch guards a sendResponse that throws when the requesting popup's port already closed
      // (the popup dies on focus loss — e.g. right after createCheckout opens a tab, F10).
      void dispatchSession(session, message)
        .then(sendResponse)
        .catch(() => {
          /* popup port closed before the response landed — nothing to deliver */
        });
      return true; // keep the channel open for the async sendResponse
    },
  );

  // Resume on EVERY background start (R2 hard rule): restart the sync write-through from the
  // CACHED entitlement — no network. A worker that wakes on a settings edit must not drop paid
  // sync, and must not burn a live RevenueCat query per wake; live reconcile stays on the R4
  // triggers (popup open, qualifying nudge).
  void session?.resume();

  cache.watch();
  const hydrated = cache.hydrate();

  // ── DNR gating — Chromium only from here down. ───────────────────────────────────────────────
  if (!chrome.declarativeNetRequest?.updateEnabledRulesets) return;

  const syncRuleset = async (): Promise<void> => {
    const s = cache.current();
    const enabled = s.globalOn && s.services.youtube && !s.pauses.includes("youtube.com");
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

/** Dispatch one validated session request. Structured outcomes only — a spine-less build or a
 * torn handler answers the action's unavailable-style outcome, never a throw across the boundary
 * (the session itself never throws; this guards the seam anyway). */
async function dispatchSession(
  session: ExtensionSession | null,
  request: SessionRequest,
): Promise<unknown> {
  if (session === null) return unavailableResponse(request.action);
  try {
    switch (request.action) {
      case "getState":
        return await session.getState();
      case "requestCode":
        return await session.requestCode(request.email);
      case "verifyCode":
        return await session.verifyCode(request.email, request.token);
      case "signOut":
        return await session.signOut();
      case "deleteAccount":
        return await session.deleteAccount();
      case "reconcile":
        return await session.reconcile();
      case "restore":
        return await session.restore();
      case "createCheckout":
        return await session.createCheckout();
      case "setPendingOtp":
        await session.setPendingOtp(request.pending);
        return "ok";
      case "setPurchaseIntent":
        await session.setPurchaseIntent(request.active);
        return "ok";
      case "setCheckoutPending":
        await session.setCheckoutPending(request.pending);
        return "ok";
    }
  } catch {
    return unavailableResponse(request.action);
  }
}
