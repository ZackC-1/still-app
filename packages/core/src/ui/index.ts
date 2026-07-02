// @still/core/ui — the one shared settings/paywall UI (KTD4), host-agnostic via UiController.

export { UiController } from "./controller.svelte.js";
export { createExtensionUiController, type ExtensionPurchaseDeps } from "./extension-setup.js";
export type {
  UiHost,
  UiAuth,
  UiControllerDeps,
  PopupState,
  AuthFlow,
  DeleteFlow,
  CodeErrorKind,
  PendingOtp,
  AuthPersistence,
  UiCheckout,
  CheckoutPending,
  CheckoutFlow,
  CheckoutReconcileOutcome,
} from "./controller.svelte.js";
export { RESEND_COOLDOWN_MS, OTP_TTL_MS, CODE_ATTEMPTS_BEFORE_NEW_CODE } from "./controller.svelte.js";
export { STRINGS } from "./strings.js";
export { PRIVACY_POLICY_URL } from "./config.js";
export { default as App } from "./App.svelte";
export { default as Placeholder } from "./components/Placeholder.svelte";
