import { mount } from "svelte";
import { createTikTokBlockedHost } from "@still/core/ui/v3/tiktok-blocked-host";
import { answerTiktokDocumentChallenges, TIKTOK_DOCUMENT_PORT } from "@still/core/content/tiktok-document-port";
import { bindTextScale } from "@still/core/ui/v3/text-scale";
import BlockedPage from "./BlockedPage.svelte";

const host = createTikTokBlockedHost({
  send: (message) => browser.runtime.sendMessage(message),
  openSettings: () => browser.runtime.openOptionsPage(),
  navigate: (url) => window.location.replace(url),
  request: new URL(window.location.href).searchParams.get("r") ?? "",
  document: crypto.randomUUID(),
});
let retire = () => {};
try {
  const port = browser.runtime.connect({ name: TIKTOK_DOCUMENT_PORT });
  retire = answerTiktokDocumentChallenges(port);
  port.onDisconnect.addListener(() => host.stop(true));
} catch { host.stop(true); }
bindTextScale(document, "apple");
mount(BlockedPage, { target: document.getElementById("app")!, props: {
  host,
  // Same native browser platform capability used by the maintained Safari popup.
  readPlatform: async () => (await browser.runtime.getPlatformInfo()).os,
} });
void host.start();
window.addEventListener("pagehide", () => { host.stop(); retire(); }, { once: true });
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
