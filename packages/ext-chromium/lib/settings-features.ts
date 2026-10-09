import { phoneLayoutFeatures } from "@still/core/entitlement";
import type { FeatureId } from "@still/shared-types";
import type { RuntimePlatform } from "./runtime-platform.js";

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
