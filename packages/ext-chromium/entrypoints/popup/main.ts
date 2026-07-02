import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import { createExtensionUiController } from "@still/core/ui";
import { extensionPurchaseDeps, restoreHandler } from "../../lib/purchase-wiring.js";
import PopupApp from "./PopupApp.svelte";

// Resolve the active tab's host (granted by activeTab when the user opens the popup) for the
// pause-on-this-site control, build the controller — with the purchase-spine injection when this
// build carries Supabase config (plan U6; message-closures over the background-owned session) —
// then mount the shared UI.
async function init(): Promise<void> {
  let host: string | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) host = new URL(tab.url).hostname;
  } catch {
    /* no activeTab access (e.g. chrome:// page) — pause control simply hides */
  }
  const purchase = extensionPurchaseDeps();
  const controller = createExtensionUiController(host, purchase);
  mount(PopupApp, {
    target: document.getElementById("app")!,
    props: { controller, onRestore: purchase ? restoreHandler(controller) : undefined },
  });
}

void init();
