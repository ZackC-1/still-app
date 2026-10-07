import { mount } from "svelte";
import type { SafariV3Composition } from "../../lib/safari-v3-runtime.js";
import type { SafariPopupSurface } from "../../lib/safari-v3.js";
import SafariV3Popup from "./SafariV3Popup.svelte";
import { bindTextScale } from "@still/core/ui/v3/text-scale";

// The V3 popup components and their global stylesheet. Loaded by ./v3 only after the record gate
// has chosen V3.
export function mountSafariV3Popup(
  target: HTMLElement,
  composition: SafariV3Composition,
  surface: SafariPopupSurface,
): void {
  // Text size follows the system Text Size on iPhone and iPad (owner decision 51); a Mac stays at
  // the normal size. Bound before mounting, and removed again if mounting fails, so the legacy
  // popup that then starts carries nothing of it.
  const unbindTextScale = bindTextScale(document, "apple", { compactPopup: true });
  try {
    mount(SafariV3Popup, {
      target,
      props: {
        composition,
        surface,
        onSettings: () => void browser.runtime.openOptionsPage(),
      },
    });
  } catch (error) {
    unbindTextScale();
    throw error;
  }
}
