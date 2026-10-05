import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import { createExtensionUiController } from "@still/core/ui";
import { readAccountStatus } from "../../lib/account-status.js";
import { pushSettingsToApp } from "../../lib/native-settings.js";
import { createSafariPageAnalytics } from "../../lib/analytics.js";
import PopupApp from "./PopupApp.svelte";

// Build the (purchase-free — AE7) controller, then mount the shared UI. No per-site pause control:
// it (and the activeTab grant + tab query that powered it) was removed 2026-07-06; only the
// dormant `pauses` settings field remains in core.
//
// onLocalSettingsCommit: push each popup edit straight to the App Group. The background reconciler
// also mirrors edits, but on iOS it may be asleep when the user toggles here and never wake for the
// popup's browser.storage write — so without this direct push the change reaches the app only on a
// later content-script reconcile (a Still-covered page load), not on the next app launch.
function init(): void {
  void browser.runtime.sendMessage({ kind: "reconcile" }).catch(() => {});
  const controller = createExtensionUiController(undefined, {
    accountManagedByApp: true,
    readAccountStatus,
    onLocalSettingsCommit: (record) => void pushSettingsToApp(record),
    analytics: createSafariPageAnalytics(),
    openedWhere: "popup",
  });
  mount(PopupApp, { target: document.getElementById("app")!, props: { controller } });
}

// V3 popup (U12-W4) is an explicit developer opt-in that mirrors the Apple app's D04 gate exactly:
// VITE_APPLE_ATOMIC_SETTINGS=true and no Supabase configuration. Vite inlines these values, so every
// default build (configured or not) folds this to `init()` and drops the V3 module, its components
// and their global stylesheet. Inside, the tested rule (lib/safari-v3) decides again, and the V3
// screen mounts only over the app's atomic record; anything else runs `init()` unchanged.
if (
  import.meta.env.VITE_APPLE_ATOMIC_SETTINGS === "true" &&
  !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)
)
  void import("./v3.js")
    .then(({ startSafariV3Popup }) =>
      startSafariV3Popup({
        env: {
          atomicSettingsFlag: import.meta.env.VITE_APPLE_ATOMIC_SETTINGS,
          supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
          supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        legacy: init,
      }),
      () => init(),
    );
else init();
