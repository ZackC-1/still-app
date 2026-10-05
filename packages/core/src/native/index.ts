// @still/core/native — the web→native action client for the Apple WKWebView host (U19 auth/purchase).

export { NativeBridge, openNativeDestination } from "./bridge.js";
export type {
  AppleCredential,
  PurchaseOutcome,
  PurchaseResult,
  NativeMessage,
  NativeOpenDestination,
  OpenNativeDestinationOptions,
  AnalyticsContextReply,
} from "./bridge.js";
