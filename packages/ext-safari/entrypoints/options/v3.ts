import type { StoredSettingsRecord } from "@still/core/storage";
import {
  composeSafariV3,
  decideSafariV3,
  type SafariV3Composition,
} from "../../lib/safari-v3-runtime.js";
import type { SafariV3BuildInput } from "../../lib/safari-v3.js";

// The V3 settings-page gate. Like the popup's, it imports no component or stylesheet; those live in
// ./v3-mount and load only after the record gate has chosen V3.

export interface SafariV3OptionsView {
  mountSafariV3Options(target: HTMLElement, composition: SafariV3Composition): void;
}

export interface SafariV3OptionsDeps {
  readonly env: SafariV3BuildInput;
  readonly probe?: () => Promise<StoredSettingsRecord | null>;
  /** The component module; injectable so a test can make mounting fail. */
  readonly load?: () => Promise<SafariV3OptionsView>;
}

/** "v3" once the V3 settings page has mounted; otherwise "legacy" (see the popup's gate). */
export async function startSafariV3Options(deps: SafariV3OptionsDeps): Promise<"v3" | "legacy"> {
  if (!(await decideSafariV3(deps.env, deps.probe).catch(() => false))) return "legacy";
  let view: SafariV3OptionsView;
  try {
    view = await (deps.load ?? (() => import("./v3-mount.js")))();
  } catch {
    return "legacy";
  }
  const target = document.getElementById("app")!;
  let composition: SafariV3Composition;
  try {
    composition = composeSafariV3("options");
  } catch {
    return "legacy";
  }
  try {
    view.mountSafariV3Options(target, composition);
  } catch {
    composition.stop();
    target.replaceChildren();
    return "legacy";
  }
  try {
    composition.opened();
  } catch {
    /* Telemetry never decides which screen shows. */
  }
  return "v3";
}
