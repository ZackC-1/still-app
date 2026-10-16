import { mount } from "svelte";
import { createTikTokBlockedHost } from "@still/core/ui/v3/tiktok-blocked-host";
import { TIKTOK_DOCUMENT_PORT } from "@still/core/content/tiktok-document-port";
import { bindTextScale } from "@still/core/ui/v3/text-scale";
import { createTiktokDocumentLink } from "../../lib/tiktok-document-link.js";
import BlockedPage from "./BlockedPage.svelte";

// Safari drops this page's document port whenever it unloads an idle background, so the link
// reconnects before each request rather than ending the page (see lib/tiktok-document-link.ts).
const link = createTiktokDocumentLink({ connect: () => browser.runtime.connect({ name: TIKTOK_DOCUMENT_PORT }) });
const host = createTikTokBlockedHost({
  send: (message) => browser.runtime.sendMessage(message),
  openSettings: () => browser.runtime.openOptionsPage(),
  navigate: (url) => window.location.replace(url),
  request: new URL(window.location.href).searchParams.get("r") ?? "",
  document: crypto.randomUUID(),
  prepare: () => link.ensure(),
  // Safari for Mac gives this page a new tab id when it swaps it in; the background may still be
  // moving the tab's record when the first answer is asked for.
  startRetryDelaysMs: [250, 750, 1_500],
});
bindTextScale(document, "apple");
mount(BlockedPage, { target: document.getElementById("app")!, props: {
  host,
  // Same native browser platform capability used by the maintained Safari popup.
  readPlatform: async () => (await browser.runtime.getPlatformInfo()).os,
} });
void host.start();
window.addEventListener("pagehide", () => { host.stop(); link.retire(); }, { once: true });
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
