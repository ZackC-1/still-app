import { mount } from "svelte";
import type { SafariV3Composition } from "../../lib/safari-v3-runtime.js";
import type { FeatureId } from "@still/shared-types";
import SafariV3Options from "./SafariV3Options.svelte";
import { bindTextScale } from "@still/core/ui/v3/text-scale";

// The V3 settings-page components and their global stylesheet. Loaded by ./v3 only after the
// record gate has chosen V3.
export function mountSafariV3Options(target: HTMLElement, composition: SafariV3Composition, features?: readonly FeatureId[]): void {
  // Text size follows the system Text Size on iPhone and iPad (owner decision 51); a Mac stays at
  // the normal size. Removed again if mounting fails, before the legacy page starts.
  const unbindTextScale = bindTextScale(document, "apple");
  try {
    mount(SafariV3Options, {
      target,
      props: { composition, features },
    });
  } catch (error) {
    unbindTextScale();
    throw error;
  }
}
