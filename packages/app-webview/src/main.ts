import { mount } from "svelte";
import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import "@still/core/ui/tokens.css";
import { App, UiController } from "@still/core/ui";
import { SettingsCache, WKWebViewStorageAdapter } from "@still/core/storage";
import { NativeBridge } from "@still/core/native";
import {
  SupabaseAuthPort,
  SupabaseBackendPort,
  SyncService,
  createAppleSession,
  type AppleSession,
} from "@still/core/sync";

// Entry for the Apple app's WKWebView settings screen — THIN WIRING ONLY. Settings persist through
// the native App-Group bridge (U17); the auth/purchase/entitlement orchestration (U19) lives in
// core's tested AppleSession module: Sign in with Apple runs natively and the identity token is
// exchanged for a Supabase session; buy/restore run natively (StoreKit/RevenueCat) keyed to the
// Supabase UUID (KTD5); the UI gates on the Supabase entitlement surfaced through SyncService.

const cache = new SettingsCache(new WKWebViewStorageAdapter());
cache.watch();
void cache.hydrate();

const bridge = new NativeBridge();

// Supabase is configured at build time (gitignored packages/app-webview/.env). Absent in CI/dev
// builds → the screen stays local-only (the U17 behavior), so the build never needs secrets.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let controller: UiController;
let onSignInWithApple: (() => void) | undefined;
let onGet: (() => void) | undefined;
let onRestore: (() => void) | undefined;

if (supabaseUrl && supabaseAnonKey) {
  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storage: safeStorage() },
  });
  const authPort = new SupabaseAuthPort(supabase);
  const backend = new SupabaseBackendPort(supabase);

  // The orchestrator, controller, and SyncService form a construction cycle (the session projects
  // sync state into the controller; the controller's auth actions call the session). Forward-declare
  // the session — it is assigned before any callback can fire.
  // eslint-disable-next-line prefer-const -- assigned once below; must be declared before the closures that capture it
  let session: AppleSession;
  const sync = new SyncService(cache, authPort, backend, (state) => session.onSyncState(state));

  controller = new UiController({
    cache,
    host: { canPurchase: true },
    auth: {
      signIn: (email) => authPort.signInWithMagicLink(email),
      signOut: () => session.signOutEverywhere(),
      deleteAccount: () => session.deleteAccountEverywhere(),
    },
  });

  session = createAppleSession({
    controller,
    sync,
    bridge,
    exchangeAppleCredential: async (cred) => {
      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: "apple",
        token: cred.identityToken,
        nonce: cred.nonce,
      });
      if (error || !data.user) return { error: error?.message ?? "Sign in failed" };
      return { userId: data.user.id };
    },
  });

  // Resume an existing Supabase session on launch.
  void supabase.auth.getUser().then(({ data }) => {
    if (data.user) void session.enterSession(data.user.id);
  });

  // Native actions only exist inside the WKWebView host.
  if (bridge.available) {
    onSignInWithApple = () => void session.onSignInWithApple();
    onGet = () => void session.onGet();
    onRestore = () => void session.onRestore();
    document.addEventListener("visibilitychange", () =>
      session.onVisibilityChange(document.visibilityState),
    );
  }
} else {
  controller = new UiController({ cache, host: { canPurchase: true } });
}

mount(App, {
  target: document.getElementById("app")!,
  props: { controller, onSignInWithApple, onGet, onRestore },
});

/** localStorage with an in-memory fallback — WKWebView's file:// origin can refuse persistent storage,
 * and Supabase auth must not throw on construction. The session then lives for the launch only. */
function safeStorage(): SupportedStorage {
  const mem = new Map<string, string>();
  const ls = (): Storage | null => {
    try {
      const s = globalThis.localStorage;
      const probe = "__still_probe__";
      s.setItem(probe, "1");
      s.removeItem(probe);
      return s;
    } catch {
      return null;
    }
  };
  const store = ls();
  if (store) return store;
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  };
}
