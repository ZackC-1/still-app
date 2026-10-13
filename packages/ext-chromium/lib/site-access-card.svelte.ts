import type { FirstRunSiteAccess } from "@still/core/ui/v3/first-run-host";
import {
  siteAccessCard,
  siteAccessSiteFor,
  type SiteAccessBrowser,
  type SiteAccessCardProps,
  type SiteAccessSite,
} from "@still/core/ui/v3/site-access-presentation";
import { declaredSiteOrigins, observeSiteAccess, type SiteAccessApi } from "./site-access.js";

export interface SiteAccessCardPorts {
  readonly permissions: SiteAccessApi | undefined;
  readonly manifest: object;
  readonly name: SiteAccessBrowser;
  readonly doc: Document;
}

function browserPorts(): SiteAccessCardPorts {
  return {
    permissions: globalThis.chrome?.permissions as SiteAccessApi | undefined,
    manifest: globalThis.chrome?.runtime?.getManifest?.() ?? {},
    name: import.meta.env.FIREFOX ? "Firefox" : "Chrome",
    doc: document,
  };
}

/** How long a page waits for the browser's first access answer before deciding without it. */
export const SITE_ACCESS_SETTLE_MS = 1_500;

/**
 * ISS-0037: the popup and settings warning's live state. Call during a V3 component's setup. It
 * asks the browser whether Still has its four declared sites when the component mounts (each popup
 * opening), again whenever the browser reports a grant or a removal and whenever the page becomes
 * visible again (site access is changed in the browser's own settings, outside this page), and
 * stops when the component goes. While access is missing it also asks site by site, so the card
 * names only the sites that are missing.
 *
 * `current` is undefined while access is granted (and this page never warned) or unknown.
 * `settled` resolves once the browser has given its first answer (or could not) and, when access
 * is missing, named the missing sites, so a host can hold anything the warning should not sit
 * beside until then.
 */
export function useSiteAccessCard(ports: () => SiteAccessCardPorts = browserPorts): {
  readonly current: SiteAccessCardProps | undefined;
  readonly settled: Promise<void>;
} {
  let state = $state<FirstRunSiteAccess>("unknown");
  let request = $state.raw<(() => void) | undefined>(undefined);
  let name = $state<SiteAccessBrowser>("Chrome");
  let sites = $state.raw<readonly SiteAccessSite[] | undefined>(undefined);
  let warned = $state(false);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  $effect(() => {
    const { permissions, manifest, name: browserName, doc } = ports();
    name = browserName;
    if (!permissions) {
      settle();
      return;
    }
    const origins = declaredSiteOrigins(manifest);
    let stopped = false;
    let lookups = 0;
    // Which declared sites are missing, one question per site; a failed answer names all four.
    const lookUpMissing = async (): Promise<void> => {
      const lookup = ++lookups;
      const answers = await Promise.all(
        origins.map((origin) => permissions.contains({ origins: [origin] }).catch(() => false)),
      );
      if (stopped || lookup !== lookups) return;
      sites = origins
        .filter((_, index) => !answers[index])
        .map(siteAccessSiteFor)
        .filter((site): site is SiteAccessSite => site !== undefined);
    };
    const timer = setTimeout(settle, SITE_ACCESS_SETTLE_MS);
    const access = observeSiteAccess(permissions, origins, (next) => {
      if (next === "needed" || next === "pending" || next === "denied") warned = true;
      state = next;
      // The warning names the missing sites, so it is settled once they are known.
      if (next === "needed" || next === "denied") void lookUpMissing().then(settle);
      else settle();
    });
    request = access.request;
    const visible = (): void => {
      if (doc.visibilityState === "visible") void access.refresh();
    };
    doc.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      doc.removeEventListener("visibilitychange", visible);
      access.stop();
    };
  });
  // Drawn once the missing sites are known, so the card never changes its wording under the reader.
  const current = $derived(
    (state === "needed" || state === "denied") && sites === undefined
      ? undefined
      : siteAccessCard(state, name, request, { sites, warned }),
  );
  return {
    get current() {
      return current;
    },
    settled,
  };
}
