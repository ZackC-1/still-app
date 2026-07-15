import { mount } from "svelte";
import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import "@still/core/ui/tokens.css";
import { App, SAFARI_SURFACE_GUIDANCE, UiController, type AuthPersistence } from "@still/core/ui";
import { SettingsCache, WKWebViewStorageAdapter } from "@still/core/storage";
import { NativeBridge } from "@still/core/native";
import {
  SupabaseAuthPort,
  SupabaseBackendPort,
  SyncService,
  createAppleSession,
  type AppleSession,
  type LastSyncedIdentityStore,
} from "@still/core/sync";

// Entry for the Apple app's WKWebView settings screen — THIN WIRING ONLY. Settings persist through
// the native App-Group bridge (U17); the auth/purchase/entitlement orchestration (U19) lives in
// core's tested AppleSession module: the user signs in with an emailed 6-digit code (the SAME flow
// as the browser extensions — one identity story on every surface, 2026-07-06; the native Sign in
// with Apple path is retired and unreached pending full excision), then buy/restore run natively
// (StoreKit/RevenueCat) keyed to the Supabase UUID (KTD5); the UI gates on the Supabase
// entitlement surfaced through SyncService.

const cache = new SettingsCache(new WKWebViewStorageAdapter());
cache.watch();
void cache.hydrate();

const bridge = new NativeBridge();

// Supabase is configured at build time (gitignored packages/app-webview/.env). Absent in CI/dev
// builds → the screen stays local-only (the U17 behavior), so the build never needs secrets.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let controller: UiController;
let onGet: (() => void) | undefined;
let onRestore: (() => void) | undefined;

