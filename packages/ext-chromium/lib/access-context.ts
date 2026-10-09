import { packagedAccessContext, type TrustedAccessContext } from "@still/core/entitlement";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import type { RuntimePlatform } from "./runtime-platform.js";

/**
 * The background's packaged Still Pro access context for this build's host AND the device's
 * platform (accessPlatformReader). It is Firefox for Android's only gate against the
 * desktop-layout-only extras: content entries pass just their host, so this answer is what keeps
 * end-of-video suggestions, live chat and desktop sidebar ads from resolving on a phone. While paid
 * is off the platform is never asked for (the context is the free features everywhere).
 */
export async function hostAccessContext(
  host: "chromium" | "firefox",
  readPlatform: () => Promise<RuntimePlatform>,
): Promise<TrustedAccessContext> {
  const devicePlatform = PAID_TIER_ENABLED ? await readPlatform() : undefined;
  return packagedAccessContext(host, devicePlatform);
}
