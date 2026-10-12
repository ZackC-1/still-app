import type { FirstRunSiteAccess } from "@still/core/ui/v3/first-run-host";

// Still's access to its four declared sites, as the browser reports it. Shared by the first-run
// page's "Allow Still on supported sites" step and the popup and settings warning (ISS-0037), so
// all three ask the same question and request the same thing. The observer reports only what the
// browser said: nothing is assumed granted or denied ahead of the browser's own answer.

type Listener = () => void;
export interface BrowserEvent {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** The slice of chrome.permissions these pages use. */
export interface SiteAccessApi {
  contains(request: { origins: string[] }): Promise<boolean>;
  request?(request: { origins: string[] }): Promise<boolean>;
  onAdded?: BrowserEvent;
  onRemoved?: BrowserEvent;
}

/** Only the four host permissions already declared in the manifest; never anything else. */
export function declaredSiteOrigins(manifest: object): string[] {
  const hosts = (manifest as { host_permissions?: unknown }).host_permissions;
  return Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === "string") : [];
}

export interface SiteAccessObserver {
  /** Present only where the browser can ask from the page. Must run inside the user's tap. */
  readonly request?: () => void;
  readonly refresh: () => Promise<void>;
  readonly stop: () => void;
}

/**
 * Site access for the declared hosts. "pending" covers only a request the page opened; "denied"
 * only a request the browser answered without the grant. A failed request is not a denial: the
 * browser is asked again and its answer stands.
 */
export function observeSiteAccess(
  api: SiteAccessApi,
  origins: readonly string[],
  publish: (state: FirstRunSiteAccess) => void,
): SiteAccessObserver {
  let state: FirstRunSiteAccess = "unknown";
  let requestOpen = false;
  let declined = false;
  let stopped = false;
  let reads = 0;
  const set = (next: FirstRunSiteAccess): void => {
    if (stopped) return;
    state = next;
    publish(next);
  };
  const refresh = async (): Promise<void> => {
    if (stopped || requestOpen) return;
    if (origins.length === 0) return set("unknown");
    const read = ++reads;
    let granted: boolean;
    try {
      granted = await api.contains({ origins: [...origins] });
    } catch {
      if (read === reads && !requestOpen) set("unknown");
      return;
    }
    if (read !== reads || requestOpen) return;
    if (granted) declined = false;
    set(granted ? "granted" : declined ? "denied" : "needed");
  };
  const request = (): void => {
    if (stopped || requestOpen || (state !== "needed" && state !== "denied")) return;
    requestOpen = true;
    reads++;
    let answer: Promise<boolean>;
    try {
      // No await before this call: the browser only shows its prompt inside the user's tap.
      answer = api.request!({ origins: [...origins] });
    } catch (error) {
      answer = Promise.reject(error);
    }
    set("pending");
    void answer
      .then(
        (granted) => {
          declined = !granted;
        },
        () => {
          /* not an answer from the person; the browser's current grant decides below */
        },
      )
      .finally(() => {
        requestOpen = false;
        void refresh();
      });
  };
  const changed = (): void => void refresh();
  api.onAdded?.addListener(changed);
  api.onRemoved?.addListener(changed);
  void refresh();
  return {
    request: typeof api.request === "function" ? request : undefined,
    refresh,
    stop() {
      stopped = true;
      api.onAdded?.removeListener(changed);
      api.onRemoved?.removeListener(changed);
    },
  };
}
