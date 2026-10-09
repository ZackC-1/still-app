import type { StoredSettingsRecord } from "@still/core/storage";
import {
  composeSafariV3,
  decideSafariV3,
  trackAddedStylesheets,
  type SafariV3Composition,
} from "../../lib/safari-v3-runtime.js";
import type { SafariV3BuildInput } from "../../lib/safari-v3.js";
import { safariAccessPlatform } from "../../lib/access-platform.js";

// The V3 settings-page gate. Like the popup's, it imports no component or stylesheet; those live in
// ./v3-mount and load only after the record gate has chosen V3.

export interface SafariV3OptionsView {
  mountSafariV3Options(target: HTMLElement, composition: SafariV3Composition): void;
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
  const os = await (deps.platform ?? (async () => (await browser.runtime.getPlatformInfo()).os))()
    .catch(() => undefined);
  const target = document.getElementById("app")!;
  let composition: SafariV3Composition;
  try {
    composition = composeSafariV3("options", safariAccessPlatform(os));
  } catch {
    dropV3Styles();
    return "legacy";
  }
  try {
    view.mountSafariV3Options(target, composition);
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
  return "v3";
}
