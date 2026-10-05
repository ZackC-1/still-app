import { mount } from "svelte";
import type { StoredSettingsRecord } from "@still/core/storage";
import { composeSafariV3 } from "../../lib/safari-v3-runtime.js";
import { safariPopupSurface, type SafariV3BuildInput } from "../../lib/safari-v3.js";
import SafariV3Popup from "./SafariV3Popup.svelte";

export interface SafariV3PopupDeps {
  readonly env: SafariV3BuildInput;
  /** The legacy popup, exactly as default builds start it. */
  readonly legacy: () => void;
  readonly probe?: () => Promise<StoredSettingsRecord | null>;
  readonly platform?: () => Promise<string | undefined>;
}

/**
 * Start the V3 popup when the build opted in and the saved record is atomic; otherwise run the
 * legacy popup unchanged. The choice is made once per opening and never flips while open.
 */
export async function startSafariV3Popup(deps: SafariV3PopupDeps): Promise<"v3" | "legacy"> {
  // A composition failure is never a blank page: it is the legacy screen.
  const composition = await composeSafariV3("popup", deps.env, deps.probe).catch(() => null);
  if (!composition) {
    deps.legacy();
    return "legacy";
  }
  const os = await (deps.platform ?? (async () => (await browser.runtime.getPlatformInfo()).os))()
    .catch(() => undefined);
  mount(SafariV3Popup, {
    target: document.getElementById("app")!,
    props: {
      controller: composition.controller,
      binding: composition.binding,
      surface: safariPopupSurface(os),
      onSettings: () => void browser.runtime.openOptionsPage(),
      onCommittedToggle: composition.report,
    },
  });
  return "v3";
}
