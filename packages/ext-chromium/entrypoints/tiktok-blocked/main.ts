import { mount } from "svelte";
import { createTikTokBlockedHost } from "../../../core/src/ui/v3/tiktok-blocked-host.js";
import BlockedPage from "./BlockedPage.svelte";

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

mount(BlockedPage, { target: document.getElementById("app")!, props: { host } });
void host.start();
