import type { StoredSettingsRecord } from "@still/core/storage";
import type { FeatureId } from "@still/shared-types";
import {
  composeSafariV3,
  decideSafariV3,
  trackAddedStylesheets,
  type SafariV3Composition,
} from "../../lib/safari-v3-runtime.js";
import type { SafariV3BuildInput } from "../../lib/safari-v3.js";
import { safariAccessPlatform, safariOsAnswer } from "../../lib/access-platform.js";
import { phoneLayoutFeatures } from "@still/core/entitlement";

// The V3 settings-page gate. Like the popup's, it imports no component or stylesheet; those live in
// ./v3-mount and load only after the record gate has chosen V3.

export interface SafariV3OptionsView {
  /** `features`: the rows to draw; omitted draws every row (macOS). `phone`: Safari confirmed
   * iPhone/iPad, so the Still Pro offer speaks about this device; otherwise its general note. */
  mountSafariV3Options(target: HTMLElement, composition: SafariV3Composition, features?: readonly FeatureId[], phone?: boolean): (() => void) | void;
}

export interface SafariV3OptionsDeps {
  readonly env: SafariV3BuildInput;
  readonly probe?: () => Promise<StoredSettingsRecord | null>;
  /** Safari's own platform answer (`runtime.getPlatformInfo().os`); injectable for tests. */
  readonly platform?: () => Promise<string | undefined>;
  /** The component module; injectable so a test can make mounting fail. */
  readonly load?: () => Promise<SafariV3OptionsView>;
}

/** "v3" once the V3 settings page has mounted; otherwise "legacy" (see the popup's gate). */
export async function startSafariV3Options(deps: SafariV3OptionsDeps): Promise<"v3" | "legacy"> {
  if (!(await decideSafariV3(deps.env, deps.probe).catch(() => false))) return "legacy";
  // Loading the components adds their stylesheets to the page; every hand-over to legacy removes them.
  const dropV3Styles = trackAddedStylesheets();
  let view: SafariV3OptionsView;
  try {
    view = await (deps.load ?? (() => import("./v3-mount.js")))();
  } catch {
    dropV3Styles();
    return "legacy";
  }
  // Bounded: a missing or late answer is unknown and never delays mounting by more than a second.
  // A late "mac" answer upgrades the open page to every row (below).
  const answer = safariOsAnswer(deps.platform && (async () => ({ os: await deps.platform!() })));
  const os = await answer.bounded;
  const platform = safariAccessPlatform(os);
  const target = document.getElementById("app")!;
  let composition: SafariV3Composition;
  try {
    composition = composeSafariV3("options", platform);
  } catch {
    dropV3Styles();
    return "legacy";
  }
  let unmountView: (() => void) | void;
  try {
    // iPhone, iPad and an unknown answer never draw a Still Pro switch that cannot act in a phone
    // layout (owner decision); the saved choice is kept.
    unmountView = view.mountSafariV3Options(target, composition, platform === "desktop" ? undefined : phoneLayoutFeatures(), platform === "ios");
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
  if (platform !== "desktop")
    void answer.eventual.then((late) => {
      if (late !== "mac") return;
      // A Mac whose answer came after the bound: every row and desktop access.
      // The mounted view owns (and on unmount stops) its composition, so the upgrade starts a
      // fresh one for the desktop platform. The opening was already reported once.
      try {
        unmountView?.();
        composition.stop();
        target.replaceChildren();
        const next = composeSafariV3("options", safariAccessPlatform(late));
        composition = next;
        unmountView = view.mountSafariV3Options(target, next, undefined);
      } catch {
        // A failed upgrade leaves nothing half-running; reopening starts afresh.
        composition.stop();
        target.replaceChildren();
      }
    });
  return "v3";
}
