// @still/core/ui — the one shared settings/paywall UI (KTD4), host-agnostic via UiController.

export { UiController } from "./controller.svelte.js";
export { createExtensionUiController } from "./extension-setup.js";
export type { UiHost, UiAuth, UiControllerDeps, PopupState, AuthFlow, DeleteFlow } from "./controller.svelte.js";
export { STRINGS } from "./strings.js";
export { PRIVACY_POLICY_URL } from "./config.js";
export { default as App } from "./App.svelte";
export { default as Placeholder } from "./components/Placeholder.svelte";
