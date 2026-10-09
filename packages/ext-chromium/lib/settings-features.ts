import { phoneLayoutFeatures } from "@still/core/entitlement";
import type { FeatureId } from "@still/shared-types";
import { isFirefoxAndroid, type RuntimePlatform } from "./runtime-platform.js";

/**
 * The feature rows the settings page draws. Owner decision: every phone surface hides, rather
 * than disables, a Still Pro switch that cannot act there. Firefox is one build for desktop and
 * Android, so until its platform answer is "desktop" (pending, "android" or "unknown") the page
 * draws only the phone-layout rows; free rows always stay and saved choices are never touched.
 * Chromium is desktop: undefined draws every row.
 */
export function settingsFeatures(isFirefox: boolean, platform: RuntimePlatform | null): readonly FeatureId[] | undefined {
  if (!isFirefox || platform === "desktop") return undefined;
  return phoneLayoutFeatures();
}

/**
 * Whether the settings page speaks about this device as a phone in the Still Pro offer: only on a
 * confirmed Firefox for Android answer. A pending or unknown answer keeps the general note, which
 * is true on every surface, although the rows above are drawn as phone rows until desktop is known.
 */
export function settingsPhone(isFirefox: boolean, platform: RuntimePlatform | null): boolean {
  return platform !== null && isFirefoxAndroid(isFirefox, platform);
}
