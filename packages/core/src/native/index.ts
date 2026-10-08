// @still/core/native — the web→native action client for the Apple WKWebView host (U19 auth/purchase).

export { NativeBridge, openNativeDestination, STILL_PRO_APP_URL, parseNativeAppleAccessCommit } from "./bridge.js";
export { createApplePurchaseAuthority, type ApplePurchaseAuthorityDeps } from "./apple-purchase-authority.js";
export type {
  AppleCredential,
  PurchaseOutcome,
  PurchaseResult,
  NativeLifetimeOffering,
  NativeProOutcome,
  NativeProResult,
  NativeApplePurchaseEvidence,
  NativeAppleAccessInstall,
  NativeAppleAccessCommit,
  NativeAppleAccessObservation,
  NativeAppleAccessRight,
  NativeAppRoute,
  NativeMessage,
  NativeOpenDestination,
  OpenNativeDestinationOptions,
  AnalyticsContextReply,
} from "./bridge.js";
