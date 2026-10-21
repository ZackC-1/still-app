import type { FirstRunSiteAccess } from "./first-run-host.js";

// ISS-0037: the popup and settings warning shown while Still cannot run on its sites (Chrome's
// "When you click the extension" site access, a site removed in Chrome or Firefox, or a request the
// person declined). It is the first-run page's "Allow Still on supported sites" step brought to the
// popup and the settings page: the same browser answer, the same request for the same four declared
// hosts, and the first-run page's own pending, declined and allowed wording.

/** What the card shows. "allowed" follows a warning this page showed: access came back. */
export type SiteAccessCardState = "needed" | "pending" | "denied" | "allowed";

export type SiteAccessBrowser = "Chrome" | "Firefox";

/** The four sites in the owner's order. Never "everywhere". */
export const SITE_ACCESS_SITES = ["Instagram", "Facebook", "YouTube", "TikTok"] as const;
export type SiteAccessSite = (typeof SITE_ACCESS_SITES)[number];

export interface SiteAccessCardProps {
  state: SiteAccessCardState;
  browser: SiteAccessBrowser;
  /** The sites Still cannot run on, when the browser said which; absent means all four. */
  sites?: readonly SiteAccessSite[];
  /** Asks the browser for the four declared sites. Absent where the browser cannot ask from here.
   * Called directly from the click: the browser shows its prompt only inside the person's tap. */
  onAllow?: () => void;
}

export const SITE_ACCESS_COPY = {
  allow: "Allow",
  retry: "Try again",
  /** The first-run page's declined detail. */
  declinedDetail: "Your choices are saved and start working once it's allowed.",
  /** The first-run page's done state (owner, 12 Oct). The request asks for all four sites. */
  allowed: "Allowed on Instagram, Facebook, YouTube, and TikTok.",
  /** Pages already open keep running without Still until they reload. */
  reload: "Reload open tabs to apply.",
} as const;

/** The site a declared host pattern names, if any (`*://*.youtube.com/*` is YouTube). */
export function siteAccessSiteFor(origin: string): SiteAccessSite | undefined {
  return SITE_ACCESS_SITES.find((site) => origin.toLowerCase().includes(`.${site.toLowerCase()}.com`));
}

/** The named sites in the owner's order, as a sentence list ("Facebook and YouTube"). */
function siteList(sites: readonly SiteAccessSite[]): string {
  const ordered = SITE_ACCESS_SITES.filter((site) => sites.includes(site));
  if (ordered.length <= 2) return ordered.join(" and ");
  return `${ordered.slice(0, -1).join(", ")}, and ${ordered.at(-1)}`;
}

function missingSites(sites: readonly SiteAccessSite[] | undefined): readonly SiteAccessSite[] {
  const named = SITE_ACCESS_SITES.filter((site) => sites?.includes(site));
  return named.length > 0 ? named : SITE_ACCESS_SITES;
}

/** One heading for one missing site or several (owner's canvas review, 21 Oct 2026). */
export function siteAccessTitle(_sites?: readonly SiteAccessSite[]): string {
  return "Still can't block distractions yet.";
}

export function siteAccessBody(sites?: readonly SiteAccessSite[]): string {
  return `Still needs permission to work on ${siteList(missingSites(sites))}.`;
}

/** The first-run page's wording while the browser's prompt is open. */
export function siteAccessPendingText(name: SiteAccessBrowser): string {
  return `Waiting for ${name}…`;
}

/** The first-run page's wording after the browser answered without the grant. */
export function siteAccessDeclinedText(name: SiteAccessBrowser): string {
  return `${name} didn't allow it.`;
}

/**
 * The card for the browser's current answer, or undefined when there is nothing to show: access
 * is granted and this page never warned, or the browser has not answered (never assumed missing
 * ahead of its answer). Access coming back after this page warned shows "allowed".
 */
export function siteAccessCard(
  state: FirstRunSiteAccess,
  name: SiteAccessBrowser,
  onAllow: (() => void) | undefined,
  context: { readonly sites?: readonly SiteAccessSite[]; readonly warned?: boolean } = {},
): SiteAccessCardProps | undefined {
  if (state === "unknown") return undefined;
  if (state === "granted") return context.warned ? { state: "allowed", browser: name } : undefined;
  return { state, browser: name, sites: context.sites, onAllow };
}
