import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import { createExtensionUiController } from "@still/core/ui";
import PopupApp from "./PopupApp.svelte";

// Build the (purchase-free — AE7) controller, then mount the shared UI. No per-site pause control:
// it (and the activeTab grant + tab query that powered it) was removed 2026-07-06; only the
// dormant `pauses` settings field remains in core.
function init(): void {
  const controller = createExtensionUiController();
  mount(PopupApp, { target: document.getElementById("app")!, props: { controller } });
}

init();
