import { mount } from "svelte";
import type { SafariV3Composition } from "../../lib/safari-v3-runtime.js";
import type { SafariPopupSurface } from "../../lib/safari-v3.js";
import SafariV3Popup from "./SafariV3Popup.svelte";

// The V3 popup components and their global stylesheet. Loaded by ./v3 only after the record gate
// has chosen V3.
export function mountSafariV3Popup(
  target: HTMLElement,
  composition: SafariV3Composition,
  surface: SafariPopupSurface,
): void {
  mount(SafariV3Popup, {
    target,
    props: {
      composition,
      surface,
      onSettings: () => void browser.runtime.openOptionsPage(),
    },
  });
}
