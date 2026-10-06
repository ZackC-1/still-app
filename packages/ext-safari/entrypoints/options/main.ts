import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import OptionsApp from "./OptionsApp.svelte";

// V3 settings page (U12-W4, widened for U3-W4): the same build-time opt-ins as the popup (see
// popup/main.ts). Default builds fold this to the unchanged legacy mount.
if (
  (import.meta.env.VITE_APPLE_ATOMIC_SETTINGS === "true" &&
    !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)) ||
  (import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" &&
    import.meta.env.VITE_SUPABASE_URL &&
    import.meta.env.VITE_SUPABASE_ANON_KEY)
) {
  const legacy = (): void => void mount(OptionsApp, { target: document.getElementById("app")! });
  void import("./v3.js")
    .then(({ startSafariV3Options }) =>
      startSafariV3Options({
        env: {
          atomicSettingsFlag: import.meta.env.VITE_APPLE_ATOMIC_SETTINGS,
          modernSyncFlag: import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED,
          supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
          supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
      }),
    )
    // Exactly one legacy mount for every outcome that is not a mounted V3 settings page.
    .then(
      (mode) => {
        if (mode !== "v3") legacy();
      },
      () => legacy(),
    );
} else mount(OptionsApp, { target: document.getElementById("app")! });
