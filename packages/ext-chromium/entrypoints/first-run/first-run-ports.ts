import type { UiAnalytics } from "@still/core/ui";
import type { FirstRunSiteAccess } from "@still/core/ui/v3/first-run-host";
import { isFirefoxAndroid, type RuntimePlatform } from "../../lib/runtime-platform.js";

/** The existing page analytics minus event recording. The closed event schema has no first-run
 * surface, so this page records no events; the usage-sharing switch and the account attribution
 * that the existing sign-in carries keep their existing meaning. */
export function firstRunAnalytics(page: UiAnalytics): UiAnalytics {
  return { ...page, track: () => {} };
}

// Browser observations for the first-run page. Each observer reports only what the browser said:
// nothing is assumed granted, pinned or denied ahead of the browser's own answer.

type Listener = () => void;
interface BrowserEvent {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** The slice of chrome.permissions this page uses. */
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
  /** Present only where the browser can ask from this page. Must run inside the user's tap. */
  readonly request?: () => void;
  readonly refresh: () => Promise<void>;
  readonly stop: () => void;
}

/**
 * Site access for the declared hosts. "pending" covers only a request this page opened; "denied"
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

/** The slice of chrome.action this page uses (getUserSettings: Chrome 91+ and desktop Firefox 116+;
 * the change event is Chrome 130+ only, so Firefox relies on the poll below). */
export interface PinApi {
  getUserSettings?(): Promise<{ isOnToolbar?: boolean }>;
  onUserSettingsChanged?: BrowserEvent;
}

/**
 * Where the page reads the pinned report from (ISS-0031): the browser's action API on Chrome and on
 * desktop Firefox (both report `isOnToolbar`), and nowhere on Firefox for Android, which has no
 * toolbar and shows no pin step. `platform` is the browser's own answer, never the window size.
 */
export function firstRunPinApi(
  isFirefox: boolean,
  platform: RuntimePlatform,
  action: PinApi | undefined,
): PinApi | undefined {
  return isFirefoxAndroid(isFirefox, platform) ? undefined : action;
}

const PIN_POLL_MS = 2_000;

/**
 * The browser's own report of whether Still is pinned (Chrome or desktop Firefox), or null where
 * the browser does not say (no API, no `isOnToolbar` in the answer, or a failed read). Pinning
 * happens in the browser's toolbar, outside this page, so the report is re-read on Chrome's change
 * event and on a short poll while the page is visible.
 */
export function observePinned(
  api: PinApi | undefined,
  publish: (pinned: boolean | null) => void,
  doc: Document = document,
): () => void {
  const read = api?.getUserSettings?.bind(api);
  if (!read) {
    publish(null);
    return () => {};
  }
  let stopped = false;
  const refresh = (): void => {
    if (stopped || doc.visibilityState === "hidden") return;
    read().then(
      (settings) => {
        if (!stopped)
          publish(typeof settings?.isOnToolbar === "boolean" ? settings.isOnToolbar : null);
      },
      () => {
        if (!stopped) publish(null);
      },
    );
  };
  const changed = (): void => refresh();
  api?.onUserSettingsChanged?.addListener(changed);
  doc.addEventListener("visibilitychange", changed);
  const timer = setInterval(refresh, PIN_POLL_MS);
  refresh();
  return () => {
    stopped = true;
    clearInterval(timer);
    api?.onUserSettingsChanged?.removeListener(changed);
    doc.removeEventListener("visibilitychange", changed);
  };
}
