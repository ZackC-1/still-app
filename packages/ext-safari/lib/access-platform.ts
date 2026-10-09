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

/** How long a page waits for Safari's platform answer before carrying on as unknown. */
export const SAFARI_PLATFORM_LIMIT_MS = 1_000;

/**
 * Safari's `os` answer within a bound: undefined when the call is missing, fails or is late, so a
 * page never waits on it before mounting. Never rejects.
 */
export function boundedSafariOs(
  read: () => Promise<{ os?: string } | undefined> = () => browser.runtime.getPlatformInfo(),
  limitMs: number = SAFARI_PLATFORM_LIMIT_MS,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = Promise.resolve()
    .then(read)
    .then((info) => (typeof info?.os === "string" ? info.os : undefined), () => undefined);
  return Promise.race([
    answer,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), limitMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The bounded access platform for a Safari page or background. Never rejects. */
export function safariPlatformAnswer(
  read?: () => Promise<{ os?: string } | undefined>,
  limitMs?: number,
): Promise<AccessPlatform> {
  return boundedSafariOs(read, limitMs).then(safariAccessPlatform);
}
