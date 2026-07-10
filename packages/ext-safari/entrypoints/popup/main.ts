import { mount } from "svelte";
import "@still/core/ui/tokens.css";
import { createExtensionUiController } from "@still/core/ui";
import { pushSettingsToApp } from "../../lib/native-settings.js";
import PopupApp from "./PopupApp.svelte";

// Build the (purchase-free — AE7) controller, then mount the shared UI. No per-site pause control:
// it (and the activeTab grant + tab query that powered it) was removed 2026-07-06; only the
// dormant `pauses` settings field remains in core.
//
// onLocalSettingsCommit: push each popup edit straight to the App Group. The background reconciler
// also mirrors edits, but on iOS it may be asleep when the user toggles here and never wake for the
// popup's browser.storage write — so without this direct push the change reaches the app only on a
// later content-script reconcile (a Still-covered page load), not on the next app launch.
function init(): void {
  void browser.runtime.sendMessage({ kind: "reconcile" }).catch(() => {});
  const controller = createExtensionUiController(undefined, {
    onLocalSettingsCommit: (record) => void pushSettingsToApp(record),
  });
  mount(PopupApp, { target: document.getElementById("app")!, props: { controller } });
}

init();
