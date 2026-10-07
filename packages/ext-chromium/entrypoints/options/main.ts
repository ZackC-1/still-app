import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import OptionsApp from "./OptionsApp.svelte";
import { bindTextScale } from "@still/core/ui/v3/text-scale";

// Text size follows the browser's font size on the V3 screens (owner decision 51). The condition
// is modernSettingsRuntime's atomicLocal rule written inline, so Vite folds it: configured 2.x
// builds contain none of this and stay byte-identical.
if (
  !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
  import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true"
)
  bindTextScale(document, "browser");
mount(OptionsApp, { target: document.getElementById("app")! });
