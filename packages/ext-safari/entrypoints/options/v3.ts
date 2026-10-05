import { mount } from "svelte";
import type { StoredSettingsRecord } from "@still/core/storage";
import { composeSafariV3 } from "../../lib/safari-v3-runtime.js";
import type { SafariV3BuildInput } from "../../lib/safari-v3.js";
import SafariV3Options from "./SafariV3Options.svelte";

export interface SafariV3OptionsDeps {
  readonly env: SafariV3BuildInput;
  /** The legacy settings page, exactly as default builds mount it. */
  readonly legacy: () => void;
  readonly probe?: () => Promise<StoredSettingsRecord | null>;
}

/** V3 settings page over the app's atomic record; otherwise the legacy page unchanged. */
export async function startSafariV3Options(deps: SafariV3OptionsDeps): Promise<"v3" | "legacy"> {
  // A composition failure is never a blank page: it is the legacy screen.
  const composition = await composeSafariV3("options", deps.env, deps.probe).catch(() => null);
  if (!composition) {
    deps.legacy();
    return "legacy";
  }
  mount(SafariV3Options, {
    target: document.getElementById("app")!,
    props: {
      controller: composition.controller,
      binding: composition.binding,
      onCommittedToggle: composition.report,
    },
  });
  return "v3";
}
