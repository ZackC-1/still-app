import type { FirstRunSiteAccess } from "@still/core/ui/v3/first-run-host";
import {
  siteAccessCard,
  type SiteAccessBrowser,
  type SiteAccessCardProps,
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

/**
 * ISS-0037: the popup and settings warning's live state. Call during a V3 component's setup. It
 * asks the browser whether Still has its four declared sites when the component mounts (each popup
 * opening), again whenever the browser reports a grant or a removal and whenever the page becomes
 * visible again (site access is changed in the browser's own settings, outside this page), and
 * stops when the component goes. `current` is undefined while access is granted or unknown.
 */
export function useSiteAccessCard(ports: () => SiteAccessCardPorts = browserPorts): {
  readonly current: SiteAccessCardProps | undefined;
} {
  let state = $state<FirstRunSiteAccess>("unknown");
  let request = $state.raw<(() => void) | undefined>(undefined);
  let name = $state<SiteAccessBrowser>("Chrome");
  $effect(() => {
    const { permissions, manifest, name: browserName, doc } = ports();
    name = browserName;
    if (!permissions) return;
    const access = observeSiteAccess(permissions, declaredSiteOrigins(manifest), (next) => {
      state = next;
    });
    request = access.request;
    const visible = (): void => {
      if (doc.visibilityState === "visible") void access.refresh();
    };
    doc.addEventListener("visibilitychange", visible);
    return () => {
      doc.removeEventListener("visibilitychange", visible);
      access.stop();
    };
  });
  const current = $derived(siteAccessCard(state, name, request));
  return {
    get current() {
      return current;
    },
  };
}
