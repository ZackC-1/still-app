// @still/core/ui — the one shared settings/paywall UI (KTD4), host-agnostic via UiController.

export { UiController } from "./controller.svelte.js";
export {
  createExtensionUiController,
  type ExtensionPurchaseDeps,
} from "./extension-setup.js";
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
  UiAnalytics,
  UsageSharingState,
} from "./controller.svelte.js";
export {
  RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  CODE_ATTEMPTS_BEFORE_NEW_CODE,
} from "./controller.svelte.js";
export type { EmailConsent } from "./email-consent.js";
export { STRINGS } from "./strings.js";
export { PRIVACY_POLICY_URL } from "./config.js";
export {
  CHROMIUM_SURFACE_GUIDANCE,
  FIREFOX_SURFACE_GUIDANCE,
  SAFARI_SURFACE_GUIDANCE,
  type SurfaceGuidance,
} from "./surface-guidance.js";
export { default as App } from "./App.svelte";
export { default as OpenSettingsButton } from "./components/OpenSettingsButton.svelte";
export { default as Placeholder } from "./components/Placeholder.svelte";

export type { AccountStatusSnapshot } from "./account-status.js";

export type CommittedPopupBinding = ReturnType<
  typeof import("./v3/desktop-popup-binding.js").createDesktopPopupBinding
>;
export type CommittedPopupToggle = {
  readonly enabled: boolean;
  readonly service?: import("@still/shared-types").ServiceId;
};
export type { LegacyPopupAuthority } from "./v3/legacy-popup-view-binding.svelte.js";

// Apple app D04 settings host (app-webview). AppleSettings itself is never exported here: only the
// app-webview host imports it, behind a build-time-folded dynamic import, so its global stylesheet
// never reaches another host's bundle.
export { default as SignInSheet } from "./components/SignInSheet.svelte";
export { createPopupViewBinding } from "./v3/popup-view-binding.svelte.js";
export {
  selectAppleSettingsMode,
  appleSettingsCacheOptions,
  createAppleSettingsAuthority,
  appleSettingsPlatform,
  appleSettingsSetup,
  observeAppleSetup,
  watchAppleSetup,
  appleSettingsSync,
  appleSettingsRestore,
  appleSettingsHelp,
  appleSettingsToggleReporter,
  openExternalLink,
  type AppleSettingsMode,
  type AppleSettingsModeInput,
  type AppleSettingsAccountSource,
} from "./v3/apple-settings-host.js";
export type { AppleSettingsProps } from "./v3/apple-settings-presentation.js";
