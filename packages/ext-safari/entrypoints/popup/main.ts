import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import { createExtensionUiController } from "@still/core/ui";
import PopupApp from "./PopupApp.svelte";

// Build the (purchase-free — AE7) controller, then mount the shared UI. No currentHost: the
// pause-on-this-site control (and the activeTab grant + tab query that powered it) was removed
// 2026-07-06; the pause logic stays dormant in core.
function init(): void {
  const controller = createExtensionUiController();
  mount(PopupApp, { target: document.getElementById("app")!, props: { controller } });
}

init();
