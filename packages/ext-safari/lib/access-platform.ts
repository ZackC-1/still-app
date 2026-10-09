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

/** Safari's `os` answer twice over: `bounded` settles within the limit (undefined when missing,
 * failed or late), `eventual` is the answer itself whenever it comes (undefined on a failure; it
 * may never settle). Neither rejects. A page mounts with `bounded` and upgrades on a late "mac". */
export interface SafariOsAnswer {
  readonly bounded: Promise<string | undefined>;
  readonly eventual: Promise<string | undefined>;
}

export function safariOsAnswer(
  read: () => Promise<{ os?: string } | undefined> = () => browser.runtime.getPlatformInfo(),
  limitMs: number = SAFARI_PLATFORM_LIMIT_MS,
): SafariOsAnswer {
  const eventual = Promise.resolve()
    .then(read)
    .then((info) => (typeof info?.os === "string" ? info.os : undefined), () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = Promise.race([
    eventual,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), limitMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return { bounded, eventual };
}

/** The bounded answer alone (see safariOsAnswer). Never rejects. */
export function boundedSafariOs(
  read?: () => Promise<{ os?: string } | undefined>,
  limitMs?: number,
): Promise<string | undefined> {
  return safariOsAnswer(read, limitMs).bounded;
}

/** The bounded access platform for a Safari page or background. Never rejects. */
export function safariPlatformAnswer(
  read?: () => Promise<{ os?: string } | undefined>,
  limitMs?: number,
): Promise<AccessPlatform> {
  return boundedSafariOs(read, limitMs).then(safariAccessPlatform);
}
