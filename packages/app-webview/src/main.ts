import { mount } from "svelte";
import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import "@still/core/ui/tokens.css";
import { App, UiController } from "@still/core/ui";
import { SettingsCache, WKWebViewStorageAdapter } from "@still/core/storage";
import { NativeBridge } from "@still/core/native";
import { SupabaseAuthPort, SupabaseBackendPort, SyncService } from "@still/core/sync";

// Entry for the Apple app's WKWebView settings screen. Settings persist through the native App-Group
// bridge (U17). U19 wires native auth + purchase on top:
//   • Sign in with Apple runs natively (NativeBridge → AuthenticationServices) and the identity token
//     is exchanged for a Supabase session via signInWithIdToken — the existing, tested web SyncService
//     then owns reconcile + entitlement-gated sync (no sync logic is duplicated in Swift).
//   • The paywall buy/restore run natively (NativeBridge → StoreKit/RevenueCat), keyed to the Supabase
//     UUID (KTD5 — configured only after sign-in, never anonymously).
// The UI gates on the Supabase entitlement (written by the RevenueCat→Supabase webhook, U14), surfaced
// through SyncService — not the client RevenueCat CustomerInfo, which only gives immediate buy feedback.

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
  const sync = new SyncService(cache, authPort, backend, (state) => {
    controller.userId = state.userId;
    controller.entitled = state.entitled;
    controller.cloudReachable = state.cloudReachable;
  });

  // Sign-out resets the native RevenueCat identity (when in the WKWebView host), but the Supabase
  // session must clear regardless — the native reset is best-effort so a rejected bridge call can't
  // strand a live session (KTD5).
  const signOutEverywhere = async (): Promise<void> => {
    if (bridge.available) {
      try {
        await bridge.signOut();
      } catch {
        /* native reset failed — still clear the Supabase session below */
      }
    }
    await sync.signOut();
  };

  // Account deletion deletes server-side + clears the Supabase session (sync.deleteAccount), then
  // resets the native RevenueCat identity so the deleted user's app_user_id isn't left configured.
  const deleteAccountEverywhere = async (): Promise<void> => {
    await sync.deleteAccount(); // throws on backend failure → UI surfaces it, session intact
    if (bridge.available) {
      try {
        await bridge.signOut();
      } catch {
        /* account already deleted + session cleared; native reset is best-effort */
      }
    }
  };

  controller = new UiController({
    cache,
    host: { canPurchase: true },
    auth: {
      signIn: (email) => authPort.signInWithMagicLink(email),
      signOut: signOutEverywhere,
      deleteAccount: deleteAccountEverywhere,
    },
  });

  // Establish a session: configure RevenueCat for the UUID (KTD5), then reconcile + mirror via
  // SyncService, showing the entitlement-pending state while reconcile is in flight.
  const enterSession = async (userId: string): Promise<void> => {
    controller.reconciling = true;
    try {
      if (bridge.available) await bridge.configurePurchases(userId);
      await sync.onSignedIn(userId);
      // Load the localized store price for the paywall CTA (fire-and-forget — RevenueCat is configured
      // now, so the offering price is available; the CTA shows it instead of a hardcoded value).
      if (bridge.available) void bridge.price().then((p) => (controller.paywallPrice = p));
    } finally {
      controller.reconciling = false;
    }
  };

  // Resume an existing Supabase session on launch.
  void supabase.auth.getUser().then(({ data }) => {
    if (data.user) void enterSession(data.user.id);
  });

  // Native actions only exist inside the WKWebView host.
  if (bridge.available) {
    onSignInWithApple = () =>
      void (async () => {
        controller.authFlow = "sending";
        controller.authError = null;
        try {
          const cred = await bridge.signInWithApple();
          const { data, error } = await supabase.auth.signInWithIdToken({
            provider: "apple",
            token: cred.identityToken,
            nonce: cred.nonce,
          });
          if (error || !data.user) {
            controller.authFlow = "error";
            controller.authError = error?.message ?? "Sign in failed";
            return;
          }
          controller.authFlow = "idle";
          await enterSession(data.user.id);
        } catch (e) {
          controller.authFlow = "error";
          controller.authError = e instanceof Error ? e.message : String(e);
        }
      })();

    onGet = () =>
      void (async () => {
        try {
          if (controller.userId) {
            await enterSession(controller.userId);
            if (controller.entitled) {
              controller.dismissPaywall();
              return;
            }
            if (!controller.cloudReachable) {
              controller.setPurchaseOutcome({
                outcome: "failed",
                entitled: false,
                error: "Couldn't check your account online. Try again when connected.",
              });
              return;
            }
          }
          const result = await bridge.purchaseStillSync();
          // Surface every outcome (cancelled/pending/failed/no-offering) in the still-open paywall.
          controller.setPurchaseOutcome(result);
          // The webhook writes the Supabase entitlement; re-reconcile before dismissing into Pro. Local
          // RevenueCat CustomerInfo is immediate feedback, not authority for Pro UI/engine gating.
          if (result.entitled && controller.userId) {
            await enterSession(controller.userId);
            if (controller.entitled) {
              controller.dismissPaywall();
            } else {
              controller.setPurchaseOutcome({ outcome: "pending", entitled: false });
            }
          }
        } catch (e) {
          // A rejected native call must resolve the flow to a visible failed state — never leave the
          // CTA stuck disabled in "purchasing".
          controller.setPurchaseOutcome({
            outcome: "failed",
            entitled: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();

    onRestore = () =>
      void (async () => {
        try {
          const restored = await bridge.restore();
          controller.setRestoreOutcome(restored);
          if (restored && controller.userId) {
            await enterSession(controller.userId);
            if (controller.entitled) {
              controller.dismissPaywall();
            } else {
              controller.setPurchaseOutcome({ outcome: "pending", entitled: false });
            }
          }
        } catch {
          controller.setRestoreOutcome(false); // a rejected restore unsticks the CTA
        }
      })();

    // Ask-to-Buy: a "pending" purchase is approved out-of-band (e.g. by a parent). Re-reconcile when
    // the app returns to the foreground so the entitlement lands in-session, not only on relaunch.
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        controller.purchaseFlow === "pending" &&
        controller.userId &&
        !controller.reconciling
      ) {
        const userId = controller.userId;
        void (async () => {
          await enterSession(userId);
          if (controller.entitled) controller.dismissPaywall();
        })();
      }
    });
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
