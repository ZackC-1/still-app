import type { ServiceId } from "@still/shared-types";
import type { FirstRunProps } from "./first-run-presentation.js";

// Host mapping for D14, the Chrome/Firefox first-run page. The browser entrypoint observes the real
// host (site access, pinning, saved choices, account) and this module turns those observations into
// FirstRun's props. It holds no state and touches no browser API, so the background can import the
// install rule below without pulling in any UI.

/** The extension page that hosts FirstRun (WXT builds entrypoints/first-run/ to this path). */
export const FIRST_RUN_PAGE = "/first-run.html";

/** Only a brand-new install opens the first-run page. Updates, browser updates and shared-module
 * updates never do; the page stays reachable from Settings → Setup guide. */
export function shouldOpenFirstRun(details: { readonly reason: string }): boolean {
  return details.reason === "install";
}

export type FirstRunBrowser = FirstRunProps["browser"];

// Approved copy, verbatim from the D14 design reference (FirstRun.babel, approved 2026-10-03;
// Firefox wording confirmed by the owner 2026-10-05). The permission step's line is the owner's
// canvas comment of 23 Oct 2026, the same for both browsers.
export function firstRunPermissionGuidance(_browser: FirstRunBrowser): string {
  return "Still only runs on these websites: Instagram, Facebook, YouTube and TikTok.";
}
export const FIRST_RUN_SETUP_DESCRIPTION =
  "Allow Still on the sites it works on, and it starts right away.";
export const FIRST_RUN_PIN_GUIDANCE: Record<FirstRunBrowser, string> = {
  chrome: "Click the puzzle piece in the toolbar, then the pin next to Still.",
  firefox:
    "Click the puzzle piece in the toolbar, then the gear next to Still, then Pin to toolbar.",
};
/** Where the browser did not say whether Still is pinned (a failed or missing report), the step
 * must read true either way (ISS-0031): it never tells someone to pin what is already pinned. */
export const FIRST_RUN_PIN_GUIDANCE_UNKNOWN: Record<FirstRunBrowser, string> = {
  chrome: "If Still isn’t in your toolbar, click the puzzle piece, then the pin next to Still.",
  firefox:
    "If Still isn’t in your toolbar, click the puzzle piece, then the gear next to Still, then Pin to toolbar.",
};

/** What the browser says about Still's access to its four declared sites. "unknown" until the
 * browser has answered; "pending" only while a request this page made is open; "denied" only when
 * that request came back without the grant. */
export type FirstRunSiteAccess = "unknown" | "granted" | "needed" | "pending" | "denied";

export interface FirstRunHostObservations {
  readonly browser: FirstRunBrowser;
  readonly siteAccess: FirstRunSiteAccess;
  /** Present only when this browser can ask for the declared host permissions from the page. */
  readonly requestSiteAccess?: () => void;
  /** The saved choices, or null while they are unread or unreadable. Never defaults. */
  readonly choices: {
    readonly globalOn: boolean;
    readonly services: Readonly<Record<ServiceId, boolean>>;
  } | null;
  /** The browser's own pinned report (`action.getUserSettings().isOnToolbar`: Chrome 91+, desktop
   * Firefox 116+), or null where the browser did not say. */
  readonly pinned: boolean | null;
  /** False only where the browser itself reports a platform with no toolbar to pin Still to
   * (Firefox for Android). The pin step is then left out, not reworded. Absent means true. */
  readonly toolbar?: boolean;
  /** The account the background session reports, or null when signed out or unknown. */
  readonly account: { readonly userId: string; readonly email: string | null } | null;
  /** The existing optional sign-in, when this build has one and nobody is signed in. */
  readonly onSignIn?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onOpenPrivacy?: () => void;
}

/** FirstRun's props without consent: there is no combined email-and-usage producer yet, so the
 * host passes its existing usage-sharing control through `privacyActions` instead. */
export type FirstRunHostProps = Omit<FirstRunProps, "consent" | "privacyActions">;

export function firstRunHostProps(host: FirstRunHostObservations): FirstRunHostProps {
  const { browser, siteAccess, choices } = host;
  const verified = siteAccess !== "unknown";
  const blockingOn =
    choices !== null &&
    choices.globalOn &&
    Object.values(choices.services).some((on) => on === true);
  const address = host.account?.email?.trim() ?? "";
  const signedIn = host.account !== null && address !== "";
  return {
    browser,
    permission: {
      state: siteAccess,
      verified,
      requestVerified: verified && typeof host.requestSiteAccess === "function",
      onRequest: host.requestSiteAccess,
      guidance: { verified: true, text: firstRunPermissionGuidance(browser) },
    },
    blocking:
      choices === null
        ? { state: "unknown", verified: false }
        : { state: blockingOn ? "on" : "off", verified: true },
    // The lede asks for site access, so it only shows while access is actually missing.
    setupDescription:
      verified && siteAccess !== "granted"
        ? { verified: true, text: FIRST_RUN_SETUP_DESCRIPTION }
        : undefined,
    ...(host.toolbar === false
      ? {}
      : {
          pin: {
            pinned: host.pinned === true,
            verified: host.pinned !== null,
            guidance: {
              verified: true,
              text: (host.pinned === null ? FIRST_RUN_PIN_GUIDANCE_UNKNOWN : FIRST_RUN_PIN_GUIDANCE)[browser],
            },
          },
        }),
    sync: signedIn
      ? { account: { address, confirmed: true } }
      : { onSignIn: host.account === null ? host.onSignIn : undefined },
    settings: { verified: Boolean(host.onOpenSettings), onOpen: host.onOpenSettings },
    privacy: { verified: Boolean(host.onOpenPrivacy), onOpen: host.onOpenPrivacy },
  };
}
