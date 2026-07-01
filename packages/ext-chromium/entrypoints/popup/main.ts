import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import { createExtensionUiController } from "@still/core/ui";
import PopupApp from "./PopupApp.svelte";

// Resolve the active tab's host (granted by activeTab when the user opens the popup) for the
// pause-on-this-site control, build the controller, then mount the shared UI.
async function init(): Promise<void> {
  let host: string | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) host = new URL(tab.url).hostname;
  } catch {
    /* no activeTab access (e.g. chrome:// page) — pause control simply hides */
  }
  const controller = createExtensionUiController(host);
  mount(PopupApp, { target: document.getElementById("app")!, props: { controller } });
}

void init();
