import { mount } from "svelte";
import { readAppleBackendProfile, createAppleFulfillmentTransport } from "./backend-profile.js";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import type { AppleProHostDeps } from "@still/core/ui/v3/apple-pro-host";
import type { ApplePurchaseLinkAuthority } from "@still/core/sync";
import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import "@still/core/ui/tokens.css";
import {
  App,
  SAFARI_SURFACE_GUIDANCE,
  UiController,
  appleRestoreBridge,
  appleSettingsCacheOptions,
  appleSettingsHelp,
  appleSettingsToggleReporter,
  createAppleSettingsAuthority,
  openExternalLink,
  selectAppleSettingsMode,
  type AppleSettingsMode,
  type AuthPersistence,
} from "@still/core/ui";
import { SettingsCache, WKWebViewStorageAdapter } from "@still/core/storage";
import { NativeBridge, openNativeDestination, createApplePurchaseAuthority } from "@still/core/native";
import { isAccessUUID, packagedAccessTrust } from "@still/core/entitlement";
import { bindTextScale } from "@still/core/ui/v3/text-scale";
import { createAppAnalytics, type AnalyticsKeyValue } from "@still/core/analytics";
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

// D04 settings (committed atomic authority) needs an explicit build opt-in, and the tested core rule
// then also requires the native port:
//   - atomic-cloud: Supabase configured and VITE_MODERN_SETTINGS_SYNC_ENABLED=true (the modern sync
//     flag Chrome and Firefox share), with per-field modern sync;
//   - atomic-local: no Supabase configuration and VITE_APPLE_ATOMIC_SETTINGS=true (developer builds).
// The inline build-time check can only narrow to the legacy screen: Vite inlines these env values,
// so every default build (configured or not, with any other flag value) folds this to "legacy" and
// drops the D04 module, its global stylesheet and the modern backend option from the bundle.
const appleSettingsMode: AppleSettingsMode =
  (import.meta.env.VITE_APPLE_ATOMIC_SETTINGS === "true" &&
    !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)) ||
  (import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" &&
    import.meta.env.VITE_SUPABASE_URL &&
    import.meta.env.VITE_SUPABASE_ANON_KEY)
    ? selectAppleSettingsMode({
        atomicSettingsFlag: import.meta.env.VITE_APPLE_ATOMIC_SETTINGS,
        modernSyncFlag: import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED,
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        nativePort: new NativeBridge().available,
      })
    : "legacy";

// The ONE settings cache and writer. Atomic modes initialize the App Group record through native
// with unknown ownership (a one-way conversion); the legacy screen keeps exactly the construction
// it always had.
const appleSettingsAdapter =
  appleSettingsMode !== "legacy" ? new WKWebViewStorageAdapter() : undefined;
const cache = appleSettingsAdapter
  ? new SettingsCache(appleSettingsAdapter, appleSettingsCacheOptions(appleSettingsMode))
  : new SettingsCache(new WKWebViewStorageAdapter());
cache.watch();
// A failed atomic initialization is a held state the screen shows and can retry; never unhandled.
if (appleSettingsAdapter) void cache.hydrate().catch(() => {});
else void cache.hydrate();

const bridge = new NativeBridge();

// Supabase is configured at build time (gitignored packages/app-webview/.env). Absent in CI/dev
// builds → the screen stays local-only (the U17 behavior), so the build never needs secrets.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
// The explicit route profile must agree with packaged proof trust. QA also requires modern sync;
// a malformed bundle keeps local settings usable and never constructs a network client.
const backendRouteProfile = readAppleBackendProfile(
  import.meta.env.VITE_BACKEND_ROUTE_PROFILE,
  import.meta.env.VITE_ACCESS_ENVIRONMENT,
  appleSettingsMode === "atomic-cloud",
);

let controller: UiController;
let identifyOnServer: (() => Promise<void>) | undefined;
// Product analytics (packages/core/src/analytics/apple-app.ts). The native side owns the ids and
// the "Share usage data" switch; this owns the client. It waits for the native context and does
// nothing outside the app or in a build without a PostHog key.
const analytics = createAppAnalytics({
  bridge,
  config: {
    key: import.meta.env.VITE_POSTHOG_KEY,
    host: import.meta.env.VITE_POSTHOG_HOST,
  },
  store: storageKeyValue(safeStorage()),
  identifyOnServer: () => identifyOnServer?.() ?? Promise.resolve(),
});
let onGet: (() => void) | undefined;
let onRestore: (() => void) | undefined;
// Configured modern builds use issuer proofs and the native atomic installer.
let applePurchaseAuthority: {
  refreshAccountAccess: NonNullable<AppleProHostDeps["refreshAccountAccess"]>;
  verifyLocalPurchase: AppleProHostDeps["verifyLocalPurchase"];
  readLinkEligibility: AppleProHostDeps["readLinkEligibility"];
  ownershipRevision: AppleProHostDeps["ownershipRevision"];
  purchaseLink: ApplePurchaseLinkAuthority;
} | undefined;
let appleProServices: Pick<AppleProHostDeps,
  "bridge" | "refreshAccountAccess" | "verifyLocalPurchase" | "readLinkEligibility" | "ownershipRevision" | "linkPurchase"> | undefined;

