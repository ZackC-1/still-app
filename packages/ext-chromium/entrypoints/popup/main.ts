import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import { createExtensionUiController } from "@still/core/ui";
import { extensionPurchaseDeps, restoreHandler } from "../../lib/purchase-wiring.js";
import PopupApp from "./PopupApp.svelte";

// Build the controller — with the purchase-spine injection when this build carries Supabase config
// (plan U6; message-closures over the background-owned session) — then mount the shared UI. No
// currentHost: the pause-on-this-site control (and the activeTab grant + tab query that powered
// it) was removed 2026-07-06; the pause logic stays dormant in core.
function init(): void {
  const purchase = extensionPurchaseDeps();
  const controller = createExtensionUiController(undefined, purchase);
  mount(PopupApp, {
    target: document.getElementById("app")!,
    props: { controller, onRestore: purchase ? restoreHandler(controller) : undefined },
  });
}

init();