if (supabaseUrl && supabaseAnonKey) {
  const sessionStorage = safeStorage();
  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storage: sessionStorage },
  });
  // Deterministic App Review sign-in (plan 2026-07-15-002, R13): Apple-build-only env. Both the
  // gate and the value are build-time — extension builds never define this, so the review branch
  // is dead code everywhere else (fail closed; gate-production-trust-by-build-mode).
  const reviewEmail = import.meta.env.VITE_REVIEW_SIGNIN_EMAIL;
  const authPort = new SupabaseAuthPort(
    supabase,
    undefined,
    reviewEmail ? { email: reviewEmail } : undefined,
  );
  const backend = new SupabaseBackendPort(supabase);

  // Cross-identity guard (AE5) — parity with the extension: a persisted last-synced Apple identity
  // so a Sign in with Apple that switches Apple IDs (→ a different Supabase UUID) never seeds or
  // LWW-pushes the previous user's local settings into the new account's cloud profile. Backed by
  // the same launch-scoped storage as the session.
  const identity: LastSyncedIdentityStore = {
    get: async () => sessionStorage.getItem("still:last-identity"),
    set: async (userId: string) => void sessionStorage.setItem("still:last-identity", userId),
  };

  // The orchestrator, controller, and SyncService form a construction cycle (the session projects
  // sync state into the controller; the controller's auth actions call the session). Forward-declare
  // the session — it is assigned before any callback can fire.
  // eslint-disable-next-line prefer-const -- assigned once below; must be declared before the closures that capture it
  let session: AppleSession;
  const sync = new SyncService(
    cache,
    authPort,
    backend,
    (state) => session.onSyncState(state),
    identity,
  );

  // AE2 persistence — iOS jettisons the app (and the WKWebView content process can reload) while
  // the user is off reading the code in Mail; relaunch must land back on code entry, not a blank
  // email field (a fresh request would also hit the 60s resend cooldown). Backed by the same
  // launch-scoped safeStorage as the session; best-effort by design (in-memory fallback loses it).
  const PENDING_OTP_KEY = "still:pending-otp";
  const PURCHASE_INTENT_KEY = "still:purchase-intent";
  const persistence: AuthPersistence = {
    setPendingOtp(pending) {
      if (pending === null) sessionStorage.removeItem(PENDING_OTP_KEY);
      else sessionStorage.setItem(PENDING_OTP_KEY, JSON.stringify(pending));
    },
    setPurchaseIntent(active) {
      if (active) sessionStorage.setItem(PURCHASE_INTENT_KEY, "1");
      else sessionStorage.removeItem(PURCHASE_INTENT_KEY);
    },
  };

  controller = new UiController({
    cache,
    host: { canPurchase: true },
    persistence,
    auth: {
      // Email-code sign-in — the SAME flow as the browser extensions (founder call 2026-07-06:
      // one identity story on every surface, so one purchase provably follows one email; Sign in
      // with Apple would mint a different Supabase user than the same person's email sign-in in
      // Chrome/Firefox and strand the entitlement). The magic-LINK path is deliberately NOT wired
      // on this host: the link completes in the default browser, which can never hand the session
      // back to this WKWebView.
      requestCode: (email) => authPort.requestCode(email),
      // Session side effects belong in the host closure (UiAuth contract), but the orchestration
      // lives in the TESTED AppleSession module (this file is thin wiring): a verified code AWAITS
      // the full session entry — RevenueCat keyed to the Supabase UUID (KTD5), reconcile,
      // App-Group mirror, paywall price — so the controller's post-verified continuations
      // (purchase-intent paywall, Restore) never run against an unconfigured RevenueCat.
      verifyCode: async (email, token) => {
        const outcome = await authPort.verifyCode(email, token);
        if (outcome.kind === "verified") await session.onCodeVerified(outcome.userId);
        return outcome;
      },
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

  // AE2 rehydration: a relaunch within the OTP TTL lands straight on code entry for the pending
  // email (rehydrateCodeEntry itself no-ops when moot — code capability absent or already signed
  // in). Corrupted records just fall back to the initial email field.
  void (async () => {
    try {
      // SupportedStorage.getItem is async-capable in its type; both real backings here are sync.
      const raw = await sessionStorage.getItem(PENDING_OTP_KEY);
      if (raw === null) return;
      const pending = JSON.parse(raw) as { email?: unknown; requestedAt?: unknown };
      if (typeof pending.email !== "string") return;
      controller.rehydrateCodeEntry({
        email: pending.email,
        requestedAt: typeof pending.requestedAt === "number" ? pending.requestedAt : undefined,
        purchaseIntent: (await sessionStorage.getItem(PURCHASE_INTENT_KEY)) === "1",
      });
    } catch {
      /* unreadable record — the user simply starts from the email field */
    }
  })();

  // Resume an existing Supabase session on launch. The userId guard closes the slow-network race
  // where the user completes a fresh code sign-in before this launch check resolves — without it,
  // two enterSession pipelines (possibly for different identities) would interleave.
  void supabase.auth.getUser().then(({ data }) => {
    if (data.user && controller.userId === null) void session.enterSession(data.user.id);
  });

  // Native actions only exist inside the WKWebView host. Sign in with Apple is no longer offered
  // (email-code sign-in above is the one auth path, 2026-07-06); the native SIWA bridge + the
  // AppleSession.onSignInWithApple orchestration stay in place but unreached — full excision is
  // deferred to a post-launch cleanup so this change stays off the tested money spine.
  if (bridge.available) {
    onGet = () => void session.onGet();
    onRestore = () => void session.onRestore();
    document.addEventListener("visibilitychange", () =>
      session.onVisibilityChange(document.visibilityState),
    );
    // Purchase-first boot (plan 2026-07-15-001, R1/R17): with NO session, the UI still needs the
    // device's receipt entitlement (a signed-out purchaser's home screen renders Pro) and the
    // localized price (the signed-out paywall CTA shows "· $1.99", loaded here because
    // enterSession — the old only price call site — never runs signed out).
    void session.refreshReceipt();
    void bridge
      .price()
      .then((p) => (controller.paywallPrice = p))
      .catch(() => {
        /* no price → the CTA renders without a suffix; enterSession retries on sign-in */
      });
  }
} else {
  controller = new UiController({ cache, host: { canPurchase: true } });
}

mount(App, {
  target: document.getElementById("app")!,
  props: {
    controller,
    onGet,
    onRestore,
    surfaceGuidance: SAFARI_SURFACE_GUIDANCE,
  },
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