if (supabaseUrl && supabaseAnonKey && backendRouteProfile) {
  const sessionStorage = safeStorage();
  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storage: sessionStorage },
  });
  identifyOnServer = async () => {
    const { error } = await supabase.functions.invoke("analytics-identify", { body: {} });
    if (error) throw error;
  };
  // Deterministic App Review sign-in (plan 2026-07-15-002, R13): Apple-build-only env. Both the
  // gate and the value are build-time — extension builds never define this, so the review branch
  // is dead code everywhere else (fail closed; gate-production-trust-by-build-mode).
  const reviewEmail = import.meta.env.VITE_REVIEW_SIGNIN_EMAIL;
  const authPort = new SupabaseAuthPort(
    supabase,
    undefined,
    reviewEmail ? { email: reviewEmail } : undefined,
  );
  if (appleSettingsMode !== "legacy" && PAID_TIER_ENABLED && bridge.available) {
    const fulfillment = createAppleFulfillmentTransport(
      backendRouteProfile,
      (name, options) => supabase.functions.invoke(name, options),
    );
    const authority = createApplePurchaseAuthority({
      trust: packagedAccessTrust({
        environment: import.meta.env.VITE_ACCESS_ENVIRONMENT,
        publicKeys: import.meta.env.VITE_ACCESS_PUBLIC_KEYS,
      }),
      bridge,
      readVerifiedAccount: () => authPort.currentVerifiedAccount(),
      readAccessToken: async () => {
        const before = await supabase.auth.getSession();
        if (before.error || !before.data.session) return null;
        const account = await authPort.currentVerifiedAccount();
        const after = await supabase.auth.getSession();
        if (after.error || !account?.emailConfirmed || account.id !== before.data.session.user.id ||
          after.data.session?.access_token !== before.data.session.access_token) return null;
        // Consistency hint only: native verifies the bearer against hosted Auth twice.
        let sessionId: string | undefined;
        try {
          const payload = JSON.parse(atob(before.data.session.access_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as {session_id?: unknown};
          if (isAccessUUID(payload.session_id)) sessionId = payload.session_id;
        } catch { /* An unreadable session remains unavailable to account proof reconciliation. */ }
        return { accountId: account.id, accessToken: before.data.session.access_token, sessionId };
      },
      verifyLocal: fulfillment.verifyLocal,
      fulfillLink: fulfillment.fulfillLink,
    });
    applePurchaseAuthority = authority;
    // This callback does no SDK work: Supabase holds its auth lock while notifying listeners.
    supabase.auth.onAuthStateChange(event => {
      if (event !== "INITIAL_SESSION") authority.invalidateAccount();
    });
    void authority.refreshOwnership().catch(() => {});
    // This refresh issues device-local proofs only; it never links an account on launch.
    void authority.verifyLocalPurchase().catch(() => {});
  }
  // atomic-cloud syncs the committed record per field through the modern sync function; every
  // other configured build keeps exactly the legacy whole-record construction.
  const backend =
    appleSettingsMode === "atomic-cloud"
      ? new SupabaseBackendPort(supabase, { modernSettings: true, routeProfile: backendRouteProfile })
      : new SupabaseBackendPort(supabase, { routeProfile: backendRouteProfile });

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
    analytics: analytics.ui,
    persistence,
    auth: {
      // Email-code sign-in — the SAME flow as the browser extensions (founder call 2026-07-06:
      // one identity story on every surface, so one purchase provably follows one email; Sign in
      // with Apple would mint a different Supabase user than the same person's email sign-in in
      // Chrome/Firefox and strand the entitlement). The magic-LINK path is deliberately NOT wired
      // on this host: the link completes in the default browser, which can never hand the session
      // back to this WKWebView.
      requestCode: (email) => authPort.requestCode(email),
      currentVerifiedAccount: () => authPort.currentVerifiedAccount(),
      // Session side effects belong in the host closure (UiAuth contract), but the orchestration
      // lives in the TESTED AppleSession module (this file is thin wiring): a verified code AWAITS
      // the full session entry — RevenueCat keyed to the Supabase UUID (KTD5), reconcile,
      // App-Group mirror, paywall price — so the controller's post-verified continuations
      // (purchase-intent paywall, Restore) never run against an unconfigured RevenueCat.
      verifyCode: async (email, token) => {
        const outcome = await authPort.verifyCode(email, token);
        if (outcome.kind === "verified") await session.onCodeVerified(outcome.userId, outcome.email ?? null);
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
    purchaseLinkMode: appleSettingsMode === "legacy" ? "legacy" : "explicit",
    purchaseLink: applePurchaseAuthority?.purchaseLink,
    onNativeAccountStatusPublished: applePurchaseAuthority
      ? () => window.dispatchEvent(new Event("still:accountAccess")) : undefined,
    refreshAccountAccess: applePurchaseAuthority ? async () => {
      await applePurchaseAuthority!.refreshAccountAccess();
      window.dispatchEvent(new Event("still:accountAccess"));
    } : undefined,
    exchangeAppleCredential: async (cred) => {
      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: "apple",
        token: cred.identityToken,
        nonce: cred.nonce,
      });
      if (error || !data.user) return { error: error?.message ?? "Sign in failed" };
      return { userId: data.user.id };
    },
    onAccountEntered: (userId) => void analytics.identifyAccount(userId),
    onAccountAbsent: () => void analytics.accountAbsent(),
  });

  if (appleSettingsMode !== "legacy" && PAID_TIER_ENABLED && applePurchaseAuthority) {
    appleProServices = {
      bridge,
      refreshAccountAccess: applePurchaseAuthority.refreshAccountAccess,
      verifyLocalPurchase: applePurchaseAuthority.verifyLocalPurchase,
      readLinkEligibility: applePurchaseAuthority.readLinkEligibility,
      ownershipRevision: applePurchaseAuthority.ownershipRevision,
      linkPurchase: intent => session.linkPurchase(intent),
    };
  }
  controller.retrySync = () => sync.retryNow();
  window.addEventListener("online", () => void sync.retryNow());

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
        purchaseIntent: appleSettingsMode === "legacy" && (await sessionStorage.getItem(PURCHASE_INTENT_KEY)) === "1",
      });
    } catch {
      /* unreadable record — the user simply starts from the email field */
    }
  })();

  // Resume an existing Supabase session on launch. The userId guard closes the slow-network race
  // where the user completes a fresh code sign-in before this launch check resolves — without it,
  // two enterSession pipelines (possibly for different identities) would interleave.
  // Analytics sends nothing until the resume confirms the account (onAccountEntered) or its absence
  // (onAccountAbsent); a launch without a session never sends the previous account's events.
  void session.resumeAccount(() => authPort.currentAccount());

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
  controller = new UiController({ cache, host: { canPurchase: true }, analytics: analytics.ui });
  // No account can exist in a build without sync; let go of any recorded earlier.
  void analytics.accountAbsent();
  if (bridge.available) void bridge.setAccountSyncStatus(null).catch(() => {});
}

