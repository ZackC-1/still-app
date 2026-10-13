import type { SafariPopupSurface } from "./safari-v3.js";

// The Safari popup's hand-off to the Still app (ISS-0032). On Apple devices Still Pro is bought only
// through the App Store inside the app (App Store Review Guidelines 3.1.1 and 3.1.3), and the app
// owns the account on Safari, so Get Still Pro, every lock chip and Sign in open the app at one of
// two fixed destinations. Nothing here carries a price, a checkout link, an account or any URL from
// elsewhere: the route is a closed name and its URL is a constant.
//
//  - Mac: the app's native handler opens the app directly ({kind:"openAppRoute", route}); no prompt.
//  - iPhone and iPad: an extension cannot open its app, so the popup opens the fixed still:// link in
//    a Safari tab and Safari asks "Open in Still?". The Mac uses the same tab only if the native
//    handler could not open the app.
//
// Free blocking and Settings sync never wait on this: it is navigation only.

export type SafariAppRoute = "pro" | "sync";

/** Spelled the same as STILL_PRO_APP_URL / STILL_SYNC_APP_URL in @still/core/native (tested). */
export const SAFARI_APP_ROUTE_URLS: Readonly<Record<SafariAppRoute, string>> = Object.freeze({
  pro: "still://pro",
  sync: "still://sync",
});

export interface SafariAppHandoffPorts {
  /** browser.runtime.sendNativeMessage to the app's SafariWebExtensionHandler. */
  readonly sendNative: (message: { readonly kind: "openAppRoute"; readonly route: SafariAppRoute }) => Promise<unknown>;
  /** browser.tabs.create with the fixed link. */
  readonly openTab: (url: string) => Promise<unknown>;
  /** Dismisses the popup once the hand-off has started. */
  readonly close: () => void;
}

export type SafariAppHandoffResult = "app" | "tab" | "failed" | "busy";

function nativeOpened(reply: unknown, route: SafariAppRoute): boolean {
  if (typeof reply !== "object" || reply === null) return false;
  const answer = (reply as { openAppRoute?: unknown }).openAppRoute;
  return (
    typeof answer === "object" &&
    answer !== null &&
    (answer as { ok?: unknown }).ok === true &&
    (answer as { route?: unknown }).route === route
  );
}

/**
 * One hand-off at a time per popup: a second tap while one is starting is ignored. The surface is
 * the popup's own (desktop only when Safari answered "mac"); an unknown platform takes the tab path,
 * which works on every Apple device.
 */
export function createSafariAppHandoff(
  surface: SafariPopupSurface,
  ports: SafariAppHandoffPorts,
): (route: SafariAppRoute) => Promise<SafariAppHandoffResult> {
  let busy = false;
  const close = () => {
    try {
      ports.close();
    } catch {
      /* The hand-off already started; a popup that stays open is harmless. */
    }
  };
  return async (route) => {
    if (busy) return "busy";
    // Own keys only: a forged name such as "toString" must not reach a prototype value.
    if (route !== "pro" && route !== "sync") return "failed";
    const url = SAFARI_APP_ROUTE_URLS[route];
    busy = true;
    try {
      if (surface === "desktop") {
        const opened = await ports.sendNative({ kind: "openAppRoute", route }).then(
          (reply) => nativeOpened(reply, route),
          () => false,
        );
        if (opened) {
          close();
          return "app";
        }
      }
      try {
        await ports.openTab(url);
      } catch {
        return "failed";
      }
      close();
      return "tab";
    } finally {
      busy = false;
    }
  };
}
