import { mount, unmount } from "svelte";
import type { SafariV3Composition } from "../../lib/safari-v3-runtime.js";
import type { SafariPopupSurface } from "../../lib/safari-v3.js";
import SafariV3Popup from "./SafariV3Popup.svelte";
import { bindTextScale } from "@still/core/ui/v3/text-scale";
import { createSafariAppHandoff, type SafariAppRoute } from "../../lib/app-handoff.js";
import { NATIVE_APP } from "../../lib/native-settings.js";

// The V3 popup components and their global stylesheet. Loaded by ./v3 only after the record gate
// has chosen V3.
export function mountSafariV3Popup(
  target: HTMLElement,
  composition: SafariV3Composition,
  surface: SafariPopupSurface,
): () => void {
  // Text size follows the system Text Size on iPhone and iPad (owner decision 51); a Mac stays at
  // the normal size. Bound before mounting, and removed again if mounting fails, so the legacy
  // popup that then starts carries nothing of it.
  const unbindTextScale = bindTextScale(document, "apple", { compactPopup: true });
  // Get Still Pro, lock chips and Sign in open the Still app (lib/app-handoff): directly on the
  // Mac through the native handler, through a Safari tab on iPhone and iPad.
  const handoff = createSafariAppHandoff(surface, {
    sendNative: (message) => browser.runtime.sendNativeMessage(NATIVE_APP, message),
    openTab: (url) => browser.tabs.create({ url }),
    close: () => window.close(),
  });
  try {
    const instance = mount(SafariV3Popup, {
      target,
      props: {
        composition,
        surface,
        onSettings: () => void browser.runtime.openOptionsPage(),
        openApp: (route: SafariAppRoute) => handoff(route),
      },
    });
    return () => {
      void unmount(instance);
      unbindTextScale();
    };
  } catch (error) {
    unbindTextScale();
    throw error;
  }
}
