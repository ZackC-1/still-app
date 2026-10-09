import type { StoredSettingsRecord } from "@still/core/storage";
import {
  composeSafariV3,
  decideSafariV3,
  trackAddedStylesheets,
  type SafariV3Composition,
} from "../../lib/safari-v3-runtime.js";
import {
  safariPopupSurface,
  type SafariPopupSurface,
  type SafariV3BuildInput,
} from "../../lib/safari-v3.js";
import { safariAccessPlatform, safariOsAnswer } from "../../lib/access-platform.js";

// The V3 popup gate. This module deliberately imports no component and no stylesheet: the V3
// components and their global CSS live in ./v3-mount, which is loaded only after the record gate
// has chosen V3, so the legacy fallback in an opted-in build never loads V3 styles.

export interface SafariV3PopupView {
  mountSafariV3Popup(
    target: HTMLElement,
    composition: SafariV3Composition,
    surface: SafariPopupSurface,
  ): (() => void) | void;
}

export interface SafariV3PopupDeps {
  readonly env: SafariV3BuildInput;
  readonly probe?: () => Promise<StoredSettingsRecord | null>;
  readonly platform?: () => Promise<string | undefined>;
  /** The component module; injectable so a test can make mounting fail. */
  readonly load?: () => Promise<SafariV3PopupView>;
}

/**
 * "v3" once the V3 popup has mounted; "legacy" when the caller must run the unchanged legacy
 * popup: the build did not opt in, the saved record is not atomic, the components could not load,
 * or mounting failed. A failed mount first stops everything the composition started and clears the
 * page, so the legacy popup starts alone. The choice is made once per opening.
 */
export async function startSafariV3Popup(deps: SafariV3PopupDeps): Promise<"v3" | "legacy"> {
  if (!(await decideSafariV3(deps.env, deps.probe).catch(() => false))) return "legacy";
  // Loading the components adds their stylesheets to the page; every hand-over to legacy removes them.
  const dropV3Styles = trackAddedStylesheets();
  let view: SafariV3PopupView;
  try {
    view = await (deps.load ?? (() => import("./v3-mount.js")))();
  } catch {
    dropV3Styles();
    return "legacy";
  }
  // Bounded: a missing or late answer is unknown (the phone popup, no desktop-layout extras). A
  // late "mac" answer upgrades the open popup to the desktop surface (below).
  const answer = safariOsAnswer(deps.platform && (async () => ({ os: await deps.platform!() })));
  const os = await answer.bounded;
  const target = document.getElementById("app")!;
  let composition: SafariV3Composition;
  try {
    composition = composeSafariV3("popup", safariAccessPlatform(os));
  } catch {
    dropV3Styles();
    return "legacy";
  }
  let unmountView: (() => void) | void;
  try {
    unmountView = view.mountSafariV3Popup(target, composition, safariPopupSurface(os));
  } catch {
    composition.stop();
    target.replaceChildren();
    dropV3Styles();
    return "legacy";
  }
  try {
    composition.opened();
  } catch {
    /* Telemetry never decides which screen shows. */
  }
  if (os !== "mac")
    void answer.eventual.then((late) => {
      if (late !== "mac") return;
      // A Mac whose answer came after the bound: the desktop surface and access.
      // The mounted view owns (and on unmount stops) its composition, so the upgrade starts a
      // fresh one for the desktop platform. The opening was already reported once.
      try {
        unmountView?.();
        composition.stop();
        target.replaceChildren();
        const next = composeSafariV3("popup", safariAccessPlatform(late));
        composition = next;
        unmountView = view.mountSafariV3Popup(target, next, safariPopupSurface(late));
      } catch {
        // A failed upgrade leaves nothing half-running; reopening starts afresh.
        composition.stop();
        target.replaceChildren();
      }
    });
  return "v3";
}
