import type { FirstRunSiteAccess } from "./first-run-host.js";

// ISS-0037: the popup and settings warning shown while Still cannot run on its four sites (Chrome's
// "When you click the extension" site access, a site removed in Chrome or Firefox, or a request the
// person declined). It is the first-run page's "Allow Still on supported sites" step brought to the
// popup and the settings page: the same browser answer, the same request for the same four declared
// hosts, and the first-run page's own pending and declined wording.

/** The browser states that show the warning. "unknown" and "granted" show nothing. */
export type SiteAccessWarningState = Extract<FirstRunSiteAccess, "needed" | "pending" | "denied">;

export type SiteAccessBrowser = "Chrome" | "Firefox";

export interface SiteAccessCardProps {
  state: SiteAccessWarningState;
  browser: SiteAccessBrowser;
  /** Asks the browser for the four declared sites. Absent where the browser cannot ask from here.
   * Called directly from the click: the browser shows its prompt only inside the person's tap. */
  onAllow?: () => void;
}

// Sites in the owner's order (Instagram, Facebook, YouTube, TikTok); never "everywhere".
export const SITE_ACCESS_COPY = {
  title: "Still can't work on these sites yet",
  body: "Still needs permission to work on Instagram, Facebook, YouTube, and TikTok.",
  allow: "Allow",
  retry: "Try again",
  /** The first-run page's declined detail. */
  declinedDetail: "Your choices are saved and start working once it's allowed.",
} as const;

/** The first-run page's wording while the browser's prompt is open. */
export function siteAccessPendingText(name: SiteAccessBrowser): string {
  return `Waiting for ${name}…`;
}

/** The first-run page's wording after the browser answered without the grant. */
export function siteAccessDeclinedText(name: SiteAccessBrowser): string {
  return `${name} didn't allow it.`;
}

/**
 * The warning for the browser's current answer, or undefined when there is nothing to warn about:
 * access is granted, or the browser has not answered (never assumed missing ahead of its answer).
 */
export function siteAccessCard(
  state: FirstRunSiteAccess,
  name: SiteAccessBrowser,
  onAllow: (() => void) | undefined,
): SiteAccessCardProps | undefined {
  if (state === "unknown" || state === "granted") return undefined;
  return { state, browser: name, onAllow };
}
