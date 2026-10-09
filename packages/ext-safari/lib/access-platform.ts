import type { AccessPlatform } from "@still/core/entitlement";

/**
 * Safari's access platform from its own `runtime.getPlatformInfo().os`, never the user agent, the
 * page layout or a screen size. "mac" is macOS Safari, which loads the sites' desktop layouts;
 * "ios" is iPhone and iPad Safari. Anything else is unknown, which never claims a desktop-layout
 * control. The native app makes the same split at compile time (StillKit SafariAccessPlatform),
 * and while paid is on its snapshot is the authority.
 */
export function safariAccessPlatform(os: string | undefined): AccessPlatform {
  return os === "mac" ? "desktop" : os === "ios" ? "ios" : "unknown";
}
