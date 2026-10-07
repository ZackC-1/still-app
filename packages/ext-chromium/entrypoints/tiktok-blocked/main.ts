import { mount } from "svelte";
import { createTikTokBlockedHost } from "@still/core/ui/v3/tiktok-blocked-host";
import BlockedPage from "./BlockedPage.svelte";
import { bindTextScale } from "@still/core/ui/v3/text-scale";

// The extension-owned, top-level TikTok blocked page (D29). The background sends a blocked tab
// here with a one-time request id; every action goes back to the background's trusted route, which
// reads this page's actual browser sender. This page never writes settings or records analytics.
const host = createTikTokBlockedHost({
  send: (message) => chrome.runtime.sendMessage(message),
  openSettings: () => chrome.runtime.openOptionsPage(),
  navigate: (url) => window.location.replace(url),
  request: new URL(window.location.href).searchParams.get("r") ?? "",
  document: crypto.randomUUID(),
});

// Text size follows the browser's font size on the V3 screens (owner decision 51). The condition
// is modernSettingsRuntime's atomicLocal rule written inline, so Vite folds it: configured 2.x
// builds contain none of this and stay byte-identical.
if (
  !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||
  import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true"
)
  bindTextScale(document, "browser");
mount(BlockedPage, { target: document.getElementById("app")!, props: { host } });
void host.start();