void analytics.start();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void analytics.recheckSetup();
});

if (appleSettingsAdapter) void mountAppleScreens(appleSettingsAdapter);
else
  mount(App, {
    target: document.getElementById("app")!,
    props: {
      controller,
      onGet,
      onRestore,
      surfaceGuidance: SAFARI_SURFACE_GUIDANCE,
    },
  });

/** D12 onboarding first, only when the one native gate hands it to the web view; then D04. Never
 * rejects: a failure anywhere (loading the onboarding, mounting it, mounting settings) ends with
 * settings requested once, so the app is never left blank by an unhandled rejection. The native
 * gate stays incomplete on those paths, so onboarding is offered again next launch. */
async function mountAppleScreens(adapter: WKWebViewStorageAdapter): Promise<void> {
  // Text size follows Dynamic Type on iPhone and iPad, live (owner decision 51; proven on the iOS
  // simulator through -apple-system-body); the Mac app stays at the normal size. Only the D04/D12
  // screens read it: the legacy screen never reaches this branch.
  bindTextScale(document, "apple");
  let settingsRequested = false;
  const showSettings = (): void => {
    if (settingsRequested) return;
    settingsRequested = true;
    void mountAppleSettings(adapter).catch(() => {
      /* nothing left to fall back to; the error must not escape as an unhandled rejection */
    });
  };
  try {
    const { showAppleOnboardingFirst } = await import("./apple-onboarding.js");
    await showAppleOnboardingFirst({
      bridge,
      target: document.getElementById("app")!,
      showSettings,
    });
  } catch {
    showSettings();
  }
}

/** D04 over the same cache: committed binding + read-only native access, mounted at once. */
async function mountAppleSettings(adapter: WKWebViewStorageAdapter): Promise<void> {
  const { default: AppleSettingsHost } = await import("./AppleSettingsHost.svelte");
  const authority = createAppleSettingsAuthority(cache, {
    native: bridge,
    initializer: adapter,
    hydration: cache.whenHydrated(),
  });
  try {
    mount(AppleSettingsHost, {
      target: document.getElementById("app")!,
      props: {
        controller,
        authority,
        observeSetup: () => bridge.observeSafariSetup(),
        help: appleSettingsHelp((url) => openExternalLink(url)),
        restoreBridge: appleRestoreBridge(bridge),
        proServices: appleProServices,
        // "Open Safari Settings" on the setup card: one fixed destination, from the tap.
        openDestination: (destination) => void openNativeDestination(destination),
        onCommittedToggle: appleSettingsToggleReporter(analytics.ui),
      },
    });
  } catch (error) {
    authority.stop();
    throw error;
  }
}

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

/** The analytics queue over the same storage (JSON values). */
function storageKeyValue(storage: SupportedStorage): AnalyticsKeyValue {
  return {
    async get(key) {
      const raw = await storage.getItem(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await storage.setItem(key, JSON.stringify(value));
    },
  };
}
