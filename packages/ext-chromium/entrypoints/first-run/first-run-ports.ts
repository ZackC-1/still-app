import type { UiAnalytics } from "@still/core/ui";
import type { BrowserEvent } from "../../lib/site-access.js";
import { isFirefoxAndroid, type RuntimePlatform } from "../../lib/runtime-platform.js";

/** The existing page analytics minus event recording. The closed event schema has no first-run
 * surface, so this page records no events; the usage-sharing switch and the account attribution
 * that the existing sign-in carries keep their existing meaning. */
export function firstRunAnalytics(page: UiAnalytics): UiAnalytics {
  return { ...page, track: () => {} };
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
